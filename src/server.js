// Minimal HTTP API (Node built-in http, no framework).
//   POST /api/preregister        { project, minter, recipient, signature? }
//   POST /api/preregister/claim  { project, minter, recipient, signature }
//   GET  /api/payouts?project=&recipient=   real payout records only
//   GET  /api/status            service + per-project status (pool, runway)
//   GET  /api/config            public terms per project
//   GET  /api/quote?project=    live payout price + pool + guard preview
//   GET  /                      the frontend page (public/index.html)
//
// Registration model (deliberately boring and honest):
// - Anyone may register any minter address, like the original service.
// - A registration WITH a valid minter signature is "verified" and locked:
//   it can only be overwritten by a new registration signed by the same minter.
// - An UNVERIFIED registration can be claimed/overwritten by a verified one.
//   This replaces the original's "pay dust BNB to unlock" trick with a free
//   cryptographic proof: sign a message with the minter wallet (personal_sign).
// - No registration, no payout. Expired registrations never pay.
// - Registrations and payouts are scoped per project.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { cfg, projects, getProject } = require('./config');
const { db, nowMs, projectState } = require('./db');
const { hotWalletAddress, hotWalletUsdtBalance, priceFor, economicsCheck, sendPayout } = require('./payout');
const { getChainState, poolRunwayHours, flushQueue, paidTodayUsdt } = require('./listener');
const { resolveAgentId } = require('./chain');

function registerMessage(minter, recipient) {
  return `Register auto-payout: minter ${minter.toLowerCase()} pays out to ${recipient.toLowerCase()} (BSC USDT).`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function isAddress(v) {
  return typeof v === 'string' && ethers.isAddress(v);
}

function publicProject(p) {
  return {
    id: p.id,
    label: p.label,
    mintContract: p.mintContract,
    token: p.token,
    pair: p.pair,
    requiredShares: p.requiredShares,
    registrationTtlHours: p.registrationTtlHours,
    operatorReferrer: p.operatorReferrer || null,
    pricingMode: (p.pricing || {}).mode || 'fixed',
    baseUsdt: (p.pricing || {}).baseUsdt,
    poolFloorBnb: (p.pricing || {}).poolFloorBnb ?? null,
    poolFloorUsdt: (p.pricing || {}).poolFloorUsdt ?? null,
  };
}

function upsertRegistration(project, { minter, recipient, verified }) {
  const rows = db.registrations();
  const ttlMs = project.registrationTtlHours * 3600 * 1000;
  const existing = rows.find((r) => r.projectId === project.id && r.minter.toLowerCase() === minter.toLowerCase() && !r.paid);
  const rec = {
    projectId: project.id,
    minter: ethers.getAddress(minter),
    recipient: ethers.getAddress(recipient),
    createdAt: nowMs(),
    expiresAt: nowMs() + ttlMs,
    verified: !!verified,
    paid: false,
    paidTxHash: null,
  };
  if (existing) {
    if (existing.verified && !verified) {
      return { ok: false, error: 'registration is verified/locked; overwrite requires a signature from the minter wallet' };
    }
    Object.assign(existing, rec);
    db.saveRegistrations(rows);
    return { ok: true, registration: existing, replaced: true };
  }
  rows.push(rec);
  db.saveRegistrations(rows);
  return { ok: true, registration: rec, replaced: false };
}

async function handlePreregister(req, res, { claim }) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
  }
  const { minter, recipient, signature } = body;
  const project = getProject(body.project);
  if (!project) return sendJson(res, 400, { ok: false, error: 'unknown project' });
  if (!isAddress(minter)) return sendJson(res, 400, { ok: false, error: 'minter must be a BSC address' });
  if (!isAddress(recipient)) return sendJson(res, 400, { ok: false, error: 'recipient must be a BSC USDT address' });
  let verified = false;
  if (signature) {
    try {
      const recovered = ethers.verifyMessage(registerMessage(minter, recipient), signature);
      verified = recovered.toLowerCase() === minter.toLowerCase();
    } catch {
      verified = false;
    }
    if (!verified) return sendJson(res, 400, { ok: false, error: 'signature does not match the minter address' });
  }
  if (claim && !verified) {
    return sendJson(res, 400, { ok: false, error: 'claim/overwrite requires a signature from the minter wallet' });
  }
  const out = upsertRegistration(project, { minter, recipient, verified });
  if (!out.ok) return sendJson(res, 409, out);
  return sendJson(res, 200, {
    ok: true,
    project: project.id,
    minter: out.registration.minter,
    recipient: out.registration.recipient,
    verified: out.registration.verified,
    expiresAt: out.registration.expiresAt,
    replaced: out.replaced,
  });
}

async function handleVerify(req, res) {
  // Manual verification: for each minter address / AgentID, report what
  // the server itself knows — registration, payout, and captured mints.
  // It never invents a mint and never pays anything. Coverage note:
  // mints are only those the listener captured since this service
  // (re)started; mints from before the last restart are not in the store.
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
  }
  const project = getProject(body.project);
  if (!project) return sendJson(res, 400, { ok: false, error: 'unknown project' });
  const recipient = body.recipient;
  if (recipient && !isAddress(recipient)) return sendJson(res, 400, { ok: false, error: 'recipient must be a BSC address' });
  const raw = Array.isArray(body.minters) ? body.minters : String(body.minters || '').split(/[\s,]+/);
  const inputs = [...new Set(raw.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 100);
  if (!inputs.length) return sendJson(res, 400, { ok: false, error: 'no minter addresses given' });
  const now = nowMs();
  const results = [];
  for (const input of inputs) {
    let address = null;
    let handle = null;
    if (isAddress(input)) {
      address = ethers.getAddress(input);
    } else if (/^[a-z0-9-]+\.ai$/i.test(input) || /^[a-z0-9-]+$/i.test(input)) {
      handle = input.toLowerCase().endsWith('.ai') ? input.toLowerCase() : input.toLowerCase() + '.ai';
      address = await resolveAgentId(input);
    }
    if (!address) {
      results.push({ input, handle, address: null, verdict: 'unresolved', reason: '地址格式不对，或该 AgentID 未注册（链上查不到 owner）' });
      continue;
    }
    const regs = db.registrations().filter((r) => r.projectId === project.id && r.minter.toLowerCase() === address.toLowerCase());
    const reg = regs.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    const payout = db.payouts().filter((p) => p.projectId === project.id && p.minter.toLowerCase() === address.toLowerCase() && p.status === 'paid').slice(-1)[0] || null;
    const mints = db.mints().filter((m) => m.projectId === project.id && m.minter.toLowerCase() === address.toLowerCase());
    const totalShares = mints.reduce((s, m) => s + Number(m.shares || 0), 0);
    const qualifying = mints.filter((m) => Number(m.shares) >= project.requiredShares && project.operatorReferrer && m.referrer && m.referrer.toLowerCase() === project.operatorReferrer.toLowerCase());
    let verdict;
    let reason;
    if (payout) {
      verdict = 'already_paid';
      reason = `已打款 ${payout.amountUsdt} USDT，tx ${payout.txHash || '—'}`;
    } else if (reg && reg.paid) {
      verdict = 'already_paid';
      reason = '登记已兑付（打款处理中），请到“我的打款记录”核对';
    } else if (!reg) {
      verdict = 'no_registration';
      reason = '未预登记：请先到第 1 步登记，再铸造';
    } else if (reg.expiresAt <= now) {
      verdict = 'registration_expired';
      reason = '登记已过期（24 小时），请重新登记后再铸造';
    } else if (recipient && reg.recipient.toLowerCase() !== recipient.toLowerCase()) {
      verdict = 'recipient_mismatch';
      reason = '收款地址与登记时的不一致：补领只能打到登记时的收款地址';
    } else if (!mints.length) {
      verdict = 'no_mint_found';
      reason = '本次服务启动后未扫到该地址的铸造：可能还没铸，或铸造发生在服务重启前';
    } else if (!qualifying.length) {
      const wrongRef = mints.some((m) => m.referrer && project.operatorReferrer && m.referrer.toLowerCase() !== project.operatorReferrer.toLowerCase());
      verdict = wrongRef ? 'referrer_mismatch' : 'insufficient_shares';
      reason = wrongRef ? '已扫到铸造，但推荐人不是运营方地址，返佣不到账、不打款' : `已扫到铸造共 ${totalShares} 份，未满 ${project.requiredShares} 份`;
    } else {
      verdict = 'eligible';
      reason = `可补领：已铸 ${qualifying[0].shares} 份，推荐人正确，登记有效`;
    }
    results.push({
      input, handle, address, verdict, reason,
      registration: reg ? { recipient: reg.recipient, verified: reg.verified, expiresAt: reg.expiresAt, paid: reg.paid } : null,
      payout: payout ? { amountUsdt: payout.amountUsdt, txHash: payout.txHash, createdAt: payout.createdAt } : null,
      mints: mints.map((m) => ({ shares: m.shares, referrer: m.referrer, txHash: m.txHash, blockNumber: m.blockNumber })),
      totalShares,
    });
  }
  const state = db.state();
  const pst = projectState(state, project.id);
  return sendJson(res, 200, {
    ok: true,
    project: project.id,
    results,
    coverage: { lastScannedBlock: pst.lastScannedBlock, note: '只覆盖本次服务启动后监听扫过的铸造；重启前的铸造不在记录里' },
  });
}

async function handleManualPayout(req, res) {
  // Manual top-up ("确认并立即打款"): re-validates EVERYTHING server-side
  // with the same checks as the listener — active registration, a captured
  // qualifying mint (>= required shares via the operator referrer), no
  // existing payout, daily cap, economics guard — then queues and sends
  // through the same sendPayout. The payout always goes to the
  // registration's recipient, never to an address supplied here.
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
  }
  const project = getProject(body.project);
  if (!project) return sendJson(res, 400, { ok: false, error: 'unknown project' });
  const { minter, recipient } = body;
  if (!isAddress(minter)) return sendJson(res, 400, { ok: false, error: 'minter must be a BSC address' });
  if (!isAddress(recipient)) return sendJson(res, 400, { ok: false, error: 'recipient must be a BSC address' });
  const reg = db.registrations().find((r) => r.projectId === project.id && r.minter.toLowerCase() === minter.toLowerCase() && !r.paid);
  if (!reg) return sendJson(res, 400, { ok: false, error: 'no active registration for this minter (not registered, expired, or already paid)' });
  if (reg.expiresAt <= nowMs()) return sendJson(res, 400, { ok: false, error: 'registration expired; re-register first' });
  if (reg.recipient.toLowerCase() !== recipient.toLowerCase()) return sendJson(res, 400, { ok: false, error: 'recipient does not match the registration; manual payout only pays the registered recipient' });
  const mints = db.mints().filter((m) => m.projectId === project.id && m.minter.toLowerCase() === minter.toLowerCase());
  const q = mints.find((m) => Number(m.shares) >= project.requiredShares && project.operatorReferrer && m.referrer && m.referrer.toLowerCase() === project.operatorReferrer.toLowerCase());
  if (!q) return sendJson(res, 400, { ok: false, error: 'no qualifying mint found in this service run (need >= required shares via the operator referrer)' });
  const already = db.payouts().find((p) => p.projectId === project.id && p.minter.toLowerCase() === minter.toLowerCase() && (p.status === 'paid' || p.status === 'queued'));
  if (already) return sendJson(res, 409, { ok: false, error: 'a payout for this minter already exists', status: already.status, txHash: already.txHash || null });
  const chainState = await getChainState(project);
  const payoutUsdt = priceFor(project, chainState);
  if (paidTodayUsdt(project.id) + Number(payoutUsdt) > Number(project.maxPayoutUsdtPerDay)) {
    return sendJson(res, 400, { ok: false, error: 'daily payout cap would be exceeded' });
  }
  const guard = await economicsCheck(Number(q.shares), project, payoutUsdt);
  if (!guard.ok) return sendJson(res, 400, { ok: false, error: 'economics guard blocked the payout: ' + guard.reason });
  const payouts = db.payouts();
  const record = {
    id: `${Date.now()}-manual-${q.txHash.slice(2, 10)}`,
    projectId: project.id,
    minter: ethers.getAddress(minter),
    recipient: reg.recipient,
    amountUsdt: payoutUsdt,
    txHash: null,
    blockNumber: q.blockNumber,
    status: 'queued',
    createdAt: nowMs(),
    manual: true,
    mintTxHash: q.txHash,
  };
  payouts.push(record);
  db.savePayouts(payouts);
  const rows = db.registrations();
  const r = rows.find((x) => x.minter.toLowerCase() === minter.toLowerCase() && !x.paid && x.projectId === project.id);
  if (r) {
    r.paid = true;
    db.saveRegistrations(rows);
  }
  await flushQueue(project);
  const done = db.payouts().find((p) => p.id === record.id);
  return sendJson(res, 200, {
    ok: true,
    status: done.status,
    amountUsdt: done.amountUsdt,
    txHash: done.txHash || null,
    recipient: done.recipient,
    dryRun: done.status === 'dry-run',
    error: done.error || null,
  });
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const file = path.join(__dirname, '..', 'public', 'index.html');
        if (fs.existsSync(file)) {
          const body = fs.readFileSync(file);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
          return res.end(body);
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/preregister') {
        return handlePreregister(req, res, { claim: false });
      }
      if (req.method === 'POST' && url.pathname === '/api/preregister/claim') {
        return handlePreregister(req, res, { claim: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/verify') {
        return handleVerify(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/api/manual-payout') {
        return handleManualPayout(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/api/payouts') {
        const recipient = url.searchParams.get('recipient');
        const project = url.searchParams.get('project');
        let rows = db.payouts().filter((p) => p.status === 'paid');
        if (project) rows = rows.filter((p) => p.projectId === project);
        if (recipient) rows = rows.filter((p) => p.recipient.toLowerCase() === recipient.toLowerCase());
        return sendJson(res, 200, { ok: true, payouts: rows.slice(-100).reverse() });
      }
      if (req.method === 'GET' && url.pathname === '/api/quote') {
        const project = getProject(url.searchParams.get('project'));
        if (!project) return sendJson(res, 400, { ok: false, error: 'unknown project' });
        const chainState = await getChainState(project, { force: true });
        const payoutUsdt = priceFor(project, chainState);
        const shares = Number(url.searchParams.get('shares') || project.requiredShares);
        const guard = await economicsCheck(shares, project, payoutUsdt);
        return sendJson(res, 200, {
          ok: true,
          project: project.id,
          payoutUsdt,
          shares,
          totalMinted: chainState.totalMinted,
          poolBnb: chainState.poolBnb,
          expectedRebateUsdt: guard.expected,
          guardOk: guard.ok,
          guardReason: guard.reason,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let wallet = null;
        let balance = null;
        if (cfg.hotWalletPrivateKey) {
          try {
            wallet = await hotWalletAddress();
            balance = await hotWalletUsdtBalance();
          } catch { /* status stays partial */ }
        }
        const state = db.state();
        const projectStatus = projects.map((p) => {
          const pst = projectState(state, p.id);
          return {
            id: p.id,
            label: p.label,
            eventConfigured: !!(p.eventTopic0 || p.eventSignature),
            lastScannedBlock: pst.lastScannedBlock,
            totalMinted: pst.totalMinted !== null && pst.totalMinted !== undefined ? Number(pst.totalMinted) : null,
            poolBnb: pst.poolBnb,
            poolRunwayHours: poolRunwayHours(pst),
            registrations: db.registrations().filter((r) => r.projectId === p.id).length,
            payouts: db.payouts().filter((x) => x.projectId === p.id && x.status === 'paid').length,
            operatorReferrer: p.operatorReferrer || null,
          };
        });
        return sendJson(res, 200, {
          ok: true,
          dryRun: cfg.dryRun,
          batchWindowSeconds: cfg.batchWindowSeconds,
          hotWallet: wallet,
          hotWalletUsdt: balance,
          projects: projectStatus,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(res, 200, {
          ok: true,
          payoutToken: cfg.payoutToken,
          projects: projects.map(publicProject),
        });
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[api] listening on http://${cfg.host}:${cfg.port}`);
  });
  return server;
}

module.exports = { startServer, registerMessage };

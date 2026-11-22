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
const { hotWalletAddress, hotWalletUsdtBalance, priceFor, economicsCheck } = require('./payout');
const { getChainState, poolRunwayHours } = require('./listener');

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

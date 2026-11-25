// Listener: poll BSC for Mint events across all configured projects,
// match registrations, and pay out (via a queue — see flushQueue).
// One payout per minter per registration per project. Idempotent via
// processed tx hashes. Discovery mode: when a project's event is not
// configured, its raw mint-contract logs are printed instead of paid.
const { ethers } = require('ethers');
const { cfg, projects } = require('./config');
const { db, nowMs, activeRegistration, projectState } = require('./db');
const { getLatestBlock, getMintLogs, decodeMintLog, mintTopic0, getBlockWithTxs, getTxReceipt, getTotalMinted, getBlockReceipts, getPoolBnb } = require('./chain');
const { economicsCheck, sendPayout, priceFor } = require('./payout');

// Live chain state per project, cached briefly (quote + guard share it).
const chainStateCache = new Map(); // projectId -> { at, totalMinted, poolBnb }

async function getChainState(project, { force = false } = {}) {
  const cached = chainStateCache.get(project.id);
  if (!force && cached && Date.now() - cached.at < 30000) return cached;
  let totalMinted = null;
  let poolBnb = null;
  try {
    totalMinted = Number(await getTotalMinted(project));
  } catch { /* best effort */ }
  try {
    const pool = await getPoolBnb(project);
    if (pool) poolBnb = pool.bnb;
  } catch { /* best effort */ }
  const state = { at: Date.now(), totalMinted, poolBnb };
  chainStateCache.set(project.id, state);
  return state;
}

// Estimated hours until the pool drains to 5 BNB, from pool samples.
// Returns null when the pool is not draining (or too few samples).
function poolRunwayHours(pst) {
  const samples = (pst.poolSamples || []).filter((s) => typeof s.bnb === 'number');
  if (samples.length < 2 || pst.poolBnb === null) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const hours = (last.at - first.at) / 3600000;
  if (hours < 0.25) return null;
  const burnPerHour = (first.bnb - last.bnb) / hours;
  if (burnPerHour <= 0) return null;
  return Math.max(0, (pst.poolBnb - 5) / burnPerHour);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function paidTodayUsdt(projectId) {
  const key = todayKey();
  return db.payouts()
    .filter((p) => p.status === 'paid' && p.projectId === projectId && p.createdAt && new Date(p.createdAt).toISOString().slice(0, 10) === key)
    .reduce((sum, p) => sum + Number(p.amountUsdt || 0), 0);
}

async function handleMint({ minter, shares, referrer, txHash, blockNumber, project }) {
  const state = db.state();
  const seenKey = `${project.id}:${txHash}`;
  state.processedTxHashes = state.processedTxHashes || [];
  if (state.processedTxHashes.includes(seenKey)) return;
  state.processedTxHashes.push(seenKey);
  if (state.processedTxHashes.length > 5000) state.processedTxHashes = state.processedTxHashes.slice(-5000);
  db.saveState(state);

  // Record every captured mint (paid or not) so manual verification can
  // answer "did this minter mint, how many shares, was the referrer
  // right" from the server's own records instead of guessing.
  try {
    const mints = db.mints();
    if (!mints.some((m) => m.projectId === project.id && m.txHash.toLowerCase() === txHash.toLowerCase())) {
      mints.push({ projectId: project.id, minter, shares, referrer: referrer || null, txHash, blockNumber, createdAt: nowMs() });
      if (mints.length > 5000) mints.splice(0, mints.length - 5000);
      db.saveMints(mints);
    }
  } catch { /* mint record is best-effort; payout logic must not depend on it */ }

  console.log(`[listener:${project.id}] mint detected: minter=${minter} shares=${shares} referrer=${referrer || 'n/a'} tx=${txHash} block=${blockNumber}`);
  if (project.operatorReferrer && referrer && referrer.toLowerCase() !== project.operatorReferrer.toLowerCase()) {
    console.log(`[listener:${project.id}] skip: referrer ${referrer} is not the operator referrer ${project.operatorReferrer} (no rebate for this mint)`);
    return;
  }
  if (shares < project.requiredShares) {
    console.log(`[listener:${project.id}] skip: ${shares} shares < required ${project.requiredShares}`);
    return;
  }
  const reg = activeRegistration(minter, project.id);
  if (!reg) {
    console.log(`[listener:${project.id}] skip: no active registration for ${minter}`);
    return;
  }
  const chainState = await getChainState(project);
  const payoutUsdt = priceFor(project, chainState);
  if (paidTodayUsdt(project.id) + Number(payoutUsdt) > Number(project.maxPayoutUsdtPerDay)) {
    console.log(`[listener:${project.id}] skip: daily cap ${project.maxPayoutUsdtPerDay} USDT would be exceeded`);
    return;
  }
  const guard = await economicsCheck(shares, project, payoutUsdt);
  console.log(`[listener:${project.id}] economics guard: ${guard.ok ? 'PASS' : 'BLOCK'} (${guard.reason})`);
  if (!guard.ok) return;

  // Enqueue (price locked now, like the site's "预登记时锁价" idea applied
  // at mint time). flushQueue sends it, immediately when the batch
  // window is 0, otherwise batched with the others in the window.
  const payouts = db.payouts();
  const record = {
    id: `${Date.now()}-${txHash.slice(2, 10)}`,
    projectId: project.id,
    minter,
    recipient: reg.recipient,
    amountUsdt: payoutUsdt,
    txHash: null,
    blockNumber,
    status: 'queued',
    createdAt: nowMs(),
  };
  payouts.push(record);
  db.savePayouts(payouts);
  const rows = db.registrations();
  const r = rows.find((x) => x.minter.toLowerCase() === minter.toLowerCase() && !x.paid && x.projectId === project.id);
  if (r) {
    r.paid = true;
    db.saveRegistrations(rows);
  }
  console.log(`[listener:${project.id}] payout queued: ${payoutUsdt} USDT -> ${reg.recipient} (minter ${minter})`);
  if (cfg.batchWindowSeconds <= 0) await flushQueue(project);
}

async function flushQueue(project) {
  const payouts = db.payouts();
  const queued = payouts.filter((p) => p.status === 'queued' && (!project || p.projectId === project.id));
  if (!queued.length) return;
  for (const record of queued) {
    const proj = projects.find((p) => p.id === record.projectId) || project;
    try {
      const out = await sendPayout(record.recipient, record.amountUsdt, { minter: record.minter, shares: 0, project: proj });
      record.txHash = out.txHash;
      record.status = out.dryRun ? 'dry-run' : 'paid';
      if (!out.dryRun) {
        const rows = db.registrations();
        const r = rows.find((x) => x.minter.toLowerCase() === record.minter.toLowerCase() && x.paid && x.projectId === record.projectId && !x.paidTxHash);
        if (r) r.paidTxHash = out.txHash;
        db.saveRegistrations(rows);
      }
      console.log(`[listener:${proj.id}] payout ${record.status}: ${record.amountUsdt} USDT -> ${record.recipient} (tx ${out.txHash || 'n/a'})`);
    } catch (e) {
      record.status = 'failed';
      record.error = e.message;
      console.error(`[listener:${proj.id}] payout FAILED for ${record.minter}: ${e.message}`);
    }
    db.savePayouts(payouts);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function describeRawLog(project, log) {
  console.log(`[discover:${project.id}] raw log block=${log.blockNumber} tx=${log.transactionHash} topics=${JSON.stringify(log.topics)} data=${log.data}`);
}

async function handleLog(log, project) {
  if (!mintTopic0(project)) {
    describeRawLog(project, log);
    return 0;
  }
  const decoded = decodeMintLog(log, project);
  if (!decoded) return 0;
  await handleMint({ ...decoded, txHash: log.transactionHash, blockNumber: log.blockNumber, project });
  return 1;
}

async function scanBlocks(fromBlock, toBlock, project) {
  let found = 0;
  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await getBlockWithTxs(b);
    if (!block || !block.transactions) continue;
    for (const tx of block.transactions) {
      const to = typeof tx === 'object' ? tx.to : null;
      const hash = typeof tx === 'object' ? tx.hash : tx;
      if (!to || to.toLowerCase() !== project.mintContract.toLowerCase()) continue;
      const receipt = await getTxReceipt(hash);
      if (!receipt || receipt.status !== 1) continue;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== project.mintContract.toLowerCase()) continue;
        found += await handleLog(log, project);
      }
    }
  }
  return found;
}

async function scanReceipts(fromBlock, toBlock, project) {
  let found = 0;
  for (let b = fromBlock; b <= toBlock; b++) {
    const receipts = await getBlockReceipts(b);
    for (const rc of receipts || []) {
      for (const log of rc.logs || []) {
        if (log.address.toLowerCase() !== project.mintContract.toLowerCase()) continue;
        found += await handleLog(log, project);
      }
    }
  }
  return found;
}

async function scanLogs(fromBlock, toBlock, project) {
  const logs = await getMintLogs(fromBlock, toBlock, project);
  let found = 0;
  for (const log of logs) found += await handleLog(log, project);
  return found;
}

async function scanProject(fromBlock, toBlock, project) {
  if (cfg.logMode === 'getlogs') return scanLogs(fromBlock, toBlock, project);
  if (cfg.logMode === 'blockscan') return scanBlocks(fromBlock, toBlock, project);
  return scanReceipts(fromBlock, toBlock, project);
}

async function tickProject(project) {
  const state = db.state();
  const pst = projectState(state, project.id);
  const latest = await getLatestBlock();
  const toBlock = latest - cfg.confirmations;
  let fromBlock = pst.lastScannedBlock === null ? Math.max(toBlock - 50, 0) : pst.lastScannedBlock + 1;
  if (fromBlock > toBlock) return;
  const windowSize = cfg.logMode === 'receipts' ? 50 : cfg.logMode === 'blockscan' ? 100 : 400;
  const windowEnd = Math.min(toBlock, fromBlock + windowSize);
  const mintedBefore = pst.totalMinted !== null && pst.totalMinted !== undefined ? BigInt(pst.totalMinted) : null;
  const n = await scanProject(fromBlock, windowEnd, project);
  pst.lastScannedBlock = windowEnd;
  try {
    const totalMinted = await getTotalMinted(project);
    pst.totalMinted = totalMinted.toString();
    if (mintedBefore !== null && totalMinted > mintedBefore && n === 0) {
      console.warn(`[listener:${project.id}] WARNING: totalMinted rose ${mintedBefore} -> ${totalMinted} but no mint was captured. Mints may be routed through another contract; a log-capable RPC (LOG_MODE=getlogs) is needed to catch them.`);
    }
  } catch { /* watchdog is best-effort */ }
  try {
    const pool = await getPoolBnb(project);
    if (pool) {
      pst.poolBnb = pool.bnb;
      pst.poolSamples = pst.poolSamples || [];
      const last = pst.poolSamples[pst.poolSamples.length - 1];
      if (!last || Date.now() - last.at > 60000) {
        pst.poolSamples.push({ bnb: pool.bnb, at: Date.now() });
        if (pst.poolSamples.length > 120) pst.poolSamples = pst.poolSamples.slice(-120);
      }
    }
  } catch { /* best effort */ }
  db.saveState(state);
  if (n > 0) console.log(`[listener:${project.id}] scanned blocks ${fromBlock}-${windowEnd}: ${n} mint logs handled`);
}

async function tick() {
  for (const project of projects) {
    try {
      await tickProject(project);
    } catch (e) {
      console.error(`[listener:${project.id}] tick failed: ${e.message}`);
    }
  }
  try {
    await flushQueue();
  } catch (e) {
    console.error(`[listener] flush failed: ${e.message}`);
  }
}

function startListener() {
  for (const project of projects) {
    if (!mintTopic0(project)) {
      console.log(`[listener:${project.id}] event not configured: DISCOVERY mode (logs raw mint-contract events, pays nothing).`);
    } else {
      console.log(`[listener:${project.id}] watching ${project.mintContract} for event ${mintTopic0(project)}`);
    }
  }
  console.log(`[listener] scan mode: ${cfg.logMode}; batch window: ${cfg.batchWindowSeconds}s (0 = pay immediately)`);
  if (cfg.dryRun) console.log('[listener] DRY RUN is on: payouts are logged, nothing is sent.');
  let flushing = false;
  const loop = async () => {
    await tick();
    setTimeout(loop, cfg.pollIntervalMs);
  };
  loop();
  if (cfg.batchWindowSeconds > 0) {
    setInterval(async () => {
      if (flushing) return;
      flushing = true;
      try { await flushQueue(); } catch { /* logged inside */ } finally { flushing = false; }
    }, cfg.batchWindowSeconds * 1000);
  }
}

module.exports = { startListener, tick, handleMint, handleLog, getChainState, poolRunwayHours, flushQueue, paidTodayUsdt };

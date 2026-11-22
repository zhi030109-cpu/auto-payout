// Tiny JSON store with atomic writes. One process owns the files.
//   data/registrations.json  [{ projectId, minter, recipient, createdAt, expiresAt, verified, paid, paidTxHash }]
//   data/payouts.json        [{ id, projectId, minter, recipient, amountUsdt, txHash, blockNumber, status, createdAt }]
//     status: queued | paid | dry-run | failed
//   data/state.json          { lastScannedBlock, processedTxHashes: [],
//                              projects: { [id]: { lastScannedBlock, totalMinted, poolBnb, poolSamples: [{bnb, at}] } } }
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');

function ensureDir() {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
}

function read(name, fallback) {
  ensureDir();
  const file = path.join(cfg.dataDir, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, data) {
  ensureDir();
  const file = path.join(cfg.dataDir, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const db = {
  registrations: () => read('registrations.json', []),
  saveRegistrations: (rows) => write('registrations.json', rows),
  payouts: () => read('payouts.json', []),
  savePayouts: (rows) => write('payouts.json', rows),
  state: () => read('state.json', { lastScannedBlock: null, processedTxHashes: [] }),
  saveState: (s) => write('state.json', s),
};

function nowMs() {
  return Date.now();
}

function findRegistration(minter, projectId) {
  const m = minter.toLowerCase();
  return db.registrations().find((r) => r.minter.toLowerCase() === m && !r.paid && (!projectId || r.projectId === projectId));
}

function activeRegistration(minter, projectId) {
  const r = findRegistration(minter, projectId);
  if (!r) return null;
  if (r.expiresAt <= nowMs()) return null;
  return r;
}

function projectState(state, projectId) {
  state.projects = state.projects || {};
  state.projects[projectId] = state.projects[projectId] || { lastScannedBlock: null, totalMinted: null, poolBnb: null, poolSamples: [] };
  return state.projects[projectId];
}

module.exports = { db, nowMs, findRegistration, activeRegistration, projectState };

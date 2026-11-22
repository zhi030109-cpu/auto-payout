// Config: everything comes from the environment. No secrets in files.
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency): KEY=VALUE lines, ignores # comments.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(__dirname, '..', '.env'));

const env = process.env;
const num = (k, d) => {
  const v = Number(env[k]);
  return Number.isFinite(v) ? v : d;
};
const str = (k, d) => (env[k] && env[k].trim() !== '' ? env[k].trim() : d);

// ---- One project = one mint contract the service watches. ----
// A project with default values filled in. Unknown fields keep their defaults.
const AGENTID_DEFAULTS = {
  id: 'agentid',
  label: 'Agent ID $AI',
  mintContract: '0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D',
  token: '0x2a60AaB19b182B5C4b47fffC066ADA06Ab27924f',
  pair: '0x6c3d8b927B8c38d5907aE64b17804871c97CEf97',
  eventTopic0: '0x6002eca610a8cf3698284c97c6ded788f652ebd60c7aaaa4a00d68f538ae73d0',
  eventSignature: '',
  minterTopicIndex: 1,
  referrerTopicIndex: 3,
  operatorReferrer: '',
  sharesLocation: 'data:1',
  requiredShares: 10,
  registrationTtlHours: 24,
  maxPayoutUsdtPerDay: '500',
  tierPriceBnb: '0.008',
  referralBps: 1500,
  guardFactor: 0.9,
  // pricing: { mode: 'fixed', baseUsdt } or
  // { mode: 'dynamic', baseUsdt, tiers: [[minTotalMinted, priceUsdt], ...],
  //   poolFloorBnb, poolFloorUsdt } — poolFloorUsdt is the 稳健价 used when
  // the pool drops below poolFloorBnb.
  pricing: { mode: 'fixed', baseUsdt: '5.45' },
};

const BIBI_DEFAULTS = {
  id: 'bibi',
  label: 'BIBI',
  mintContract: '0x3ee0570567625D90a5DEE11290F159D4AaCD29C6',
  token: '0x6fC563428B3D6CdD151cB57f0CA5859615C02260',
  pair: '0x63b6a0f72fDA65684Db2aD6e60968c0ab0b22391',
  eventTopic0: '0x6002eca610a8cf3698284c97c6ded788f652ebd60c7aaaa4a00d68f538ae73d0',
  eventSignature: '',
  minterTopicIndex: 1,
  referrerTopicIndex: 3,
  operatorReferrer: '0xdB876cD9450f6407c93E3E7200edf2eA58C87521',
  sharesLocation: 'data:1',
  requiredShares: 10,
  registrationTtlHours: 24,
  maxPayoutUsdtPerDay: '500',
  tierPriceBnb: '0.0028',
  referralBps: 500,
  guardFactor: 0.9,
  // Observed 2026-11-23: site price 0.40U early, 0.75U at totalMinted ~13,255.
  // NOTE: at 0.75U the economics guard blocks (expected rebate ~$0.78, cap
  // 0.78 x 0.9 = $0.70). The tiers below reproduce the site's prices for
  // reference; keep guardFactor at 0.9 and the 0.75 tier will NOT pay out.
  pricing: { mode: 'dynamic', baseUsdt: '0.40', tiers: [[13000, '0.75']], poolFloorBnb: 20, poolFloorUsdt: '0.70' },
};

function fillProject(p) {
  const base = p.id === 'bibi' ? BIBI_DEFAULTS : AGENTID_DEFAULTS;
  const merged = { ...base, ...p };
  merged.pricing = { ...(base.pricing || {}), ...(p.pricing || {}) };
  return merged;
}

function buildProjects() {
  if (env.PROJECTS_JSON) {
    try {
      const arr = JSON.parse(env.PROJECTS_JSON);
      if (Array.isArray(arr) && arr.length) return arr.map(fillProject);
    } catch (e) {
      console.error('PROJECTS_JSON is not valid JSON:', e.message);
    }
  }
  // Legacy single-project mode: env vars describe project #1 (Agent ID).
  // Undefined env values must not overwrite the defaults.
  const overrides = {
    mintContract: str('MINT_CONTRACT', undefined),
    eventTopic0: str('MINT_EVENT_TOPIC0', undefined),
    eventSignature: str('MINT_EVENT_SIGNATURE', undefined),
    minterTopicIndex: num('MINT_MINTER_TOPIC_INDEX', undefined),
    referrerTopicIndex: num('MINT_REFERRER_TOPIC_INDEX', undefined),
    operatorReferrer: str('OPERATOR_REFERRER', undefined),
    sharesLocation: str('MINT_SHARES_LOCATION', undefined),
    tierPriceBnb: str('TIER_PRICE_BNB', undefined),
    referralBps: num('REFERRAL_BPS', undefined),
    guardFactor: Number(env.GUARD_FACTOR || undefined),
  };
  for (const k of Object.keys(overrides)) if (overrides[k] === undefined || Number.isNaN(overrides[k])) delete overrides[k];
  const pricingOverride = { baseUsdt: str('PAYOUT_USDT_PER_MINT', undefined) };
  if (pricingOverride.baseUsdt === undefined) delete pricingOverride.baseUsdt;
  return [fillProject({ ...overrides, pricing: pricingOverride })];
}

const projects = buildProjects();

const cfg = {
  rpcUrls: str('RPC_URLS', 'https://bsc-dataseed.bnbchain.org,https://bsc-dataseed1.defibit.io,https://bsc-dataseed1.ninicoin.io')
    .split(',').map((s) => s.trim()).filter(Boolean),
  chainId: 56,
  payoutToken: str('PAYOUT_TOKEN', '0x55d398326f99059fF775485246999027B3197955'),
  payoutTokenDecimals: num('PAYOUT_TOKEN_DECIMALS', 18),
  economicsGuard: str('ECONOMICS_GUARD', 'true') !== 'false',
  pollIntervalMs: num('POLL_INTERVAL_MS', 10000),
  confirmations: num('CONFIRMATIONS', 1),
  batchWindowSeconds: num('BATCH_WINDOW_SECONDS', 0),
  hotWalletPrivateKey: str('HOT_WALLET_PRIVATE_KEY', ''),
  dryRun: str('DRY_RUN', 'true') !== 'false',
  port: num('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  dataDir: path.resolve(__dirname, '..', str('DATA_DIR', './data')),
  projects,
  // Legacy aliases (first project) for the scan tool and older code.
  mintContract: projects[0].mintContract,
  logMode: str('LOG_MODE', 'receipts'),
};

function getProject(id) {
  if (!id) return projects[0];
  return projects.find((p) => p.id === id) || null;
}

// Validate the bits that must be right before anything runs.
function validate() {
  const errs = [];
  const addr = (v) => /^0x[0-9a-fA-F]{40}$/.test(v || '');
  if (!cfg.rpcUrls.length) errs.push('RPC_URLS is empty');
  for (const p of projects) {
    if (!addr(p.mintContract)) errs.push(`project ${p.id}: MINT_CONTRACT is not an address`);
    if (!p.eventTopic0 && !p.eventSignature) errs.push(`project ${p.id}: no mint event configured (set eventTopic0)`);
  }
  if (!addr(cfg.payoutToken)) errs.push('PAYOUT_TOKEN is not an address');
  if (cfg.dryRun === false && !cfg.hotWalletPrivateKey) errs.push('HOT_WALLET_PRIVATE_KEY is required when DRY_RUN=false');
  if (cfg.hotWalletPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(cfg.hotWalletPrivateKey)) errs.push('HOT_WALLET_PRIVATE_KEY must be a 0x-prefixed 64-hex private key');
  return errs;
}

module.exports = { cfg, validate, getProject, projects };

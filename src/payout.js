// USDT payouts from the hot wallet + the economics that decide them.
// Dry-run by default: log, send nothing.
// Pricing is per project and can be dynamic (see priceFor below).
const { ethers } = require('ethers');
const { cfg } = require('./config');
const { getProvider, getBnbPriceUsd } = require('./chain');

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

let wallet = null;
let token = null;

async function getWallet() {
  if (wallet) return wallet;
  if (!cfg.hotWalletPrivateKey) throw new Error('HOT_WALLET_PRIVATE_KEY is not set');
  const provider = await getProvider();
  wallet = new ethers.Wallet(cfg.hotWalletPrivateKey, provider);
  token = new ethers.Contract(cfg.payoutToken, ERC20_ABI, wallet);
  return wallet;
}

async function hotWalletAddress() {
  const w = await getWallet();
  return w.address;
}

async function hotWalletUsdtBalance() {
  const provider = await getProvider();
  const readOnly = new ethers.Contract(cfg.payoutToken, ERC20_ABI, provider);
  const w = await getWallet();
  const raw = await readOnly.balanceOf(w.address);
  return ethers.formatUnits(raw, cfg.payoutTokenDecimals);
}

// Current payout price for a project, in USDT.
// chainState: { totalMinted (number|null), poolBnb (number|null) }.
// - fixed: always baseUsdt.
// - dynamic: baseUsdt, then the highest tier whose minTotalMinted is met;
//   if the pool drops below poolFloorBnb, the 稳健价 (poolFloorUsdt) wins.
function priceFor(project, chainState) {
  const pricing = project.pricing || { mode: 'fixed', baseUsdt: '5.45' };
  if (pricing.mode !== 'dynamic') return pricing.baseUsdt;
  let price = pricing.baseUsdt;
  const totalMinted = chainState && chainState.totalMinted !== null && chainState.totalMinted !== undefined ? chainState.totalMinted : null;
  if (totalMinted !== null && Array.isArray(pricing.tiers)) {
    const tiers = [...pricing.tiers].sort((a, b) => a[0] - b[0]);
    for (const [minMinted, tierPrice] of tiers) {
      if (totalMinted >= minMinted) price = tierPrice;
    }
  }
  const poolBnb = chainState && chainState.poolBnb !== null && chainState.poolBnb !== undefined ? chainState.poolBnb : null;
  if (poolBnb !== null && pricing.poolFloorBnb !== undefined && pricing.poolFloorUsdt && poolBnb < pricing.poolFloorBnb) {
    price = pricing.poolFloorUsdt;
  }
  return price;
}

function payoutAmountRaw(amountUsdt) {
  return ethers.parseUnits(String(amountUsdt), cfg.payoutTokenDecimals);
}

// Expected referral rebate for a mint, in USDT:
//   shares * tierPriceBnb * bnbPriceUsd * referralBps / 10000
// Returns null when the inputs are not configured (guard cannot compute).
async function expectedRebateUsdt(shares, project) {
  if (!project.tierPriceBnb) return null;
  const bnb = await getBnbPriceUsd();
  if (!bnb) return null;
  const tier = Number(project.tierPriceBnb);
  if (!Number.isFinite(tier) || tier <= 0) return null;
  return shares * tier * bnb * (project.referralBps / 10000);
}

// Economics guard: refuse to pay when the payout exceeds the expected
// rebate * GUARD_FACTOR. Returns { ok, reason, expected }.
async function economicsCheck(shares, project, payoutUsdt) {
  if (!cfg.economicsGuard) return { ok: true, reason: 'guard disabled', expected: null };
  const expected = await expectedRebateUsdt(shares, project);
  if (expected === null) {
    return { ok: false, reason: 'cannot compute expected rebate (set TIER_PRICE_BNB, or disable the guard deliberately)', expected: null };
  }
  const payout = Number(payoutUsdt);
  if (payout > expected * project.guardFactor) {
    return { ok: false, reason: `payout ${payout} USDT exceeds expected rebate ${expected.toFixed(2)} USDT x ${project.guardFactor}`, expected };
  }
  return { ok: true, reason: `payout ${payout} <= expected ${expected.toFixed(2)} x ${project.guardFactor}`, expected };
}

// Send the payout. In dry-run mode returns a fake record (clearly marked).
async function sendPayout(recipient, amountUsdt, { minter, shares, project }) {
  const amountRaw = payoutAmountRaw(amountUsdt);
  if (cfg.dryRun) {
    console.log(`[payout] DRY RUN: would pay ${amountUsdt} USDT to ${recipient} for minter ${minter} (${shares} shares, project ${project.id}). No transaction sent.`);
    return { dryRun: true, txHash: null };
  }
  const w = await getWallet();
  const balance = await hotWalletUsdtBalance();
  if (Number(balance) < Number(amountUsdt)) {
    throw new Error(`hot wallet USDT balance ${balance} is below payout ${amountUsdt}`);
  }
  const tx = await token.transfer(recipient, amountRaw);
  console.log(`[payout] sent ${amountUsdt} USDT to ${recipient}, tx ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (receipt.status !== 1n && receipt.status !== 1) throw new Error(`payout tx reverted: ${tx.hash}`);
  return { dryRun: false, txHash: tx.hash };
}

module.exports = { getWallet, hotWalletAddress, hotWalletUsdtBalance, expectedRebateUsdt, economicsCheck, sendPayout, priceFor };

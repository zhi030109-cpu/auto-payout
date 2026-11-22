// Chain access: providers with fallback, log fetching, Mint-event decoding.
// The Mint event layout is config-driven (see MINT_EVENT_SIGNATURE etc.)
// because every mint contract defines its own event. Run `npm run scan`
// to discover it from a real mint transaction before going live.
const { ethers } = require('ethers');
const { cfg } = require('./config');

let provider = null;
let providerUrl = null;

async function getProvider() {
  if (provider) return provider;
  for (const url of cfg.rpcUrls) {
    try {
      const p = new ethers.JsonRpcProvider(url, cfg.chainId);
      await p.getBlockNumber();
      provider = p;
      providerUrl = url;
      return p;
    } catch (e) {
      console.warn(`[chain] RPC unreachable, trying next: ${url} (${e.message})`);
    }
  }
  throw new Error('No RPC endpoint reachable');
}

async function getLatestBlock() {
  const p = await getProvider();
  return p.getBlockNumber();
}

// Topic0 for a project's Mint event, or null when not configured.
// A raw topic0 hash (eventTopic0) wins over the signature name,
// because some contracts emit events whose exact name is not published.
function mintTopic0(project) {
  if (project.eventTopic0) return project.eventTopic0.toLowerCase();
  if (!project.eventSignature) return null;
  return ethers.id(project.eventSignature);
}

// Decode one log from a project's mint contract into
// { minter, shares, referrer } or null.
function decodeMintLog(log, project) {
  const topic0 = mintTopic0(project);
  if (topic0 && log.topics[0] !== topic0) return null;
  if (!log.topics || log.topics.length <= project.minterTopicIndex) return null;
  const minter = '0x' + log.topics[project.minterTopicIndex].slice(-40);
  if (!ethers.isAddress(minter)) return null;

  let shares = null;
  const loc = project.sharesLocation;
  if (loc.startsWith('topic:')) {
    const idx = Number(loc.split(':')[1]);
    if (log.topics[idx]) shares = BigInt(log.topics[idx]);
  } else if (loc.startsWith('data:')) {
    const word = Number(loc.split(':')[1]);
    const data = (log.data || '0x').slice(2);
    const chunk = data.slice(word * 64, word * 64 + 64);
    if (chunk.length === 64) shares = BigInt('0x' + chunk);
  }
  if (shares === null) return null;

  let referrer = null;
  if (project.referrerTopicIndex >= 0 && log.topics.length > project.referrerTopicIndex) {
    const r = '0x' + log.topics[project.referrerTopicIndex].slice(-40);
    if (ethers.isAddress(r)) referrer = ethers.getAddress(r);
  }
  return { minter: ethers.getAddress(minter), shares: Number(shares), referrer };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getMintLogs(fromBlock, toBlock, project) {
  const p = await getProvider();
  const topic0 = mintTopic0(project);
  async function fetchRange(a, b, depth) {
    const filter = { address: project.mintContract, fromBlock: a, toBlock: b };
    if (topic0) filter.topics = [topic0];
    // Public nodes rate-limit eth_getLogs: be polite between calls.
    await sleep(250);
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await p.getLogs(filter);
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        const rateLimited = /rate limit/i.test(msg);
        const limitExceeded = /limit exceeded/i.test(msg);
        if (rateLimited) {
          await sleep(1500 * attempt);
          continue;
        }
        if (limitExceeded && b - a > 1 && depth < 8) {
          const mid = Math.floor((a + b) / 2);
          const left = await fetchRange(a, mid, depth + 1);
          const right = await fetchRange(mid + 1, b, depth + 1);
          return left.concat(right);
        }
        throw e;
      }
    }
    throw new Error('eth_getLogs rate-limited after retries');
  }
  return fetchRange(fromBlock, toBlock, 0);
}

// --- Block-scan helpers (work on free public RPCs) -----------------------
// Free BSC RPCs rate-limit eth_getLogs to death, but eth_getBlockByNumber
// (full txs) and eth_getTransactionReceipt work fine. So the primary scan
// path walks blocks, finds transactions sent TO the mint contract, and
// decodes their receipts. Mints routed through another contract (e.g. a
// wallet executor) are NOT caught this way; the totalMinted() watchdog
// reports when the count moved without a captured mint.

async function getBlockWithTxs(blockNumber) {
  const p = await getProvider();
  return p.getBlock(blockNumber, true);
}

async function getTxReceipt(txHash) {
  const p = await getProvider();
  return p.getTransactionReceipt(txHash);
}

// All receipts of one block in a single call (BSC geth supports this).
// The key to finding ROUTED mints: a mint executed through a wallet
// executor still emits the mint contract's logs inside its receipt.
async function getBlockReceipts(blockNumber) {
  const p = await getProvider();
  const hex = '0x' + Number(blockNumber).toString(16);
  return p.send('eth_getBlockReceipts', [hex]);
}

// totalMinted() from a project's mint contract (selector computed locally).
async function getTotalMinted(project) {
  const p = await getProvider();
  const sel = ethers.id('totalMinted()').slice(0, 10);
  const raw = await p.call({ to: project.mintContract, data: sel });
  return BigInt(raw);
}

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

// Pool BNB of a project (WBNB side of its PancakeSwap V2 pair).
// Returns { bnb, tokenReserve } or null when no pair is configured.
async function getPoolBnb(project) {
  if (!project.pair) return null;
  try {
    const p = await getProvider();
    const pair = new ethers.Contract(project.pair, PAIR_ABI, p);
    const [token0, token1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
    const bnbRaw = token0.toLowerCase() === WBNB.toLowerCase() ? reserves[0] : token1.toLowerCase() === WBNB.toLowerCase() ? reserves[1] : null;
    if (bnbRaw === null) return null;
    const tokenRaw = token0.toLowerCase() === WBNB.toLowerCase() ? reserves[1] : reserves[0];
    return { bnb: Number(ethers.formatEther(bnbRaw)), tokenReserve: tokenRaw.toString() };
  } catch {
    return null;
  }
}

// BNB price in USDT, via Dexscreener (public, no key). Used only by the
// economics guard; falls back to null (guard then blocks live payouts).
async function getBnbPriceUsd() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    const pair = (json.pairs || []).find((x) => x.quoteToken && x.quoteToken.symbol === 'USDT');
    if (pair && pair.priceUsd) return Number(pair.priceUsd);
    return null;
  } catch {
    return null;
  }
}

module.exports = { getProvider, getLatestBlock, mintTopic0, decodeMintLog, getMintLogs, getBnbPriceUsd, getBlockWithTxs, getTxReceipt, getTotalMinted, getBlockReceipts, getPoolBnb };

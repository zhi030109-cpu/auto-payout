// Discovery tool: identify the Mint event of a mint contract.
// Works on free public RPCs: walks blocks, finds transactions sent TO the
// mint contract, and prints their receipts' mint-contract logs.
//
//   node scripts/scan.js --tx 0x<mint tx hash>
//     Print every mint-contract log of that transaction receipt.
//
//   node scripts/scan.js --blocks 200
//     Scan the last N blocks for direct mint transactions.
//
//   node scripts/scan.js --from 135110400 --to 135110600
//     Scan a specific historical window (use when minting was active then).
//
// The output tells you what to put in .env:
//   MINT_EVENT_SIGNATURE=<event signature, e.g. Mint(address,uint256,uint256)>
//   MINT_MINTER_TOPIC_INDEX=<topic holding the minter address, usually 1>
//   MINT_SHARES_LOCATION=<data:0 | topic:2 | ...>
const { ethers } = require('ethers');
const { cfg } = require('../src/config');
const { getProvider, getLatestBlock, getBlockWithTxs, getTxReceipt, getBlockReceipts } = require('../src/chain');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { tx: null, blocks: 200, from: null, to: null, receipts: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tx') out.tx = args[++i];
    if (args[i] === '--blocks') out.blocks = Number(args[++i] || 200);
    if (args[i] === '--from') out.from = Number(args[++i]);
    if (args[i] === '--to') out.to = Number(args[++i]);
    if (args[i] === '--receipts') out.receipts = true;
  }
  return out;
}

function describeLog(log) {
  console.log(`--- block ${log.blockNumber} tx ${log.transactionHash}`);
  console.log(`    address: ${log.address}`);
  console.log(`    topics:`);
  (log.topics || []).forEach((t, i) => {
    let note = '';
    if (t.length === 66 && t.startsWith('0x000000000000000000000000')) note = `  (address? 0x${t.slice(-40)})`;
    if (/^0x[0-9a-f]{64}$/.test(t)) {
      try {
        const n = BigInt(t);
        if (n < 1000000000n) note += `  (uint? ${n})`;
      } catch { /* ignore */ }
    }
    console.log(`      [${i}] ${t}${note}`);
  });
  const data = (log.data || '0x').slice(2);
  console.log(`    data (${data.length / 2} bytes):`);
  for (let w = 0; w * 64 < data.length; w++) {
    const chunk = data.slice(w * 64, w * 64 + 64);
    let note = '';
    try {
      const n = BigInt('0x' + chunk);
      if (n < 10n ** 30n) note = `  (= ${n})`;
    } catch { /* ignore */ }
    console.log(`      word ${w}: 0x${chunk}${note}`);
  }
}

async function describeTxReceipt(txHash) {
  const provider = await getProvider();
  const rc = await provider.getTransactionReceipt(txHash);
  if (!rc) {
    console.log('no receipt found (transaction may be pending or unknown)');
    process.exit(1);
  }
  console.log(`status=${rc.status} block=${rc.blockNumber} logs=${rc.logs.length}`);
  let n = 0;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() === cfg.mintContract.toLowerCase()) {
      describeLog(log);
      n++;
    }
  }
  if (n === 0) console.log('no logs from the mint contract in this transaction');
}

async function scanRange(fromBlock, toBlock) {
  console.log(`scanning blocks ${fromBlock}-${toBlock} for txs to ${cfg.mintContract}`);
  let mintTxs = 0;
  let mintLogs = 0;
  const byTopic = {};
  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await getBlockWithTxs(b);
    if (!block || !block.transactions) continue;
    for (const tx of block.transactions) {
      const to = typeof tx === 'object' ? tx.to : null;
      const hash = typeof tx === 'object' ? tx.hash : tx;
      if (!to || to.toLowerCase() !== cfg.mintContract.toLowerCase()) continue;
      const receipt = await getTxReceipt(hash);
      if (!receipt || receipt.status !== 1) continue;
      mintTxs++;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== cfg.mintContract.toLowerCase()) continue;
        mintLogs++;
        const t0 = (log.topics || [])[0] || '(none)';
        byTopic[t0] = (byTopic[t0] || 0) + 1;
        if (mintLogs <= 3) describeLog(log);
      }
    }
    if ((b - fromBlock) % 50 === 0) process.stdout.write(`\rblock ${b}...`);
  }
  process.stdout.write('\n');
  console.log(`direct mint txs found: ${mintTxs}, mint-contract logs: ${mintLogs}`);
  console.log('topics seen:');
  for (const [t, n] of Object.entries(byTopic)) console.log(`  ${n}x ${t}`);
  if (mintTxs === 0) {
    console.log('No direct mint txs in this window. The mint may have been idle then, or mints go through another contract (e.g. a wallet executor). Try a different window, or use --tx with a known mint transaction.');
  }
}

async function scanRangeReceipts(fromBlock, toBlock) {
  console.log(`scanning blocks ${fromBlock}-${toBlock} via eth_getBlockReceipts (catches routed mints too)`);
  let mintLogs = 0;
  const byTopic = {};
  for (let b = fromBlock; b <= toBlock; b++) {
    const receipts = await getBlockReceipts(b);
    for (const rc of receipts || []) {
      for (const log of rc.logs || []) {
        if (log.address.toLowerCase() !== cfg.mintContract.toLowerCase()) continue;
        mintLogs++;
        const t0 = (log.topics || [])[0] || '(none)';
        byTopic[t0] = (byTopic[t0] || 0) + 1;
        if (mintLogs <= 3) describeLog(log);
      }
    }
    if ((b - fromBlock) % 25 === 0) process.stdout.write(`\rblock ${b}...`);
  }
  process.stdout.write('\n');
  console.log(`mint-contract logs: ${mintLogs}`);
  console.log('topics seen:');
  for (const [t, n] of Object.entries(byTopic)) console.log(`  ${n}x ${t}`);
  if (mintLogs === 0) {
    console.log('No mint-contract logs in this window. Try a different window, or use --tx with a known mint transaction.');
  }
}

async function main() {
  const args = parseArgs();
  if (args.tx) {
    console.log(`receipt for ${args.tx}`);
    await describeTxReceipt(args.tx);
    return;
  }
  const latest = await getLatestBlock();
  const toBlock = args.to !== null ? args.to : latest;
  const fromBlock = args.from !== null ? args.from : Math.max(toBlock - args.blocks, 0);
  if (args.receipts) await scanRangeReceipts(fromBlock, toBlock);
  else await scanRange(fromBlock, toBlock);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Entry point: validate config, start the API server and the chain listener.
const { cfg, validate } = require('./config');
const { startServer } = require('./server');
const { startListener } = require('./listener');

function main() {
  const errs = validate();
  if (errs.length) {
    console.error('Configuration errors:');
    for (const e of errs) console.error('  - ' + e);
    console.error('Copy .env.example to .env and fill in the required values.');
    process.exit(1);
  }
  console.log(`[main] auto-payout starting (dryRun=${cfg.dryRun}, mint=${cfg.mintContract})`);
  startServer();
  startListener();
}

process.on('SIGINT', () => {
  console.log('\n[main] shutting down');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[main] shutting down');
  process.exit(0);
});

main();

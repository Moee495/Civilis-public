import { reputationRegistry } from '../erc8004/reputation-registry.js';

async function main(): Promise<void> {
  const submitted = await reputationRegistry.flushQueue();
  const pending = await reputationRegistry.getPendingFeedbackCount();
  console.log(JSON.stringify({ submitted, pending }));
}

main().catch((error) => {
  console.error('[ERC8004-REP] flush script failed:', error);
  process.exit(1);
});

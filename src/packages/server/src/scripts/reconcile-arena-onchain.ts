import '../config/load-env.js';
import { initDB } from '../db/postgres.js';
import { reconcileArenaMatchStates } from '../arena/reconciliation.js';
import { reconcileArenaOnchainSync, syncArenaOnchainArtifacts } from '../arena/onchain-sync.js';
import { initCivilisCommerce } from '../standards/civilis-commerce.js';
import { initERC8004 } from '../standards/erc8004.js';
import { initTreasury } from '../agents/wallet-sync.js';

function parseMatchIds(): number[] {
  const raw = process.env.ARENA_MATCH_IDS?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

async function main(): Promise<void> {
  const limit = Number(process.env.ARENA_RECONCILE_LIMIT ?? 12);
  const passes = Number(process.env.ARENA_RECONCILE_PASSES ?? 5);
  const matchIds = parseMatchIds();

  await initDB();
  await initTreasury();
  initCivilisCommerce();
  initERC8004();

  if (matchIds.length > 0) {
    await reconcileArenaMatchStates();
    for (const matchId of matchIds) {
      await syncArenaOnchainArtifacts(matchId);
      console.log(`[arena:reconcile] targeted match ${matchId} completed`);
    }
    return;
  }

  for (let pass = 1; pass <= passes; pass += 1) {
    await reconcileArenaMatchStates();
    await reconcileArenaOnchainSync(limit);
    console.log(`[arena:reconcile] pass ${pass}/${passes} completed (limit=${limit})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

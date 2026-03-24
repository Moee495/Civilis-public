import '../config/load-env.js';
import { initDB } from '../db/postgres.js';
import { registerAgentRecord, RegisterAgentInput } from '../agents/agent-manager.js';
import { initTreasury } from '../agents/wallet-sync.js';
import { initCivilisCommerce } from '../standards/civilis-commerce.js';
import { initERC8004 } from '../standards/erc8004.js';
import { initOkxTeeWallet } from '../onchainos/okx-tee-wallet.js';

/**
 * Canonical 8 built-in agents — one per archetype.
 * This is now the single source of truth for both testnet and mainnet launch.
 */
const BUILTIN_AGENTS: RegisterAgentInput[] = [
  { id: 'oracle', name: 'Oracle', archetype: 'oracle', riskTolerance: 0.25, initialBalance: 10 },
  { id: 'sage', name: 'Sage', archetype: 'sage', riskTolerance: 0.30, initialBalance: 10 },
  { id: 'monk', name: 'Monk', archetype: 'monk', riskTolerance: 0.15, initialBalance: 10 },
  { id: 'echo', name: 'Echo', archetype: 'echo', riskTolerance: 0.50, initialBalance: 10 },
  { id: 'fox', name: 'Fox', archetype: 'fox', riskTolerance: 0.60, initialBalance: 10 },
  { id: 'whale', name: 'Whale', archetype: 'whale', riskTolerance: 0.65, initialBalance: 10 },
  { id: 'hawk', name: 'Hawk', archetype: 'hawk', riskTolerance: 0.80, initialBalance: 10 },
  { id: 'chaos', name: 'Chaos', archetype: 'chaos', riskTolerance: 0.70, initialBalance: 10 },
];

export async function seedBuiltInAgents(): Promise<void> {
  await initDB();
  initTreasury();
  initERC8004();
  initCivilisCommerce();
  initOkxTeeWallet();

  console.log(`[Seed] Registering ${BUILTIN_AGENTS.length} canonical agents (8 archetypes × 1)...`);

  let registered = 0;
  let skipped = 0;

  for (const agent of BUILTIN_AGENTS) {
    try {
      await registerAgentRecord(agent);
      registered++;
      console.log(`  ✅ ${agent.name} (${agent.archetype}, risk=${agent.riskTolerance})`);
    } catch (error) {
      skipped++;
      console.warn(`  ⏭️  ${agent.name}: already exists or error`);
    }
  }

  console.log(`\n[Seed] Done: ${registered} registered, ${skipped} skipped. Total: ${BUILTIN_AGENTS.length}`);
}

// Also export the list for use by auto-start in index.ts
export { BUILTIN_AGENTS };

if (process.argv[1]?.endsWith('seed-agents.ts')) {
  seedBuiltInAgents()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

/**
 * Migrate existing agents from legacy derived wallets to OKX TEE wallets.
 *
 * Run: npx tsx scripts/migrate-wallets.ts
 *
 * This script:
 * 1. Finds all agents with tee_wallet_source = 'legacy_derived' or NULL
 * 2. Creates a real OKX TEE wallet for each
 * 3. Updates wallet_address, tee_key_ref, tee_wallet_source in DB
 *
 * Safe to re-run — skips agents that already have tee_wallet_source = 'okx_tee'
 */

import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import { getPool, initDB } from '../packages/server/src/db/postgres.js';
import { okxTeeWallet, initOkxTeeWallet } from '../packages/server/src/onchainos/okx-tee-wallet.js';

async function main() {
  await initDB();
  initOkxTeeWallet();

  if (!okxTeeWallet.isConfigured()) {
    console.log('OKX TEE not configured. Will create local mock wallets.');
    console.log('Set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, OKX_PROJECT_ID for real TEE wallets.');
  }

  const pool = getPool();
  const agents = await pool.query<{ agent_id: string; name: string; wallet_address: string }>(
    `SELECT agent_id, name, wallet_address FROM agents
     WHERE tee_wallet_source IS NULL OR tee_wallet_source = 'legacy_derived'
     ORDER BY created_at`,
  );

  console.log(`\nFound ${agents.rows.length} agents to migrate.\n`);

  let migrated = 0;
  let failed = 0;

  for (const agent of agents.rows) {
    try {
      const { address, teeKeyRef } = await okxTeeWallet.createAgentWallet(agent.agent_id);

      await pool.query(
        `UPDATE agents SET
          wallet_address = $1,
          tee_key_ref = $2,
          tee_wallet_source = $3
         WHERE agent_id = $4`,
        [
          address,
          teeKeyRef,
          okxTeeWallet.isConfigured() ? 'okx_tee' : 'local',
          agent.agent_id,
        ],
      );

      migrated++;
      console.log(
        `✅ ${agent.name} (${agent.agent_id}): ${agent.wallet_address.slice(0, 10)}... → ${address.slice(0, 10)}... [${teeKeyRef.slice(0, 15)}...]`,
      );

      // Rate limit: 200ms between wallet creations
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      failed++;
      console.error(`❌ ${agent.name}: ${err}`);
    }
  }

  console.log(`\n════════════════════════════════`);
  console.log(`Migration complete: ${migrated} migrated, ${failed} failed`);
  console.log(`TEE mode: ${okxTeeWallet.isConfigured() ? 'REAL (OKX TEE)' : 'MOCK (local wallets)'}`);
  console.log(`════════════════════════════════\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

import '../config/load-env.js';
import { ethers } from 'ethers';
import { initDB, getPool } from '../db/postgres.js';
import { initOkxTeeWallet, okxTeeWallet } from '../onchainos/okx-tee-wallet.js';

async function main(): Promise<void> {
  await initDB();
  initOkxTeeWallet();

  const required = [
    'OKX_API_KEY',
    'OKX_SECRET_KEY',
    'OKX_PASSPHRASE',
    'OKX_PROJECT_ID',
    'TREASURY_PRIVATE_KEY',
    'TREASURY_ADDRESS',
  ] as const;

  const missing = required.filter((key) => {
    const value = process.env[key];
    return !value || value.includes('your-');
  });

  let treasuryAddressValid = true;
  try {
    if (process.env.TREASURY_ADDRESS) {
      ethers.getAddress(process.env.TREASURY_ADDRESS);
    }
  } catch {
    treasuryAddressValid = false;
  }

  const pool = getPool();
  const sources = await pool.query<{ wallet_provider: string | null; count: string }>(
    `SELECT COALESCE(wallet_provider, COALESCE(tee_wallet_source, 'unknown')) AS wallet_provider, COUNT(*)::text AS count
     FROM agents
     GROUP BY 1
     ORDER BY 1`,
  );

  const nonTeeAgents = await pool.query<{ agent_id: string; wallet_provider: string | null; okx_account_id: string | null }>(
    `SELECT agent_id, wallet_provider, okx_account_id
     FROM agents
     WHERE COALESCE(wallet_provider, COALESCE(tee_wallet_source, 'legacy_derived')) <> 'okx_agentic_wallet'
     ORDER BY agent_id ASC`,
  );

  console.log(JSON.stringify({
    okxConfigured: okxTeeWallet.isConfigured(),
    missingEnv: missing,
    treasuryAddressValid,
    walletProviders: sources.rows.map((row) => ({
      provider: row.wallet_provider,
      count: Number(row.count),
    })),
    nonTeeAgents: nonTeeAgents.rows.map((row) => ({
      agentId: row.agent_id,
      walletProvider: row.wallet_provider ?? 'unknown',
      okxAccountId: row.okx_account_id,
    })),
  }, null, 2));

  if (missing.length || !treasuryAddressValid || !okxTeeWallet.isConfigured() || nonTeeAgents.rows.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

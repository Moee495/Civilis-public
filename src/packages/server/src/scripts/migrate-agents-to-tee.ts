import '../config/load-env.js';
import { ethers } from 'ethers';
import { initDB, getPool, withTransaction } from '../db/postgres.js';
import { initTreasury, creditAgentOnchainBalance } from '../agents/wallet-sync.js';
import { initOkxTeeWallet, okxTeeWallet } from '../onchainos/okx-tee-wallet.js';

type AgentRow = {
  agent_id: string;
  name: string;
  balance: string;
  wallet_address: string;
  tee_wallet_source: string | null;
  wallet_provider: string | null;
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
] as const;

async function ensureTreasuryUsdt(requiredAmount: number): Promise<void> {
  if (process.env.TEE_MIGRATE_SKIP_TREASURY_PREFLIGHT === 'true') {
    return;
  }

  const treasuryAddress = process.env.TREASURY_ADDRESS;
  const rpcUrl = process.env.X_LAYER_RPC;
  const usdtAddress = process.env.USDT_ADDRESS;

  if (!treasuryAddress || !rpcUrl || !usdtAddress) {
    throw new Error('[TEE] Missing TREASURY_ADDRESS / X_LAYER_RPC / USDT_ADDRESS for treasury preflight');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, provider);
  const balance = await usdt.balanceOf(treasuryAddress);
  const available = Number(ethers.formatUnits(balance, 6));

  if (available + 1e-9 < requiredAmount) {
    throw new Error(
      `[TEE] Treasury USDT is insufficient for migration: need ${requiredAmount.toFixed(6)}, have ${available.toFixed(6)}. Fund treasury first.`,
    );
  }
}

async function main(): Promise<void> {
  await initDB();
  initTreasury();
  initOkxTeeWallet();

  if (!okxTeeWallet.isConfigured()) {
    throw new Error('[TEE] OKX credentials are not configured');
  }

  const pool = getPool();
  const agents = await pool.query<AgentRow>(
    `SELECT agent_id, name, balance, wallet_address, tee_wallet_source, wallet_provider
     FROM agents
     WHERE is_alive = true
       AND COALESCE(wallet_provider, COALESCE(tee_wallet_source, 'legacy_derived')) <> 'okx_agentic_wallet'
     ORDER BY agent_id ASC`,
  );

  if (!agents.rows.length) {
    console.log('[TEE] All live agents already use OKX TEE');
    return;
  }

  const totalRequired = agents.rows.reduce((sum, agent) => sum + Number(agent.balance), 0);
  await ensureTreasuryUsdt(totalRequired);

  console.log(`[TEE] Migrating ${agents.rows.length} agents to OKX TEE...`);

  for (const agent of agents.rows) {
    const currentBalance = Number(agent.balance);
    const teeWallet = await okxTeeWallet.createAgentWallet(agent.agent_id);
    if (teeWallet.source !== 'okx_tee' || !teeWallet.okxAccountId) {
      throw new Error(`[TEE] ${agent.agent_id} failed to obtain a real OKX Agentic Wallet account`);
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE agents
         SET wallet_address = $1,
             tee_key_ref = $2,
             tee_wallet_source = 'okx_tee',
             wallet_provider = 'okx_agentic_wallet',
             okx_account_id = $3,
             okx_account_name = $4,
             okx_login_type = $5,
             wallet_capabilities = $6,
             wallet_provisioned_at = NOW(),
             onchain_balance = 0,
             last_sync_at = NULL
         WHERE agent_id = $7`,
        [
          teeWallet.address,
          teeWallet.teeKeyRef,
          teeWallet.okxAccountId,
          teeWallet.okxAccountName ?? null,
          teeWallet.loginType ?? 'ak',
          JSON.stringify(teeWallet.capabilities ?? []),
          agent.agent_id,
        ],
      );
    });

    if (currentBalance > 0) {
      await creditAgentOnchainBalance(teeWallet.address, currentBalance);
      await pool.query(
        `UPDATE agents
         SET onchain_balance = $1, last_sync_at = NOW()
         WHERE agent_id = $2`,
        [currentBalance.toFixed(6), agent.agent_id],
      );
    }

    console.log(
      `  ✅ ${agent.name} (${agent.agent_id}) ${agent.wallet_address} -> ${teeWallet.address} [${teeWallet.okxAccountId}]`,
    );
  }

  console.log('[TEE] Migration complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

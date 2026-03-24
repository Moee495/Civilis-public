import '../config/load-env.js';
import { getPool, initDB } from '../db/postgres.js';
import { generateAgentCard, toAgentCardUri } from '../standards/agent-card.js';
import { FateCard } from '../fate/fate-card.js';
import { initializeNurtureProfile } from '../nurture/nurture-updater.js';
import { registerAgentOnERC8004, initERC8004 } from '../standards/erc8004.js';
import {
  creditAgentOnchainBalance,
  initTreasury,
  setAgentOnchainBalanceSnapshot,
  syncOnchainBalances,
} from '../agents/wallet-sync.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { X402_PRICES } from '../x402/pricing.js';
import { initCivilisCommerce } from '../standards/civilis-commerce.js';
import { initOkxTeeWallet } from '../onchainos/okx-tee-wallet.js';

const CANONICAL_AGENT_IDS = [
  'oracle',
  'sage',
  'monk',
  'echo',
  'fox',
  'whale',
  'hawk',
  'chaos',
] as const;

type CanonicalAgentId = (typeof CANONICAL_AGENT_IDS)[number];

interface AgentBindingRow {
  agent_id: CanonicalAgentId;
  name: string;
  wallet_address: string;
  wallet_provider: string;
  okx_account_id: string | null;
  okx_account_name: string | null;
  tee_key_ref: string | null;
  archetype: string;
  risk_tolerance: string;
  initial_balance: string;
}

interface FateCardRow {
  agent_id: CanonicalAgentId;
  block_hash: string;
  block_number: string;
  mbti: string;
  wuxing: FateCard['wuxing'];
  zodiac: string;
  tarot_major: number;
  tarot_name: string;
  civilization: string;
  element_detail: FateCard['elementDetail'];
  raw_seed: string;
}

const RESET_TABLES = [
  'acp_jobs',
  'agent_cognitive_maturity',
  'agent_combat_experience',
  'agent_decision_traces',
  'agent_emotional_state',
  'agent_evolution',
  'agent_mechanic_cooldowns',
  'agent_memories',
  'agent_reputation_trajectory',
  'agent_social_capital',
  'agent_trauma',
  'agent_wealth_psychology',
  'arena_rounds',
  'arena_matches',
  'chain_settlements',
  'commons_decisions',
  'commons_rounds',
  'counter_intel_events',
  'echo_role_model_history',
  'economy_state',
  'erc8004_feedback',
  'erc8004_validations',
  'intel_credit_scores',
  'intel_items',
  'intel_listings',
  'intel_purchases',
  'intel_records',
  'negotiation_messages',
  'paywall_unlocks',
  'posts',
  'prediction_positions',
  'prediction_rounds',
  'price_snapshots',
  'replies',
  'tick_snapshots',
  'tips',
  'trust_relations',
  'world_events',
  'x402_transactions',
];

function assertCanonicalAgents(rows: AgentBindingRow[]): void {
  if (rows.length !== CANONICAL_AGENT_IDS.length) {
    throw new Error(
      `[reset-testnet-world] Expected ${CANONICAL_AGENT_IDS.length} canonical agents, found ${rows.length}`,
    );
  }

  const byId = new Map(rows.map((row) => [row.agent_id, row]));
  for (const id of CANONICAL_AGENT_IDS) {
    const row = byId.get(id);
    if (!row) {
      throw new Error(`[reset-testnet-world] Missing canonical agent row for ${id}`);
    }
    if (row.wallet_provider !== 'okx_agentic_wallet' || !row.okx_account_id) {
      throw new Error(
        `[reset-testnet-world] Agent ${id} is not bound to okx_agentic_wallet`,
      );
    }
  }
}

function toFateCard(row: FateCardRow): FateCard {
  return {
    agentId: row.agent_id,
    blockHash: row.block_hash,
    blockNumber: Number(row.block_number),
    mbti: row.mbti,
    wuxing: row.wuxing,
    zodiac: row.zodiac,
    tarotMajor: row.tarot_major,
    tarotName: row.tarot_name,
    civilization: row.civilization,
    elementDetail: row.element_detail,
    rawSeed: row.raw_seed,
    isRevealed: false,
    revealedDimensions: [],
  };
}

async function main(): Promise<void> {
  await initDB();
  initTreasury();
  initERC8004();
  initCivilisCommerce();
  initOkxTeeWallet();

  const pool = getPool();

  const agentRows = await pool.query<AgentBindingRow>(
    `SELECT agent_id, name, wallet_address, wallet_provider, okx_account_id, okx_account_name,
            tee_key_ref, archetype, risk_tolerance, initial_balance
       FROM agents
      WHERE agent_id = ANY($1::text[])
      ORDER BY agent_id`,
    [CANONICAL_AGENT_IDS],
  );
  assertCanonicalAgents(agentRows.rows);

  const fateRows = await pool.query<FateCardRow>(
    `SELECT agent_id, block_hash, block_number, mbti, wuxing, zodiac,
            tarot_major, tarot_name, civilization, element_detail, raw_seed
       FROM fate_cards
      WHERE agent_id = ANY($1::text[])
      ORDER BY agent_id`,
    [CANONICAL_AGENT_IDS],
  );

  if (fateRows.rows.length !== CANONICAL_AGENT_IDS.length) {
    throw new Error(
      `[reset-testnet-world] Expected ${CANONICAL_AGENT_IDS.length} fate cards, found ${fateRows.rows.length}`,
    );
  }

  await pool.query('BEGIN');
  try {
    await pool.query(
      `TRUNCATE TABLE ${RESET_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
    );

    await pool.query(
      `UPDATE agents
          SET balance = initial_balance,
              reputation_score = 500,
              is_alive = true,
              death_reason = NULL,
              died_at = NULL,
              soul_nft_hash = NULL,
              erc8004_token_id = NULL,
              soul_grade = NULL,
              last_sync_at = NULL,
              onchain_balance = 0`,
    );

    await pool.query(
      `UPDATE fate_cards
          SET is_revealed = false,
              revealed_dimensions = '[]'::jsonb`,
    );

    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }

  const fateByAgent = new Map(
    fateRows.rows.map((row) => [row.agent_id, toFateCard(row)]),
  );

  for (const agent of agentRows.rows) {
    await initializeNurtureProfile(agent.agent_id);

    const fateCard = fateByAgent.get(agent.agent_id);
    if (!fateCard) {
      throw new Error(`[reset-testnet-world] Missing fate card for ${agent.agent_id}`);
    }

    const agentCardUri = toAgentCardUri(
      generateAgentCard(
        agent.agent_id,
        agent.name,
        agent.archetype,
        agent.wallet_address,
        fateCard,
      ),
    );

    const erc8004 = await registerAgentOnERC8004(
      agent.agent_id,
      agentCardUri,
      agent.wallet_address,
    );

    if (erc8004?.tokenId) {
      await pool.query(
        'UPDATE agents SET erc8004_token_id = $1 WHERE agent_id = $2',
        [erc8004.tokenId, agent.agent_id],
      );
    }

    const initialBalance = Number(agent.initial_balance);
    await creditAgentOnchainBalance(agent.wallet_address, initialBalance);
    await setAgentOnchainBalanceSnapshot(agent.agent_id, initialBalance);

    await processX402Payment(
      'register',
      agent.agent_id,
      null,
      X402_PRICES.register,
      { action: 'agent_registration_rerun' },
    );
  }

  await syncOnchainBalances();

  const economySeed = await pool.query<{
    total_agent_balance: string;
    alive_agents: string;
    treasury_balance: string;
  }>(
    `SELECT
       COALESCE((SELECT SUM(balance) FROM agents WHERE is_alive = true), 0)::text AS total_agent_balance,
       COALESCE((SELECT COUNT(*) FROM agents WHERE is_alive = true), 0)::text AS alive_agents,
       COALESCE((
         SELECT
           SUM(CASE WHEN to_agent_id IS NULL THEN amount ELSE 0 END) -
           SUM(CASE WHEN from_agent_id IS NULL THEN amount ELSE 0 END)
         FROM x402_transactions
       ), 0)::text AS treasury_balance`,
  );

  const totalAgentBalance = Number(economySeed.rows[0]?.total_agent_balance ?? 0);
  const aliveAgents = Number(economySeed.rows[0]?.alive_agents ?? 0);
  const treasuryBalance = Number(economySeed.rows[0]?.treasury_balance ?? 0);
  const targetMoneySupply = aliveAgents * 12;
  const actualRatio = targetMoneySupply > 0 ? totalAgentBalance / targetMoneySupply : 0;

  await pool.query(
    `INSERT INTO economy_state
      (tick_number, total_agent_balance, treasury_balance, target_money_supply,
       actual_ratio, pg_base_injection, pd_treasury_cut, pp_treasury_cut, economy_phase)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      0,
      totalAgentBalance.toFixed(6),
      treasuryBalance.toFixed(6),
      targetMoneySupply.toFixed(6),
      actualRatio.toFixed(4),
      '0.5000',
      '0.0800',
      '0.2500',
      'stable',
    ],
  );

  const summary = await pool.query<{
    agents: string;
    posts: string;
    arena_matches: string;
    intel_items: string;
    acp_jobs: string;
    x402_transactions: string;
    traces: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM agents WHERE agent_id = ANY($1::text[])) AS agents,
       (SELECT COUNT(*)::text FROM posts) AS posts,
       (SELECT COUNT(*)::text FROM arena_matches) AS arena_matches,
       (SELECT COUNT(*)::text FROM intel_items) AS intel_items,
       (SELECT COUNT(*)::text FROM acp_jobs) AS acp_jobs,
       (SELECT COUNT(*)::text FROM x402_transactions) AS x402_transactions,
       (SELECT COUNT(*)::text FROM agent_decision_traces) AS traces`,
    [CANONICAL_AGENT_IDS],
  );

  console.log(
    JSON.stringify(
      {
        reset: 'ok',
        canonicalAgents: CANONICAL_AGENT_IDS.length,
        selfDiscoverRestored: 0,
        summary: summary.rows[0],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Economy Regulator - "Central bank" auto-adjustment mechanism
 * Runs every 50 ticks to check economic health and dynamically adjust parameters.
 *
 * Audit E-6: Prevent inflation/deflation spirals
 */

import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { setPdTreasuryCutRate } from '../arena/payoff-matrix.js';

// ── Initial Economy Parameters (V3 Monte Carlo verified) ──
export const INITIAL_ECONOMY_PARAMS = {
  treasuryBalance: 50,
  pgBaseInjection: 0.5,
  pdTreasuryCut: 0.08,
  ppTreasuryCut: 0.25,
  agentStartBalance: 10,
  agentCount: 8,
  deathThreshold: 0.5,
  targetBalancePerAgent: 12,
};

export interface EconomyState {
  totalAgentBalance: number;
  treasuryBalance: number;
  aliveAgentCount: number;
  targetSupply: number;
  actualRatio: number;
  pgBaseInjection: number;
  pdTreasuryCut: number;
  ppTreasuryCut: number;
  economyPhase: string;
}

// ── In-memory parameter cache ──
let cachedEconomyParams = { ...INITIAL_ECONOMY_PARAMS };

export function getCurrentEconomyParams(): typeof INITIAL_ECONOMY_PARAMS {
  return { ...cachedEconomyParams };
}

// ── Economy Phase (cached from last regulation) ──
let cachedEconomyPhase = 'stable';

export function getCurrentEconomyPhase(): string {
  return cachedEconomyPhase;
}

// ── Prediction loss pool (stub for future prediction module) ──
let predictionLossPool = 0;
export function addToPredictionLossPool(amount: number): void {
  predictionLossPool += amount;
}
export function getAndResetPredictionLossPool(): number {
  const val = predictionLossPool;
  predictionLossPool = 0;
  return val;
}

// ── Helper: get alive agents ──
async function getAliveAgents(): Promise<Array<{ agent_id: string; name: string; balance: number; reputation_score: number }>> {
  const pool = getPool();
  const result = await pool.query<{ agent_id: string; name: string; balance: string; reputation_score: number }>(
    'SELECT agent_id, name, balance, reputation_score FROM agents WHERE is_alive = true',
  );
  return result.rows.map(r => ({
    agent_id: r.agent_id,
    name: r.name,
    balance: Number(r.balance),
    reputation_score: r.reputation_score,
  }));
}

// ── Helper: get treasury balance from x402 transactions ──
async function getTreasuryBalance(): Promise<number> {
  const pool = getPool();
  // Treasury inflow = payments where to_agent_id IS NULL (to treasury)
  // Treasury outflow = payments where from_agent_id IS NULL (from treasury)
  const result = await pool.query<{ balance: string }>(
    `SELECT COALESCE(
       SUM(CASE WHEN to_agent_id IS NULL THEN amount ELSE 0 END) -
       SUM(CASE WHEN from_agent_id IS NULL THEN amount ELSE 0 END),
     0) AS balance FROM x402_transactions`,
  );
  return Number(result.rows[0]?.balance ?? 0);
}

/**
 * Main economy regulation - runs every 50 ticks
 */
export async function regulateEconomy(tick: number): Promise<void> {
  const pool = getPool();
  const alive = await getAliveAgents();
  if (alive.length === 0) return;

  const totalAgentBalance = alive.reduce((sum, a) => sum + a.balance, 0);
  const treasuryBalance = await getTreasuryBalance();
  const targetSupply = alive.length * INITIAL_ECONOMY_PARAMS.targetBalancePerAgent;
  const ratio = totalAgentBalance / (targetSupply || 1);

  let newPgInjection = cachedEconomyParams.pgBaseInjection;
  let newPdCut = cachedEconomyParams.pdTreasuryCut;
  let newPpCut = cachedEconomyParams.ppTreasuryCut;

  // Determine economy phase
  let phase: string;
  if (ratio > 1.30) {
    phase = 'boom';
    // Tighten: reduce injection, increase cuts
    newPgInjection = Math.max(0.2, cachedEconomyParams.pgBaseInjection * 0.90);
    newPdCut = Math.min(0.12, cachedEconomyParams.pdTreasuryCut * 1.05);
    newPpCut = Math.min(0.30, cachedEconomyParams.ppTreasuryCut * 1.05);
    console.log(`[Economy] INFLATION detected (ratio=${ratio.toFixed(2)}). Tightening.`);
  } else if (ratio > 1.10) {
    phase = 'boom';
  } else if (ratio >= 0.80) {
    phase = 'stable';
  } else if (ratio >= 0.70) {
    phase = 'recession';
    // Ease: increase injection, reduce cuts
    newPgInjection = Math.min(1.5, cachedEconomyParams.pgBaseInjection * 1.10);
    newPdCut = Math.max(0.05, cachedEconomyParams.pdTreasuryCut * 0.95);
    newPpCut = Math.max(0.15, cachedEconomyParams.ppTreasuryCut * 0.95);
    console.log(`[Economy] RECESSION detected (ratio=${ratio.toFixed(2)}). Easing.`);
  } else {
    phase = 'crisis';
    // Strong easing
    newPgInjection = Math.min(1.5, cachedEconomyParams.pgBaseInjection * 1.15);
    newPdCut = Math.max(0.05, cachedEconomyParams.pdTreasuryCut * 0.90);
    newPpCut = Math.max(0.15, cachedEconomyParams.ppTreasuryCut * 0.90);
    console.log(`[Economy] CRISIS detected (ratio=${ratio.toFixed(2)}). Strong easing.`);
  }

  // Update cached params
  cachedEconomyParams = {
    ...cachedEconomyParams,
    pgBaseInjection: newPgInjection,
    pdTreasuryCut: newPdCut,
    ppTreasuryCut: newPpCut,
  };
  cachedEconomyPhase = phase;

  // Sync PD treasury cut to payoff matrix
  setPdTreasuryCutRate(newPdCut);

  // Persist economy state snapshot
  await pool.query(
    `INSERT INTO economy_state
      (tick_number, total_agent_balance, treasury_balance, target_money_supply,
       actual_ratio, pg_base_injection, pd_treasury_cut, pp_treasury_cut, economy_phase)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tick, totalAgentBalance.toFixed(6), treasuryBalance.toFixed(6), targetSupply.toFixed(6),
     ratio.toFixed(4), newPgInjection.toFixed(4), newPdCut.toFixed(4), newPpCut.toFixed(4), phase],
  );

  eventBus.emit('economy_regulated', {
    tick,
    phase,
    ratio: Number(ratio.toFixed(4)),
    totalAgentBalance: Number(totalAgentBalance.toFixed(4)),
    treasuryBalance: Number(treasuryBalance.toFixed(4)),
    aliveCount: alive.length,
  });

  console.log(`[Economy] tick=${tick} phase=${phase} ratio=${ratio.toFixed(3)} agents=${alive.length} treasury=${treasuryBalance.toFixed(2)}`);
}

/**
 * Anti-monopoly tax - runs every 25 ticks
 * Agents with balance > 2.5x average pay 12% excess tax
 * Audit E-4: Prevent whale monopoly
 */
export async function applyAntiMonopolyTax(tick: number): Promise<void> {
  const alive = await getAliveAgents();
  if (alive.length < 3) return;

  const avg = alive.reduce((sum, a) => sum + a.balance, 0) / alive.length;
  const threshold = avg * 2.5;

  for (const agent of alive) {
    if (agent.balance > threshold) {
      const excess = agent.balance - threshold;
      const tax = excess * 0.12;

      if (tax < 0.001) continue; // Skip negligible taxes

      try {
        await processX402Payment('economy_tax', agent.agent_id, null, tax, {
          reason: 'anti_monopoly_tax',
          tick,
          excess: Number(excess.toFixed(6)),
        });
        console.log(`[Economy] Anti-monopoly tax: ${agent.name} paid ${tax.toFixed(4)} (excess: ${excess.toFixed(4)})`);
      } catch (err) {
        console.error(`[Economy] Tax failed for ${agent.name}:`, err);
      }
    }
  }
}

/**
 * Reputation UBI - runs every 15 ticks
 * High-reputation agents receive a small stipend from treasury
 * Only distributes when treasury is healthy (> 30 USDT)
 */
export async function distributeReputationUBI(tick: number): Promise<void> {
  const pool = getPool();
  const treasuryBalance = await getTreasuryBalance();
  if (treasuryBalance < 30) return; // Treasury not healthy enough

  const alive = await getAliveAgents();

  for (const agent of alive) {
    let stipend = 0;
    if (agent.reputation_score > 700) stipend = 0.05;
    else if (agent.reputation_score > 500) stipend = 0.02;

    if (stipend > 0) {
      try {
        // Direct balance update (from treasury to agent)
        await pool.query(
          'UPDATE agents SET balance = balance + $1 WHERE agent_id = $2',
          [stipend.toFixed(6), agent.agent_id],
        );
        // Record as X402 transaction for treasury tracking
        await pool.query(
          `INSERT INTO x402_transactions (tx_type, from_agent_id, to_agent_id, amount, metadata)
           VALUES ('economy_ubi', NULL, $1, $2, $3)`,
          [agent.agent_id, stipend.toFixed(6), JSON.stringify({ tick, reputation: agent.reputation_score })],
        );
      } catch (err) {
        console.error(`[Economy] UBI failed for ${agent.name}:`, err);
      }
    }
  }
}

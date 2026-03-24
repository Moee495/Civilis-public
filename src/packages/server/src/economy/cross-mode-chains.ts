/**
 * Cross-Mode Causal Chains
 *
 * These functions form the "glue" between PD ↔ Commons ↔ Price Prediction.
 * All three game modes are now live — stubs replaced with real implementations.
 */

import { getPool } from '../db/postgres.js';

// ── FUNCTIONAL: Economy Phase → PD Cooperation Impact ──

export function getEconomyImpactOnPD(economyPhase: string): number {
  switch (economyPhase) {
    case 'boom':      return +0.10;
    case 'stable':    return +0.02;
    case 'recession': return -0.08;
    case 'crisis':    return -0.15;
    default:          return 0;
  }
}

// ── FUNCTIONAL: PD Trust Impact on Commons ──

/**
 * PD betrayal history affects commons contribution willingness.
 * Being betrayed frequently → less willing to contribute to public goods.
 * Betraying others frequently → others less willing to contribute around you.
 */
export async function getPDTrustImpactOnCommons(agentId: string): Promise<{
  myContributeDelta: number;
  othersContributeDelta: number;
}> {
  const pool = getPool();

  // Query last 10 settled PD matches involving this agent
  const matches = await pool.query<{
    player_a_id: string; player_b_id: string;
    player_a_action: string; player_b_action: string;
  }>(
    `SELECT player_a_id, player_b_id, player_a_action, player_b_action
     FROM arena_matches
     WHERE status = 'settled'
       AND (player_a_id = $1 OR player_b_id = $1)
     ORDER BY settled_at DESC LIMIT 10`,
    [agentId],
  );

  if (matches.rows.length === 0) {
    return { myContributeDelta: 0, othersContributeDelta: 0 };
  }

  let betrayedCount = 0;   // times I was betrayed
  let betrayingCount = 0;  // times I betrayed

  for (const m of matches.rows) {
    const isA = m.player_a_id === agentId;
    const myAction = isA ? m.player_a_action : m.player_b_action;
    const theirAction = isA ? m.player_b_action : m.player_a_action;

    if (myAction === 'cooperate' && theirAction === 'betray') betrayedCount++;
    if (myAction === 'betray') betrayingCount++;
  }

  const total = matches.rows.length;
  // Being betrayed → I become less willing to contribute (trauma)
  const myContributeDelta = -(betrayedCount / total) * 0.15;
  // I betray others → they're less willing to contribute when I'm around
  const othersContributeDelta = -(betrayingCount / total) * 0.10;

  return { myContributeDelta, othersContributeDelta };
}

// ── FUNCTIONAL: Prediction Impact on PD ──

/**
 * Recent prediction P&L affects PD strategy.
 * Big win → relaxed → more cooperative
 * Big loss → desperate → more likely to betray
 */
export async function getPredictionImpactOnPD(agentId: string): Promise<number> {
  const pool = getPool();

  const result = await pool.query<{ total_pnl: string; round_count: string }>(
    `SELECT COALESCE(SUM(final_pnl), 0) as total_pnl, COUNT(*) as round_count
     FROM prediction_positions
     WHERE agent_id = $1 AND final_pnl IS NOT NULL
       AND created_at > NOW() - INTERVAL '1 hour'`,
    [agentId],
  );

  const pnl = Number(result.rows[0]?.total_pnl ?? 0);
  const count = Number(result.rows[0]?.round_count ?? 0);
  if (count === 0) return 0;

  // Big win → +0.10 coop bonus, big loss → -0.12 coop penalty
  if (pnl > 0.5) return +0.10;
  if (pnl > 0.1) return +0.05;
  if (pnl < -0.5) return -0.12;
  if (pnl < -0.1) return -0.06;
  return 0;
}

// ── FUNCTIONAL: Intel from Trusted Agents ──

/**
 * Fox can leverage PD-built trust relationships to get prediction intel from trusted agents.
 * Trust > 70 → can see trusted agent's current prediction direction.
 */
export async function getIntelFromTrustedAgents(
  agentId: string,
): Promise<Array<{ agentId: string; chosenCoin: string; positionType: string }>> {
  const pool = getPool();

  // Find trusted agents (trust > 70) who have active prediction positions
  const result = await pool.query<{
    agent_id: string; chosen_coin: string; position_type: string;
  }>(
    `SELECT pp.agent_id, pp.chosen_coin, pp.position_type
     FROM prediction_positions pp
     JOIN trust_relations tr ON tr.to_agent_id = pp.agent_id
     JOIN prediction_rounds pr ON pr.id = pp.round_id
     WHERE tr.from_agent_id = $1
       AND tr.trust_score > 70
       AND pr.phase IN ('predicting', 'waiting')
       AND pp.agent_id != $1`,
    [agentId],
  );

  return result.rows.map(r => ({
    agentId: r.agent_id,
    chosenCoin: r.chosen_coin,
    positionType: r.position_type,
  }));
}

// ── FUNCTIONAL: Economy Phase Impact on Commons ──

export function getEconomyImpactOnCommons(economyPhase: string): {
  contributeBonus: number;
  hoardBonus: number;
} {
  switch (economyPhase) {
    case 'boom':      return { contributeBonus: 0.10, hoardBonus: -0.10 };
    case 'stable':    return { contributeBonus: 0.02, hoardBonus: 0 };
    case 'recession': return { contributeBonus: -0.05, hoardBonus: 0.05 };
    case 'crisis':    return { contributeBonus: -0.15, hoardBonus: 0.10 };
    default:          return { contributeBonus: 0, hoardBonus: 0 };
  }
}

// ── FUNCTIONAL: Economy Phase Impact on Prediction ──

export function getEconomyImpactOnPrediction(economyPhase: string): {
  longBigBonus: number;
  hedgeBonus: number;
} {
  switch (economyPhase) {
    case 'boom':      return { longBigBonus: 0.10, hedgeBonus: -0.10 };
    case 'crisis':    return { longBigBonus: -0.10, hedgeBonus: 0.20 };
    default:          return { longBigBonus: 0, hedgeBonus: 0 };
  }
}

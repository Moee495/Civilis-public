/**
 * Intel Market — Impact on Game Decisions
 * Purchased intel modifies PD, Commons, and Prediction decision probabilities.
 */

import { getPool } from '../db/postgres.js';

/**
 * PD: Returns cooperation probability delta based on held intel about opponent.
 */
export async function getIntelImpactOnPD(
  agentId: string,
  opponentId: string,
): Promise<{ cooperateDelta: number }> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT ii.category, ii.content, ii.accuracy, ii.freshness
    FROM intel_purchases ip
    JOIN intel_items ii ON ip.intel_item_id = ii.id
    WHERE ip.buyer_agent_id = $1
      AND (ii.subject_agent_id = $2 OR ii.subject_agent_id IS NULL)
      AND ii.freshness > 0.05
      AND ii.category IN ('behavior_pattern', 'fate_dimension', 'relationship_map')
  `, [agentId, opponentId]);

  let delta = 0;

  for (const intel of result.rows) {
    const impact = intel.freshness * intel.accuracy;
    const data = intel.content?.data || {};

    if (intel.category === 'behavior_pattern') {
      if (data.nextMovePrediction === 'likely_cooperate') delta += 0.15 * impact;
      if (data.nextMovePrediction === 'likely_betray') delta -= 0.20 * impact;
    }
    if (intel.category === 'relationship_map') {
      const trust = parseFloat(data.trustScore ?? 50);
      if (trust > 60) delta += 0.08 * impact;
      if (trust < 30) delta -= 0.08 * impact;
    }
  }

  // Self-knowledge boost: more known dimensions → more precise decision
  const selfKnowledge = await pool.query(
    `SELECT dimension FROM intel_records WHERE subject_agent_id = $1 AND knower_agent_id = $1 AND source_type = 'self_discover'`,
    [agentId]
  );
  const selfBoost = selfKnowledge.rows.length * 0.02;
  delta = delta * (1 + selfBoost);

  return { cooperateDelta: Math.max(-0.25, Math.min(0.25, delta)) };
}

/**
 * Commons: Returns contribute/hoard probability deltas based on held intel.
 */
export async function getIntelImpactOnCommons(
  agentId: string,
): Promise<{ contributeDelta: number; hoardDelta: number }> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT ii.category, ii.content, ii.accuracy, ii.freshness
    FROM intel_purchases ip
    JOIN intel_items ii ON ip.intel_item_id = ii.id
    WHERE ip.buyer_agent_id = $1
      AND ii.freshness > 0.05
      AND ii.category IN ('economic_forecast', 'behavior_pattern', 'counter_intel')
  `, [agentId]);

  let contributeDelta = 0;
  let hoardDelta = 0;

  for (const intel of result.rows) {
    const impact = intel.freshness * intel.accuracy;
    const data = intel.content?.data || {};

    if (intel.category === 'economic_forecast') {
      if (data.forecastPhase === 'boom') contributeDelta += 0.10 * impact;
      if (data.forecastPhase === 'crisis') hoardDelta += 0.15 * impact;
      if (data.forecastPhase === 'recession') hoardDelta += 0.08 * impact;
    }
    if (intel.category === 'behavior_pattern') {
      if (data.commonsTendency === 'sabotage') hoardDelta += 0.12 * impact;
    }
  }

  return {
    contributeDelta: Math.max(-0.20, Math.min(0.20, contributeDelta)),
    hoardDelta: Math.max(-0.15, Math.min(0.20, hoardDelta)),
  };
}

/**
 * Prediction: Returns coin preference and position aggression deltas.
 */
export async function getIntelImpactOnPrediction(
  agentId: string,
  coinA: string,
  coinB: string,
): Promise<{ preferCoinA: number; positionAggression: number }> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT ii.category, ii.content, ii.accuracy, ii.freshness
    FROM intel_purchases ip
    JOIN intel_items ii ON ip.intel_item_id = ii.id
    WHERE ip.buyer_agent_id = $1
      AND ii.freshness > 0.05
      AND ii.category IN ('price_signal', 'behavior_pattern')
  `, [agentId]);

  let preferCoinA = 0;
  let positionAggression = 0;

  for (const intel of result.rows) {
    const impact = intel.freshness * intel.accuracy;
    const data = intel.content?.data || {};

    if (intel.category === 'price_signal') {
      const signal = String(data.signal ?? '');
      if (data.pair === coinA && signal.includes('bullish')) preferCoinA += 0.3 * impact;
      if (data.pair === coinA && signal.includes('bearish')) preferCoinA -= 0.3 * impact;
      if (data.pair === coinB && signal.includes('bullish')) preferCoinA -= 0.3 * impact;
      if (data.pair === coinB && signal.includes('bearish')) preferCoinA += 0.3 * impact;
    }
    if (intel.category === 'behavior_pattern') {
      if (String(data.predictionPref ?? '').includes('big')) positionAggression += 0.2 * impact;
      if (data.predictionPref === 'hedge') positionAggression -= 0.2 * impact;
    }
  }

  return {
    preferCoinA: Math.max(-0.5, Math.min(0.5, preferCoinA)),
    positionAggression: Math.max(-0.5, Math.min(0.5, positionAggression)),
  };
}

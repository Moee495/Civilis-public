/**
 * Intel Market — Accuracy Verification
 * Called after Commons/Prediction settlements to verify intel accuracy.
 */

import { getPool } from '../db/postgres.js';
import { verifyIntelOnChain } from '../erc8183/hooks/intel-hook.js';
import { INTEL_CONSENSUS_VERIFICATION_THRESHOLD } from './intel-types.js';

/**
 * Verify economic_forecast intel after Commons settlement.
 */
export async function verifyCommonsIntel(
  actualCoopRate: number,
  actualPhase: string,
  tickNumber: number,
): Promise<void> {
  const pool = getPool();

  const forecasts = await pool.query<{
    id: number;
    producer_agent_id: string;
    content: any;
    is_fake: boolean;
    buyer_count: number;
    verified_accuracy: string | number | null;
    validation_status: string | null;
  }>(
    `SELECT i.id, i.producer_agent_id, i.content, i.is_fake, i.buyer_count, i.verified_accuracy,
            v.status AS validation_status
     FROM intel_items i
     LEFT JOIN LATERAL (
       SELECT status
       FROM erc8004_validations
       WHERE intel_item_id = i.id
       ORDER BY id DESC
       LIMIT 1
     ) v ON true
     WHERE i.category = 'economic_forecast'
       AND (i.created_at_tick >= $1 - 20 OR v.status IS NOT NULL)
       AND (
         i.verified_accuracy IS NULL
         OR (
           COALESCE(i.buyer_count, 0) >= $2
           AND COALESCE(v.status, 'pending') <> 'responded'
         )
       )`,
    [tickNumber, INTEL_CONSENSUS_VERIFICATION_THRESHOLD],
  );

  let processed = 0;

  for (const item of forecasts.rows) {
    const predicted = item.content?.data?.forecastPhase;
    if (!predicted) continue;

    let acc = item.verified_accuracy === null ? null : Number(item.verified_accuracy);
    if (acc === null) {
      const phaseOrder = ['crisis', 'recession', 'stable', 'boom'];
      const predIdx = phaseOrder.indexOf(predicted);
      const actIdx = phaseOrder.indexOf(actualPhase);
      acc = 0;
      if (predIdx === actIdx) acc = 1.0;
      else if (Math.abs(predIdx - actIdx) === 1) acc = 0.5;

      await pool.query('UPDATE intel_items SET verified_accuracy = $1 WHERE id = $2', [acc, item.id]);
    }

    if ((item.buyer_count ?? 0) >= INTEL_CONSENSUS_VERIFICATION_THRESHOLD && item.validation_status !== 'responded') {
      await verifyIntelOnChain({
        itemId: item.id,
        producerAgentId: item.producer_agent_id,
        verifiedAccuracy: acc,
        isFake: Boolean(item.is_fake) && acc < 0.3,
        verifiedByCount: Number(item.buyer_count ?? 0),
      });
    }

    await applyVerificationConsequences(pool, item.producer_agent_id, Boolean(item.is_fake), acc);

    processed++;
  }

  if (processed > 0) {
    console.log(`[Intel] Processed ${processed} economic forecasts at tick ${tickNumber}`);
    await updateCreditScores(pool);
  }

  await verifyStaticIntel(tickNumber);
}

/**
 * Verify price_signal intel after Prediction settlement.
 */
export async function verifyPredictionIntel(
  coinA: string,
  coinB: string,
  actualWinner: string,
  tickNumber: number,
): Promise<void> {
  const pool = getPool();

  const signals = await pool.query<{
    id: number;
    producer_agent_id: string;
    content: any;
    is_fake: boolean;
    buyer_count: number;
    verified_accuracy: string | number | null;
    validation_status: string | null;
  }>(
    `SELECT i.id, i.producer_agent_id, i.content, i.is_fake, i.buyer_count, i.verified_accuracy,
            v.status AS validation_status
     FROM intel_items i
     LEFT JOIN LATERAL (
       SELECT status
       FROM erc8004_validations
       WHERE intel_item_id = i.id
       ORDER BY id DESC
       LIMIT 1
     ) v ON true
     WHERE i.category = 'price_signal'
       AND (i.created_at_tick >= $1 - 20 OR v.status IS NOT NULL)
       AND (
         i.verified_accuracy IS NULL
         OR (
           COALESCE(i.buyer_count, 0) >= $2
           AND COALESCE(v.status, 'pending') <> 'responded'
         )
       )`,
    [tickNumber, INTEL_CONSENSUS_VERIFICATION_THRESHOLD],
  );

  let processed = 0;

  for (const item of signals.rows) {
    const signal = String(item.content?.data?.signal ?? '');
    const pair = item.content?.data?.pair ?? '';

    let acc = item.verified_accuracy === null ? null : Number(item.verified_accuracy);
    if (acc === null) {
      acc = 0.5;
      if (pair === coinA && signal.includes('bullish') && actualWinner === 'coin_a') acc = 1.0;
      if (pair === coinA && signal.includes('bearish') && actualWinner === 'coin_b') acc = 1.0;
      if (pair === coinA && signal.includes('bullish') && actualWinner === 'coin_b') acc = 0;
      if (pair === coinA && signal.includes('bearish') && actualWinner === 'coin_a') acc = 0;

      await pool.query('UPDATE intel_items SET verified_accuracy = $1 WHERE id = $2', [acc, item.id]);
    }

    if ((item.buyer_count ?? 0) >= INTEL_CONSENSUS_VERIFICATION_THRESHOLD && item.validation_status !== 'responded') {
      await verifyIntelOnChain({
        itemId: item.id,
        producerAgentId: item.producer_agent_id,
        verifiedAccuracy: acc,
        isFake: Boolean(item.is_fake) && acc < 0.3,
        verifiedByCount: Number(item.buyer_count ?? 0),
      });
    }

    await applyVerificationConsequences(pool, item.producer_agent_id, Boolean(item.is_fake), acc);

    processed++;
  }

  if (processed > 0) {
    console.log(`[Intel] Processed ${processed} price signals at tick ${tickNumber}`);
    await updateCreditScores(pool);
  }

  await verifyStaticIntel(tickNumber);
}

export async function verifyStaticIntel(tickNumber: number): Promise<void> {
  const pool = getPool();
  const items = await pool.query<{
    id: number;
    category: string;
    producer_agent_id: string;
    content: any;
    is_fake: boolean;
    buyer_count: number;
    created_at_tick: number;
    verified_accuracy: string | number | null;
    validation_status: string | null;
  }>(
    `SELECT i.id, i.category, i.producer_agent_id, i.content, i.is_fake, i.buyer_count,
            i.created_at_tick, i.verified_accuracy, v.status AS validation_status
     FROM intel_items i
     LEFT JOIN LATERAL (
       SELECT status
       FROM erc8004_validations
       WHERE intel_item_id = i.id
       ORDER BY id DESC
       LIMIT 1
     ) v ON true
     WHERE i.category IN ('behavior_pattern', 'relationship_map', 'counter_intel', 'fate_dimension')
       AND (i.created_at_tick >= $1 - 20 OR v.status IS NOT NULL)
       AND (
         i.verified_accuracy IS NULL
         OR (
           COALESCE(i.buyer_count, 0) >= $2
           AND COALESCE(v.status, 'pending') <> 'responded'
         )
       )`,
    [tickNumber, INTEL_CONSENSUS_VERIFICATION_THRESHOLD],
  );

  let processed = 0;

  for (const item of items.rows) {
    let acc = item.verified_accuracy === null ? null : Number(item.verified_accuracy);
    if (acc === null) {
      acc = await computeStaticIntelAccuracy(pool, item);
      if (acc === null) {
        continue;
      }

      await pool.query('UPDATE intel_items SET verified_accuracy = $1 WHERE id = $2', [acc, item.id]);
    }

    if ((item.buyer_count ?? 0) >= INTEL_CONSENSUS_VERIFICATION_THRESHOLD && item.validation_status !== 'responded') {
      await verifyIntelOnChain({
        itemId: item.id,
        producerAgentId: item.producer_agent_id,
        verifiedAccuracy: acc,
        isFake: Boolean(item.is_fake) && acc < 0.3,
        verifiedByCount: Number(item.buyer_count ?? 0),
      });
    }

    await applyVerificationConsequences(pool, item.producer_agent_id, Boolean(item.is_fake), acc);
    processed++;
  }

  if (processed > 0) {
    console.log(`[Intel] Processed ${processed} static intel items at tick ${tickNumber}`);
    await updateCreditScores(pool);
  }
}

async function computeStaticIntelAccuracy(
  pool: import('pg').Pool,
  item: {
    category: string;
    producer_agent_id: string;
    content: any;
    created_at_tick: number;
  },
): Promise<number | null> {
  switch (item.category) {
    case 'behavior_pattern':
      return computeBehaviorPatternAccuracy(pool, item);
    case 'relationship_map':
      return computeRelationshipMapAccuracy(pool, item);
    case 'counter_intel':
      return computeCounterIntelAccuracy(pool, item);
    case 'fate_dimension':
      return computeFateDimensionAccuracy(pool, item);
    default:
      return null;
  }
}

async function computeBehaviorPatternAccuracy(
  pool: import('pg').Pool,
  item: { content: any },
): Promise<number | null> {
  const targetId = item.content?.data?.targetId;
  if (!targetId) return null;

  const pdResult = await pool.query<{ player_a_action: string; player_b_action: string; player_a_id: string }>(
    `SELECT player_a_action, player_b_action, player_a_id
     FROM arena_matches
     WHERE status = 'settled'
       AND (player_a_id = $1 OR player_b_id = $1)
     ORDER BY settled_at DESC
     LIMIT 10`,
    [targetId],
  );

  let coopCount = 0;
  let totalCount = 0;
  for (const match of pdResult.rows) {
    const action = match.player_a_id === targetId ? match.player_a_action : match.player_b_action;
    if (action) {
      totalCount++;
      if (action === 'cooperate') coopCount++;
    }
  }
  const actualCoopRate = totalCount > 0 ? coopCount / totalCount : 0.5;

  const commonsResult = await pool.query<{ decision: string }>(
    `SELECT cd.decision
     FROM commons_decisions cd
     JOIN commons_rounds cr ON cd.round_id = cr.id
     WHERE cd.agent_id = $1
     ORDER BY cr.round_number DESC
     LIMIT 5`,
    [targetId],
  );
  const actualCommonsTendency = commonsResult.rows.length > 0
    ? mostFrequent(commonsResult.rows.map((row) => row.decision))
    : 'contribute';

  const reportedCoopRate = Math.max(0, Math.min(1, Number(item.content?.data?.pdCoopRate ?? 0.5)));
  const coopScore = 1 - Math.min(1, Math.abs(reportedCoopRate - actualCoopRate));
  const tendencyScore = item.content?.data?.commonsTendency === actualCommonsTendency ? 1 : 0;
  return Number((coopScore * 0.7 + tendencyScore * 0.3).toFixed(4));
}

async function computeRelationshipMapAccuracy(
  pool: import('pg').Pool,
  item: { content: any },
): Promise<number | null> {
  const targetId = item.content?.data?.targetId;
  if (!targetId) return null;

  const trustResult = await pool.query<{ to_agent_id: string; trust_score: number }>(
    `SELECT to_agent_id, trust_score
     FROM trust_relations
     WHERE from_agent_id = $1
     ORDER BY trust_score DESC
     LIMIT 3`,
    [targetId],
  );

  const actualTopIds = trustResult.rows.map((row) => row.to_agent_id);
  const actualAllies = trustResult.rows.filter((row) => row.trust_score > 50).length;
  const actualEnemies = trustResult.rows.filter((row) => row.trust_score < 30).length;
  const reportedTopIds = Array.isArray(item.content?.data?.topRelations)
    ? item.content.data.topRelations
        .map((row: any) => String(row?.to_agent_id ?? ''))
        .filter(Boolean)
    : [];

  const overlap = reportedTopIds.filter((id: string) => actualTopIds.includes(id)).length;
  const relationScore = actualTopIds.length > 0 ? overlap / actualTopIds.length : reportedTopIds.length === 0 ? 1 : 0;
  const allyDiff = Math.abs(Number(item.content?.data?.allyCount ?? 0) - actualAllies);
  const enemyDiff = Math.abs(Number(item.content?.data?.enemyCount ?? 0) - actualEnemies);
  const countScore = 1 - Math.min(1, (allyDiff + enemyDiff) / 3);

  return Number((relationScore * 0.7 + countScore * 0.3).toFixed(4));
}

async function computeCounterIntelAccuracy(
  pool: import('pg').Pool,
  item: { content: any; created_at_tick: number },
): Promise<number | null> {
  const fromTick = Math.max(0, item.created_at_tick - 20);
  const toTick = item.created_at_tick;

  const spyResult = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM counter_intel_events
     WHERE tick_number BETWEEN $1 AND $2`,
    [fromTick, toTick],
  );
  const purchaseResult = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM intel_purchases
     WHERE purchased_at_tick BETWEEN $1 AND $2`,
    [fromTick, toTick],
  );

  const actualSpyCount = Number(spyResult.rows[0]?.cnt ?? 0);
  const actualPurchaseCount = Number(purchaseResult.rows[0]?.cnt ?? 0);
  const reportedSpyCount = Array.isArray(item.content?.data?.recentSpyEvents) ? item.content.data.recentSpyEvents.length : 0;
  const reportedPurchaseCount = Array.isArray(item.content?.data?.recentPurchases) ? item.content.data.recentPurchases.length : 0;
  const actualHasActivity = actualSpyCount > 0 || actualPurchaseCount > 0;
  const reportedHasActivity = Boolean(item.content?.data?.hasActivity);

  const spyScore = 1 - Math.min(1, Math.abs(reportedSpyCount - actualSpyCount) / 5);
  const purchaseScore = 1 - Math.min(1, Math.abs(reportedPurchaseCount - actualPurchaseCount) / 5);
  const activityScore = actualHasActivity === reportedHasActivity ? 1 : 0;

  return Number((spyScore * 0.45 + purchaseScore * 0.45 + activityScore * 0.1).toFixed(4));
}

async function computeFateDimensionAccuracy(
  pool: import('pg').Pool,
  item: { producer_agent_id: string; content: any },
): Promise<number | null> {
  const targetId = item.content?.data?.targetId;
  if (!targetId) return null;

  const knownResult = await pool.query<{ dimension: string }>(
    `SELECT dimension
     FROM intel_records
     WHERE subject_agent_id = $1
       AND knower_agent_id = $2`,
    [targetId, item.producer_agent_id],
  );

  const actualDimensions = knownResult.rows.map((row) => row.dimension);
  const reportedDimensions = Array.isArray(item.content?.data?.knownDimensions)
    ? item.content.data.knownDimensions.map((dimension: unknown) => String(dimension))
    : [];
  const union = new Set([...actualDimensions, ...reportedDimensions]);
  const intersection = reportedDimensions.filter((dimension: string) => actualDimensions.includes(dimension)).length;
  const jaccard = union.size > 0 ? intersection / union.size : 1;
  const countScore = 1 - Math.min(1, Math.abs(Number(item.content?.data?.dimensionCount ?? 0) - actualDimensions.length) / 5);

  return Number((jaccard * 0.8 + countScore * 0.2).toFixed(4));
}

async function applyVerificationConsequences(
  pool: import('pg').Pool,
  producerAgentId: string,
  isFake: boolean,
  accuracy: number,
): Promise<void> {
  if (isFake && accuracy < 0.3) {
    await pool.query(
      'UPDATE agents SET reputation_score = GREATEST(0, reputation_score - 30) WHERE agent_id = $1',
      [producerAgentId],
    );
    return;
  }

  if (!isFake && accuracy > 0.7) {
    await pool.query(
      'UPDATE agents SET reputation_score = LEAST(1000, reputation_score + 5) WHERE agent_id = $1',
      [producerAgentId],
    );
  }
}

function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'contribute';
}

/**
 * Recalculate credit scores for all producers.
 */
async function updateCreditScores(pool: import('pg').Pool): Promise<void> {
  try {
    await pool.query(`
      INSERT INTO intel_credit_scores (agent_id, total_produced, total_verified, average_accuracy, fake_count, credit_score, tier, updated_at)
      SELECT
        producer_agent_id,
        COUNT(*) as total_produced,
        COUNT(*) FILTER (WHERE verified_accuracy IS NOT NULL) as total_verified,
        COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) as average_accuracy,
        COUNT(*) FILTER (WHERE is_fake = true) as fake_count,
        GREATEST(0, LEAST(100,
          50
          + (COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) - 0.5) * 80
          - COUNT(*) FILTER (WHERE is_fake = true) * 8
        )) as credit_score,
        CASE
          WHEN GREATEST(0, LEAST(100, 50 + (COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) - 0.5) * 80 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 80 THEN 'elite'
          WHEN GREATEST(0, LEAST(100, 50 + (COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) - 0.5) * 80 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 60 THEN 'trusted'
          WHEN GREATEST(0, LEAST(100, 50 + (COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) - 0.5) * 80 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 40 THEN 'neutral'
          WHEN GREATEST(0, LEAST(100, 50 + (COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) - 0.5) * 80 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 20 THEN 'suspicious'
          ELSE 'blacklisted'
        END as tier,
        NOW()
      FROM intel_items
      GROUP BY producer_agent_id
      ON CONFLICT (agent_id) DO UPDATE SET
        total_produced = EXCLUDED.total_produced,
        total_verified = EXCLUDED.total_verified,
        average_accuracy = EXCLUDED.average_accuracy,
        fake_count = EXCLUDED.fake_count,
        credit_score = EXCLUDED.credit_score,
        tier = EXCLUDED.tier,
        updated_at = NOW()
    `);
  } catch (err) {
    console.error('[Intel] Credit score update failed:', err);
  }
}

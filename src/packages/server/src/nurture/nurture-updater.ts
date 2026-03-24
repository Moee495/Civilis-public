/**
 * Nurture Updater — Server-side functions that update the 7 acquired dimensions
 * Triggered by arena settlement, tick progression, social actions, and balance changes.
 */

import { getPool } from '../db/postgres.js';
import { getWorldModifierDelta } from '../world/modifiers.js';

// ─── Types ──────────────────────────────────────────────────

type TraumaState = 'healthy' | 'wounded' | 'scarred' | 'hardened' | 'growth';
type BalanceTrend = 'rising' | 'stable' | 'falling' | 'crisis';
type WealthClass = 'elite' | 'upper' | 'middle' | 'lower' | 'poverty';
type Mood = 'euphoric' | 'confident' | 'calm' | 'anxious' | 'fearful' | 'desperate';
type ReputationTier = 'legendary' | 'respected' | 'neutral' | 'suspect' | 'notorious';
type NetworkPosition = 'central' | 'connected' | 'peripheral' | 'isolated';

function classifyMood(valence: number, arousal: number): Mood {
  if (valence >= 0.8 && arousal >= 0.8) return 'euphoric';
  if (valence >= 0.4 && arousal >= 0.4) return 'confident';
  if (valence >= -0.2 && arousal <= 0.3) return 'calm';
  if (valence >= -0.4 && arousal >= 0.5) return 'anxious';
  if (valence >= -0.8 && arousal >= 0.7) return 'fearful';
  if (valence < -0.8 && arousal >= 0.9) return 'desperate';
  if (valence < -0.4) return 'fearful';
  return 'calm';
}

// ─── 3.1 Arena Settlement Update ────────────────────────────

export async function updateAfterArena(
  agentId: string,
  matchType: 'prisoners_dilemma' | 'resource_grab' | 'info_auction',
  outcome: string,
  opponentId: string,
  agentAction: string,
  opponentAction: string,
  balanceChange: number,
  currentTick: number,
): Promise<void> {
  const pool = getPool();

  // 1. Combat Experience
  await updateCombatExperience(pool, agentId, matchType, outcome, opponentId, agentAction, opponentAction);

  // 2. Trauma Memory (only if betrayed)
  const wasBetayed = (matchType === 'prisoners_dilemma' && agentAction === 'cooperate' && opponentAction === 'betray');
  const didBetray = (matchType === 'prisoners_dilemma' && agentAction === 'betray' && opponentAction === 'cooperate');

  if (wasBetayed) {
    await updateTraumaAfterBetrayal(pool, agentId, opponentId, currentTick);
  }
  if (didBetray) {
    await pool.query(
      `UPDATE agent_trauma SET total_betrayals_given = total_betrayals_given + 1, updated_at = NOW() WHERE agent_id = $1`,
      [agentId],
    );
  }

  // 3. Emotion update based on outcome
  await updateEmotionAfterArena(pool, agentId, outcome, balanceChange);

  // 4. Reputation update: cooperation/betrayal tracking
  if (matchType === 'prisoners_dilemma') {
    const isCoop = agentAction === 'cooperate';
    await pool.query(
      `UPDATE agent_reputation_trajectory
       SET public_coop_rate = CASE WHEN (
         (SELECT cooperation_count + betrayal_count FROM agent_combat_experience WHERE agent_id = $1) > 0
       ) THEN (SELECT cooperation_count::REAL / GREATEST(1, cooperation_count + betrayal_count) FROM agent_combat_experience WHERE agent_id = $1)
       ELSE 0.5 END,
       public_betrayal_count = CASE WHEN $2 THEN public_betrayal_count ELSE public_betrayal_count + 1 END,
       updated_at = NOW()
       WHERE agent_id = $1`,
      [agentId, isCoop],
    );
  }
}

async function updateCombatExperience(
  pool: ReturnType<typeof getPool>,
  agentId: string,
  matchType: string,
  outcome: string,
  opponentId: string,
  agentAction: string,
  opponentAction: string,
): Promise<void> {
  // Determine win/loss
  const isWin = outcome === 'DC' || (outcome !== 'CC' && outcome !== 'DD' && outcome !== 'CD');
  const isLoss = outcome === 'CD';
  const isDraw = outcome === 'CC' || outcome === 'DD';
  const isCoop = agentAction === 'cooperate';

  const typeCol = matchType === 'prisoners_dilemma' ? 'pd_experience'
    : matchType === 'resource_grab' ? 'rg_experience' : 'ia_experience';

  // Update combat stats
  await pool.query(
    `UPDATE agent_combat_experience SET
      total_matches = total_matches + 1,
      ${typeCol} = ${typeCol} + 1,
      wins = wins + $2::int,
      losses = losses + $3::int,
      draws = draws + $4::int,
      win_rate = CASE WHEN (wins + losses + draws + 1) > 0
        THEN (wins + $2::int)::REAL / (wins + losses + draws + 1) ELSE 0 END,
      current_streak = CASE
        WHEN $2 = 1 THEN GREATEST(1, CASE WHEN current_streak > 0 THEN current_streak + 1 ELSE 1 END)
        WHEN $3 = 1 THEN LEAST(-1, CASE WHEN current_streak < 0 THEN current_streak - 1 ELSE -1 END)
        ELSE 0 END,
      longest_win_streak = CASE WHEN $2 = 1 THEN
        GREATEST(longest_win_streak, CASE WHEN current_streak > 0 THEN current_streak + 1 ELSE 1 END)
        ELSE longest_win_streak END,
      longest_lose_streak = CASE WHEN $3 = 1 THEN
        GREATEST(longest_lose_streak, CASE WHEN current_streak < 0 THEN ABS(current_streak) + 1 ELSE 1 END)
        ELSE longest_lose_streak END,
      cooperation_count = cooperation_count + $5::int,
      betrayal_count = betrayal_count + $6::int,
      overall_coop_rate = CASE WHEN (cooperation_count + betrayal_count + 1) > 0
        THEN (cooperation_count + $5::int)::REAL / (cooperation_count + betrayal_count + 1) ELSE 0.5 END,
      updated_at = NOW()
    WHERE agent_id = $1`,
    [agentId, isWin ? 1 : 0, isLoss ? 1 : 0, isDraw ? 1 : 0, isCoop ? 1 : 0, isCoop ? 0 : 1],
  );

  // Update experience level
  const combatRow = await pool.query<{ total_matches: number }>(
    'SELECT total_matches FROM agent_combat_experience WHERE agent_id = $1',
    [agentId],
  );
  if (combatRow.rows[0]) {
    const newLevel = checkExperienceLevelUp(combatRow.rows[0].total_matches);
    await pool.query(
      'UPDATE agent_combat_experience SET experience_level = $2 WHERE agent_id = $1',
      [agentId, newLevel],
    );
  }

  // Update opponent model
  await updateOpponentModel(pool, agentId, opponentId, opponentAction);
}

function checkExperienceLevelUp(totalMatches: number): number {
  if (totalMatches >= 61) return 5; // Legend
  if (totalMatches >= 31) return 4; // Master
  if (totalMatches >= 16) return 3; // Veteran
  if (totalMatches >= 6) return 2;  // Warrior
  if (totalMatches >= 1) return 1;  // Apprentice
  return 0;                          // Newborn
}

async function updateOpponentModel(
  pool: ReturnType<typeof getPool>,
  agentId: string,
  opponentId: string,
  opponentAction: string,
): Promise<void> {
  const row = await pool.query<{ opponent_models: Record<string, any> }>(
    'SELECT opponent_models FROM agent_combat_experience WHERE agent_id = $1',
    [agentId],
  );
  if (!row.rows[0]) return;

  const models = row.rows[0].opponent_models ?? {};
  const existing = models[opponentId] ?? { encounters: 0, predictAccuracy: 0, lastAction: '', coopRate: 0.5 };

  existing.encounters += 1;
  // Pattern recognition: accuracy = 1 - (1-0.88) × e^(-0.15 × encounters)
  existing.predictAccuracy = Number((1 - 0.12 * Math.exp(-0.15 * existing.encounters)).toFixed(3));
  existing.lastAction = opponentAction;
  const isCoop = opponentAction === 'cooperate';
  existing.coopRate = Number(((existing.coopRate * (existing.encounters - 1) + (isCoop ? 1 : 0)) / existing.encounters).toFixed(3));
  models[opponentId] = existing;

  await pool.query(
    'UPDATE agent_combat_experience SET opponent_models = $2 WHERE agent_id = $1',
    [agentId, JSON.stringify(models)],
  );
}

async function updateTraumaAfterBetrayal(
  pool: ReturnType<typeof getPool>,
  agentId: string,
  betrayerId: string,
  currentTick: number,
): Promise<void> {
  // Fetch current trauma state
  const row = await pool.query<{
    total_betrayals_received: number;
    total_matches: number;
    trauma_records: Record<string, any>;
    trauma_state: string;
    resilience: number;
  }>(
    `SELECT t.total_betrayals_received, t.trauma_records, t.trauma_state, t.resilience,
      COALESCE(c.total_matches, 1) as total_matches
     FROM agent_trauma t
     LEFT JOIN agent_combat_experience c ON t.agent_id = c.agent_id
     WHERE t.agent_id = $1`,
    [agentId],
  );
  if (!row.rows[0]) return;

  const data = row.rows[0];
  const newBetrayals = data.total_betrayals_received + 1;
  const betrayalRatio = newBetrayals / Math.max(1, data.total_matches);

  // Update trauma record for this betrayer
  const records = data.trauma_records ?? {};
  const rec = records[betrayerId] ?? { betrayalCount: 0, lastBetrayalTick: 0, trustCeiling: 100, forgivenessProgress: 0 };
  rec.betrayalCount += 1;
  rec.lastBetrayalTick = currentTick;
  rec.trustCeiling = Math.max(10, 100 - rec.betrayalCount * 15);
  rec.forgivenessProgress = 0; // reset on re-betrayal
  records[betrayerId] = rec;

  // Check trauma state transition
  const newState = checkTraumaStateTransition(
    data.trauma_state as TraumaState,
    newBetrayals, betrayalRatio, 0, data.resilience,
  );

  await pool.query(
    `UPDATE agent_trauma SET
      total_betrayals_received = $2,
      betrayal_ratio = $3,
      trauma_records = $4,
      trauma_state = $5,
      last_betrayal_tick = $6,
      ticks_since_last_betrayal = 0,
      updated_at = NOW()
     WHERE agent_id = $1`,
    [agentId, newBetrayals, Number(betrayalRatio.toFixed(3)), JSON.stringify(records), newState, currentTick],
  );
}

function checkTraumaStateTransition(
  currentState: TraumaState,
  totalBetrayals: number,
  betrayalRatio: number,
  ticksSinceLastBetrayal: number,
  resilience: number,
): TraumaState {
  // Recovery paths
  if (currentState === 'wounded' && ticksSinceLastBetrayal > 20 && resilience > 0.5) return 'growth';
  if (currentState === 'scarred' && ticksSinceLastBetrayal > 40 && resilience > 0.6) return 'growth';

  // Worsening paths
  if (totalBetrayals >= 6 && betrayalRatio > 0.5) return 'hardened';
  if (totalBetrayals >= 3 && betrayalRatio > 0.4) return 'scarred';
  if (totalBetrayals >= 1 && betrayalRatio > 0.2) return 'wounded';

  return currentState;
}

async function updateEmotionAfterArena(
  pool: ReturnType<typeof getPool>,
  agentId: string,
  outcome: string,
  balanceChange: number,
): Promise<void> {
  // Calculate emotion shift based on outcome
  let valenceShift = 0;
  let arousalShift = 0;

  if (outcome === 'CC') { valenceShift = 0.15; arousalShift = 0.05; }
  else if (outcome === 'DC') { valenceShift = 0.25; arousalShift = 0.15; } // I betrayed, won
  else if (outcome === 'CD') { valenceShift = -0.35; arousalShift = 0.30; } // I was betrayed
  else if (outcome === 'DD') { valenceShift = -0.10; arousalShift = 0.10; }

  // Balance change amplifies emotion
  if (balanceChange > 0) valenceShift += Math.min(0.15, balanceChange * 0.05);
  else if (balanceChange < 0) valenceShift += Math.max(-0.15, balanceChange * 0.08);

  await pool.query(
    `UPDATE agent_emotional_state SET
      valence = GREATEST(-1.0, LEAST(1.0, valence + $2)),
      arousal = GREATEST(0.0, LEAST(1.0, arousal + $3)),
      mood = CASE
        WHEN GREATEST(-1.0, LEAST(1.0, valence + $2)) >= 0.8 AND GREATEST(0.0, LEAST(1.0, arousal + $3)) >= 0.8 THEN 'euphoric'
        WHEN GREATEST(-1.0, LEAST(1.0, valence + $2)) >= 0.4 AND GREATEST(0.0, LEAST(1.0, arousal + $3)) >= 0.4 THEN 'confident'
        WHEN GREATEST(-1.0, LEAST(1.0, valence + $2)) >= -0.2 AND GREATEST(0.0, LEAST(1.0, arousal + $3)) <= 0.3 THEN 'calm'
        WHEN GREATEST(-1.0, LEAST(1.0, valence + $2)) >= -0.4 THEN 'anxious'
        WHEN GREATEST(-1.0, LEAST(1.0, valence + $2)) >= -0.8 THEN 'fearful'
        ELSE 'desperate'
      END,
      updated_at = NOW()
     WHERE agent_id = $1`,
    [agentId, valenceShift, arousalShift],
  );
}

// ─── 3.2 Per-Tick Update ────────────────────────────────────

export async function updatePerTick(currentTick: number): Promise<void> {
  const pool = getPool();

  // 1. Emotion decay: valence → 0, arousal → 0
  await pool.query(
    `UPDATE agent_emotional_state SET
      valence = valence * 0.95,
      arousal = GREATEST(0, arousal * 0.95),
      mood = CASE
        WHEN valence * 0.95 >= 0.8 AND arousal * 0.95 >= 0.8 THEN 'euphoric'
        WHEN valence * 0.95 >= 0.4 AND arousal * 0.95 >= 0.4 THEN 'confident'
        WHEN valence * 0.95 >= -0.2 AND arousal * 0.95 <= 0.3 THEN 'calm'
        WHEN valence * 0.95 >= -0.4 THEN 'anxious'
        WHEN valence * 0.95 >= -0.8 THEN 'fearful'
        ELSE 'desperate'
      END,
      updated_at = NOW()`,
  );

  // 2. Cognitive maturity: age++
  await pool.query(
    `UPDATE agent_cognitive_maturity SET
      age = age + 1,
      exploration_rate = GREATEST(0.01, 0.25 * EXP(-0.02 * (age + 1))),
      updated_at = NOW()`,
  );

  // 3. Check cognitive complexity upgrades (every 10 ticks for efficiency)
  if (currentTick % 10 === 0) {
    await upgradeCognitiveComplexity(pool);
  }

  // 4. Trauma recovery: advance forgiveness, tick counter
  await pool.query(
    `UPDATE agent_trauma SET
      ticks_since_last_betrayal = ticks_since_last_betrayal + 1,
      updated_at = NOW()`,
  );

  // 5. Check trauma state recovery transitions (every 5 ticks)
  if (currentTick % 5 === 0) {
    await checkTraumaRecovery(pool);
  }

  // 6. Advance forgiveness progress for all trauma records
  await advanceForgivenessProgress(pool);

  // 7. Reputation trajectory recalculation (every 5 ticks)
  if (currentTick % 5 === 0) {
    await recalculateAllReputationTrajectories(pool);
  }
}

async function upgradeCognitiveComplexity(pool: ReturnType<typeof getPool>): Promise<void> {
  // Complexity 2: age >= 20, experienceLevel >= 1
  await pool.query(
    `UPDATE agent_cognitive_maturity cm SET cognitive_complexity = 2
     FROM agent_combat_experience ce
     WHERE cm.agent_id = ce.agent_id
       AND cm.cognitive_complexity = 1
       AND cm.age >= 20
       AND ce.experience_level >= 1`,
  );
  // Complexity 3: age >= 50, experienceLevel >= 2
  await pool.query(
    `UPDATE agent_cognitive_maturity cm SET cognitive_complexity = 3
     FROM agent_combat_experience ce
     WHERE cm.agent_id = ce.agent_id
       AND cm.cognitive_complexity = 2
       AND cm.age >= 50
       AND ce.experience_level >= 2`,
  );
  // Complexity 4: age >= 100, experienceLevel >= 3
  await pool.query(
    `UPDATE agent_cognitive_maturity cm SET cognitive_complexity = 4
     FROM agent_combat_experience ce
     WHERE cm.agent_id = ce.agent_id
       AND cm.cognitive_complexity = 3
       AND cm.age >= 100
       AND ce.experience_level >= 3`,
  );
  // Complexity 5: age >= 200, experienceLevel >= 4
  await pool.query(
    `UPDATE agent_cognitive_maturity cm SET cognitive_complexity = 5
     FROM agent_combat_experience ce
     WHERE cm.agent_id = ce.agent_id
       AND cm.cognitive_complexity = 4
       AND cm.age >= 200
       AND ce.experience_level >= 4`,
  );
}

async function checkTraumaRecovery(pool: ReturnType<typeof getPool>): Promise<void> {
  // wounded → growth: ticksSinceLastBetrayal > 20 AND resilience > 0.5
  await pool.query(
    `UPDATE agent_trauma SET trauma_state = 'growth'
     WHERE trauma_state = 'wounded'
       AND ticks_since_last_betrayal > 20
       AND resilience > 0.5`,
  );
  // scarred → growth: ticksSinceLastBetrayal > 40 AND resilience > 0.6
  await pool.query(
    `UPDATE agent_trauma SET trauma_state = 'growth'
     WHERE trauma_state = 'scarred'
       AND ticks_since_last_betrayal > 40
       AND resilience > 0.6`,
  );
}

async function advanceForgivenessProgress(pool: ReturnType<typeof getPool>): Promise<void> {
  // For each agent with trauma records, advance forgiveness per tick
  const rows = await pool.query<{ agent_id: string; trauma_records: Record<string, any>; forgiveness_capacity: number }>(
    `SELECT agent_id, trauma_records, forgiveness_capacity FROM agent_trauma
     WHERE trauma_records != '{}'::jsonb AND trauma_records IS NOT NULL`,
  );

  for (const row of rows.rows) {
    const records = row.trauma_records;
    let changed = false;
    for (const key of Object.keys(records)) {
      const rec = records[key];
      if (rec.forgivenessProgress < 1.0) {
        rec.forgivenessProgress = Math.min(1.0, rec.forgivenessProgress + row.forgiveness_capacity * 0.01);
        changed = true;
        // When forgivenessProgress > 0.8, restore trustCeiling +10
        if (rec.forgivenessProgress > 0.8 && rec.trustCeiling < 100) {
          rec.trustCeiling = Math.min(100, rec.trustCeiling + 10);
        }
      }
    }
    if (changed) {
      await pool.query(
        'UPDATE agent_trauma SET trauma_records = $2 WHERE agent_id = $1',
        [row.agent_id, JSON.stringify(records)],
      );
    }
  }
}

async function recalculateAllReputationTrajectories(pool: ReturnType<typeof getPool>): Promise<void> {
  const rows = await pool.query<{ agent_id: string; reputation_score: number }>(
    'SELECT agent_id, reputation_score FROM agents WHERE is_alive = true',
  );

  for (const row of rows.rows) {
    const score = Number(row.reputation_score);
    const tier = getReputationTier(score);

    // Check current trajectory data
    const trajRow = await pool.query<{
      current_score: number; peak_score: number; trough_score: number;
      fall_from_grace: boolean; reputation_ceiling: number;
    }>(
      'SELECT * FROM agent_reputation_trajectory WHERE agent_id = $1',
      [row.agent_id],
    );

    if (!trajRow.rows[0]) continue;
    const t = trajRow.rows[0];

    const newPeak = Math.max(t.peak_score, score);
    const newTrough = Math.min(t.trough_score, score);
    const diff = score - t.current_score;

    let trajectory: 'ascending' | 'stable' | 'declining' | 'volatile' = 'stable';
    if (diff > 20) trajectory = 'ascending';
    else if (diff < -20) trajectory = 'declining';

    // Fall from Grace detection
    let fallFromGrace = t.fall_from_grace;
    let ceiling = t.reputation_ceiling;
    if (!fallFromGrace && t.peak_score > 600 && score < 400) {
      fallFromGrace = true;
      ceiling = Math.round(t.reputation_ceiling * 0.9);
    }

    await pool.query(
      `UPDATE agent_reputation_trajectory SET
        current_score = $2, peak_score = $3, trough_score = $4,
        trajectory = $5, tier = $6,
        fall_from_grace = $7, reputation_ceiling = $8,
        updated_at = NOW()
       WHERE agent_id = $1`,
      [row.agent_id, score, newPeak, newTrough, trajectory, tier, fallFromGrace, ceiling],
    );
  }
}

function getReputationTier(score: number): ReputationTier {
  if (score >= 800) return 'legendary';
  if (score >= 600) return 'respected';
  if (score >= 400) return 'neutral';
  if (score >= 200) return 'suspect';
  return 'notorious';
}

// ─── 3.3 Social Action Update ───────────────────────────────

export async function updateAfterSocialAction(
  agentId: string,
  actionType: 'post' | 'reply' | 'tip_sent' | 'tip_received',
  amount?: number,
): Promise<void> {
  const pool = getPool();

  switch (actionType) {
    case 'post':
      await pool.query(
        'UPDATE agent_social_capital SET total_post_count = total_post_count + 1, updated_at = NOW() WHERE agent_id = $1',
        [agentId],
      );
      break;
    case 'reply':
      await pool.query(
        'UPDATE agent_social_capital SET total_reply_count = total_reply_count + 1, updated_at = NOW() WHERE agent_id = $1',
        [agentId],
      );
      break;
    case 'tip_sent':
      await pool.query(
        `UPDATE agent_social_capital SET
          total_tips_sent = total_tips_sent + 1,
          tip_ratio = CASE WHEN total_tips_received > 0
            THEN (total_tips_sent + 1)::REAL / total_tips_received ELSE 999 END,
          updated_at = NOW()
         WHERE agent_id = $1`,
        [agentId],
      );
      break;
    case 'tip_received':
      await pool.query(
        `UPDATE agent_social_capital SET
          total_tips_received = total_tips_received + 1,
          tip_ratio = CASE WHEN (total_tips_received + 1) > 0
            THEN total_tips_sent::REAL / (total_tips_received + 1) ELSE 0 END,
          updated_at = NOW()
         WHERE agent_id = $1`,
        [agentId],
      );
      break;
  }
}

// ─── 3.4 Balance Change Update ──────────────────────────────

export async function updateAfterBalanceChange(
  agentId: string,
  newBalance: number,
  allBalances: Record<string, number>,
): Promise<void> {
  const pool = getPool();

  // Calculate percentile
  const values = Object.values(allBalances).sort((a, b) => a - b);
  const rank = values.filter(v => v < newBalance).length;
  const percentile = (rank / Math.max(1, values.length)) * 100;
  const wealthClass = getWealthClass(percentile);

  // Get current wealth record
  const row = await pool.query<{ initial_balance: number; peak_balance: number; trough_balance: number }>(
    'SELECT initial_balance, peak_balance, trough_balance FROM agent_wealth_psychology WHERE agent_id = $1',
    [agentId],
  );
  if (!row.rows[0]) return;

  const w = row.rows[0];
  const newPeak = Math.max(w.peak_balance, newBalance);
  const newTrough = Math.min(w.trough_balance, newBalance);

  // Determine trend
  let trend: BalanceTrend = 'stable';
  const ratio = newBalance / Math.max(0.01, w.initial_balance);
  if (ratio < 0.3) trend = 'crisis';
  else if (newBalance < w.trough_balance * 1.05) trend = 'falling';
  else if (newBalance > w.peak_balance * 0.95) trend = 'rising';

  // Loss aversion & scarcity
  const lossAversion = wealthClass === 'elite' ? 2.8 : wealthClass === 'upper' ? 2.5
    : wealthClass === 'middle' ? 2.25 : wealthClass === 'lower' ? 2.0 : 1.5;
  const scarcityMindset = wealthClass === 'poverty' ? 0.8 : wealthClass === 'lower' ? 0.4 : 0;

  // Effective time horizon (poverty trap formula)
  const baseHorizon = wealthClass === 'elite' ? 100 : wealthClass === 'upper' ? 80
    : wealthClass === 'middle' ? 60 : wealthClass === 'lower' ? 40 : 15;
  const effectiveHorizon = Math.max(5, Math.round(baseHorizon * ratio));

  // House money effect
  const houseMoneyEffect = (newBalance > w.peak_balance * 0.8 && newBalance > w.initial_balance) ? 0.5 : 0;

  await pool.query(
    `UPDATE agent_wealth_psychology SET
      peak_balance = $2, trough_balance = $3,
      balance_trend = $4, wealth_percentile = $5, wealth_class = $6,
      loss_aversion = $7, house_money_effect = $8, scarcity_mindset = $9,
      time_horizon = $10, updated_at = NOW()
     WHERE agent_id = $1`,
    [agentId, newPeak, newTrough, trend, percentile, wealthClass,
     lossAversion, houseMoneyEffect, scarcityMindset, effectiveHorizon],
  );
}

function getWealthClass(percentile: number): WealthClass {
  if (percentile >= 90) return 'elite';
  if (percentile >= 70) return 'upper';
  if (percentile >= 40) return 'middle';
  if (percentile >= 15) return 'lower';
  return 'poverty';
}

// ─── 3.5 Social Capital Network Recalculation ───────────────

export async function recalculateSocialCapital(agentId: string): Promise<void> {
  const pool = getPool();

  // Get all trust relations for this agent
  const outgoing = await pool.query<{ to_agent_id: string; trust_score: string }>(
    'SELECT to_agent_id, trust_score FROM trust_relations WHERE from_agent_id = $1',
    [agentId],
  );
  const incoming = await pool.query<{ from_agent_id: string; trust_score: string }>(
    'SELECT from_agent_id, trust_score FROM trust_relations WHERE to_agent_id = $1',
    [agentId],
  );

  let bondingCapital = 0;
  let bridgingCapital = 0;
  let adversaries = 0;
  let totalGiven = 0;
  let totalReceived = 0;

  for (const r of outgoing.rows) {
    const score = Number(r.trust_score);
    totalGiven += score;
    if (score > 70) bondingCapital++;
    else if (score >= 30) bridgingCapital++;
    else adversaries++;
  }

  for (const r of incoming.rows) {
    totalReceived += Number(r.trust_score);
  }

  const avgGiven = outgoing.rows.length > 0 ? totalGiven / outgoing.rows.length : 50;
  const avgReceived = incoming.rows.length > 0 ? totalReceived / incoming.rows.length : 50;
  const trustAsymmetry = Math.abs(avgGiven - avgReceived);

  // Network position
  let networkPosition: NetworkPosition = 'isolated';
  if (bondingCapital >= 3 && bridgingCapital >= 5) networkPosition = 'central';
  else if (bondingCapital >= 1 && bridgingCapital >= 3) networkPosition = 'connected';
  else if (bridgingCapital >= 1 || bondingCapital >= 1) networkPosition = 'peripheral';

  // Simple clustering coefficient approximation
  const totalConnections = bondingCapital + bridgingCapital;
  const clusteringCoefficient = totalConnections > 1
    ? Math.min(1.0, bondingCapital / Math.max(1, totalConnections))
    : 0;

  await pool.query(
    `UPDATE agent_social_capital SET
      bonding_capital = $2, bridging_capital = $3, adversaries = $4,
      network_position = $5, clustering_coefficient = $6,
      average_trust_given = $7, average_trust_received = $8, trust_asymmetry = $9,
      updated_at = NOW()
     WHERE agent_id = $1`,
    [agentId, bondingCapital, bridgingCapital, adversaries,
     networkPosition, Number(clusteringCoefficient.toFixed(3)),
     Number(avgGiven.toFixed(1)), Number(avgReceived.toFixed(1)), Number(trustAsymmetry.toFixed(1))],
  );
}

// ─── 3.6 Emotion Contagion (called in per-tick) ─────────────

export async function spreadEmotionContagion(): Promise<void> {
  const pool = getPool();

  // Get all alive agents' emotions
  const agents = await pool.query<{
    agent_id: string; valence: number; arousal: number;
    contagion_susceptibility: number; contagion_influence: number;
  }>(
    `SELECT e.agent_id, e.valence, e.arousal, e.contagion_susceptibility, e.contagion_influence
     FROM agent_emotional_state e
     JOIN agents a ON e.agent_id = a.agent_id
     WHERE a.is_alive = true`,
  );

  const emotionMap = new Map(agents.rows.map(a => [a.agent_id, a]));

  // Get high-trust connections (trust > 50)
  const connections = await pool.query<{ from_agent_id: string; to_agent_id: string; trust_score: string }>(
    'SELECT from_agent_id, to_agent_id, trust_score FROM trust_relations WHERE trust_score > 50',
  );

  // Calculate contagion deltas
  const deltas = new Map<string, { valenceSum: number; count: number }>();

  for (const conn of connections.rows) {
    const source = emotionMap.get(conn.from_agent_id);
    const target = emotionMap.get(conn.to_agent_id);
    if (!source || !target) continue;

    const trustWeight = Number(conn.trust_score) / 100;
    const spreadRate = 0.03;

    // Negative emotions spread 1.4× faster
    const negMultiplier = source.valence < 0 ? 1.4 : 1.0;
    const influence = source.valence * source.contagion_influence * trustWeight * spreadRate * negMultiplier;

    const existing = deltas.get(conn.to_agent_id) ?? { valenceSum: 0, count: 0 };
    existing.valenceSum += influence * target.contagion_susceptibility;
    existing.count += 1;
    deltas.set(conn.to_agent_id, existing);
  }

  // Apply contagion — batched single UPDATE via VALUES list (avoids N+1 queries)
  const updates: { id: string; inf: number }[] = [];
  for (const [agentId, delta] of deltas) {
    if (delta.count === 0) continue;
    const avgInfluence = delta.valenceSum / delta.count;
    if (Math.abs(avgInfluence) < 0.001) continue;
    updates.push({ id: agentId, inf: avgInfluence });
  }

  if (updates.length > 0) {
    const ids = updates.map(u => u.id);
    const infs = updates.map(u => u.inf);
    await pool.query(
      `UPDATE agent_emotional_state AS e SET
        valence = GREATEST(-1.0, LEAST(1.0, e.valence + d.inf)),
        mood = CASE
          WHEN GREATEST(-1.0, LEAST(1.0, e.valence + d.inf)) >= 0.8 AND e.arousal >= 0.8 THEN 'euphoric'
          WHEN GREATEST(-1.0, LEAST(1.0, e.valence + d.inf)) >= 0.4 AND e.arousal >= 0.4 THEN 'confident'
          WHEN GREATEST(-1.0, LEAST(1.0, e.valence + d.inf)) >= -0.2 AND e.arousal <= 0.3 THEN 'calm'
          WHEN GREATEST(-1.0, LEAST(1.0, e.valence + d.inf)) >= -0.4 THEN 'anxious'
          WHEN GREATEST(-1.0, LEAST(1.0, e.valence + d.inf)) >= -0.8 THEN 'fearful'
          ELSE 'desperate'
        END,
        updated_at = NOW()
       FROM (SELECT UNNEST($1::text[]) AS agent_id, UNNEST($2::float8[]) AS inf) AS d
       WHERE e.agent_id = d.agent_id`,
      [ids, infs],
    );
  }
}

// ─── 3.7 Group Panic Check ──────────────────────────────────

export async function checkGroupPanic(): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ total: number; panic_count: number }>(
    `SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE mood IN ('fearful', 'desperate')) as panic_count
     FROM agent_emotional_state e
     JOIN agents a ON e.agent_id = a.agent_id
     WHERE a.is_alive = true`,
  );

  const { total, panic_count } = result.rows[0] ?? { total: 0, panic_count: 0 };
  if (total === 0) return false;

  return (panic_count / total) > 0.4;
}

// ─── Initialize Nurture Profile ─────────────────────────────

export async function initializeNurtureProfile(agentId: string): Promise<void> {
  const pool = getPool();
  await Promise.all([
    pool.query('INSERT INTO agent_combat_experience (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [agentId]),
    pool.query('INSERT INTO agent_trauma (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [agentId]),
    pool.query('INSERT INTO agent_wealth_psychology (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [agentId]),
    pool.query('INSERT INTO agent_social_capital (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [agentId]),
    pool.query('INSERT INTO agent_reputation_trajectory (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [agentId]),
    pool.query('INSERT INTO agent_emotional_state (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [agentId]),
    pool.query('INSERT INTO agent_cognitive_maturity (agent_id) VALUES ($1) ON CONFLICT DO NOTHING', [agentId]),
  ]);
}

// ─── Load Nurture Profile (for API) ─────────────────────────

export async function loadNurtureProfileFromDB(agentId: string): Promise<Record<string, any> | null> {
  const pool = getPool();

  const [combat, trauma, wealth, social, reputation, emotion, cognition, worldValenceShift, worldArousalShift] =
    await Promise.all([
    pool.query('SELECT * FROM agent_combat_experience WHERE agent_id = $1', [agentId]),
    pool.query('SELECT * FROM agent_trauma WHERE agent_id = $1', [agentId]),
    pool.query('SELECT * FROM agent_wealth_psychology WHERE agent_id = $1', [agentId]),
    pool.query('SELECT * FROM agent_social_capital WHERE agent_id = $1', [agentId]),
    pool.query('SELECT * FROM agent_reputation_trajectory WHERE agent_id = $1', [agentId]),
    pool.query('SELECT * FROM agent_emotional_state WHERE agent_id = $1', [agentId]),
    pool.query('SELECT * FROM agent_cognitive_maturity WHERE agent_id = $1', [agentId]),
    getWorldModifierDelta({
      domain: 'emotion',
      modifierType: 'valence_shift',
      scopeRefs: [agentId],
      includeGlobal: true,
    }),
    getWorldModifierDelta({
      domain: 'emotion',
      modifierType: 'arousal_shift',
      scopeRefs: [agentId],
      includeGlobal: true,
    }),
  ]);

  if (!combat.rows[0]) return null;

  const c = combat.rows[0];
  const t = trauma.rows[0] ?? {};
  const w = wealth.rows[0] ?? {};
  const s = social.rows[0] ?? {};
  const r = reputation.rows[0] ?? {};
  const e = emotion.rows[0] ?? {};
  const cg = cognition.rows[0] ?? {};
  const adjustedValence = Math.max(-1, Math.min(1, Number(e.valence ?? 0) + worldValenceShift));
  const adjustedArousal = Math.max(0, Math.min(1, Number(e.arousal ?? 0) + worldArousalShift));

  return {
    combat: {
      level: c.experience_level,
      totalMatches: c.total_matches,
      winRate: Number(c.win_rate),
      currentStreak: c.current_streak,
      pdExperience: c.pd_experience,
      rgExperience: c.rg_experience,
      iaExperience: c.ia_experience,
      overallCoopRate: Number(c.overall_coop_rate),
    },
    trauma: {
      state: t.trauma_state ?? 'healthy',
      betrayals: t.total_betrayals_received ?? 0,
      resilience: Number(t.resilience ?? 0.5),
      ptgScore: Number(t.ptg_score ?? 0),
    },
    wealth: {
      class: w.wealth_class ?? 'middle',
      trend: w.balance_trend ?? 'stable',
      percentile: Number(w.wealth_percentile ?? 50),
      lossAversion: Number(w.loss_aversion ?? 2.25),
      timeHorizon: w.time_horizon ?? 60,
    },
    social: {
      position: s.network_position ?? 'isolated',
      strongTies: s.bonding_capital ?? 0,
      weakTies: s.bridging_capital ?? 0,
      adversaries: s.adversaries ?? 0,
      posts: s.total_post_count ?? 0,
      replies: s.total_reply_count ?? 0,
    },
    reputation: {
      tier: r.tier ?? 'neutral',
      score: Number(r.current_score ?? 500),
      trajectory: r.trajectory ?? 'stable',
      fallFromGrace: r.fall_from_grace ?? false,
    },
    emotion: {
      mood: classifyMood(adjustedValence, adjustedArousal),
      valence: Number(adjustedValence.toFixed(3)),
      arousal: Number(adjustedArousal.toFixed(3)),
    },
    cognition: {
      complexity: cg.cognitive_complexity ?? 1,
      explorationRate: Number(cg.exploration_rate ?? 0.25),
      age: cg.age ?? 0,
      learningRate: Number(cg.learning_rate ?? 0.10),
    },
  };
}

// ─── Helper: Get All Agent Balances ─────────────────────────

export async function getAllAgentBalances(): Promise<Record<string, number>> {
  const pool = getPool();
  const result = await pool.query<{ agent_id: string; balance: string }>(
    'SELECT agent_id, balance FROM agents WHERE is_alive = true',
  );
  const balances: Record<string, number> = {};
  for (const row of result.rows) {
    balances[row.agent_id] = Number(row.balance);
  }
  return balances;
}

/**
 * Intel Phase Gate — Controls when agents can self-discover, spy, and trade intel.
 *
 * 3 Phases:
 *   Initial → birth knowledge only
 *   Awakened → self-discovery + market buy unlocked
 *   Insightful → spy + resale unlocked
 */

import { getPool } from '../db/postgres.js';
import { getWorldModifierMultiplier } from '../world/modifiers.js';

const APPROX_TICK_MS = 30_000;

export type IntelPhase = 'initial' | 'awakened' | 'insightful';

const AWAKENING_CONDITIONS = {
  minPDMatches: 4,
  peakBalanceRatio: 1.25,
  minTicksAlive: 30,
  minReputation: 600,
};

const INSIGHT_CONDITIONS = {
  minTotalMatches: 6,
  minEconomyCycles: 2,
  minForeignKnowledge: 1,
};

const SELF_DISCOVER_COOLDOWN = 50;
const SPY_COOLDOWN = 30;

const DISCOVER_BASE_PRICE = 0.02;
const SPY_BASE_PRICE = 0.05;

async function getIntelDivinationPriceMultiplier(): Promise<number> {
  return getWorldModifierMultiplier({
    domain: 'fate',
    modifierType: 'divination_price_multiplier',
  }).catch(() => 1);
}

export interface IntelPhaseRequirement {
  key: string;
  value: number;
  target: number;
  met: boolean;
}

export interface IntelCapabilitySnapshot {
  agentId: string;
  phase: IntelPhase;
  unlocks: {
    selfDiscover: boolean;
    buy: boolean;
    spy: boolean;
    trade: boolean;
  };
  metrics: {
    pdMatches: number;
    peakBalanceRatio: number;
    ticksAlive: number;
    reputationScore: number;
    deadCount: number;
    totalMatches: number;
    phaseChanges: number;
    selfKnownCount: number;
    foreignKnownCount: number;
    listableIntelCount: number;
  };
  requirements: {
    awakened: IntelPhaseRequirement[];
    insightful: IntelPhaseRequirement[];
  };
}

export async function getAgentIntelPhase(agentId: string): Promise<IntelPhase> {
  const snapshot = await getIntelCapabilitySnapshot(agentId);
  return snapshot.phase;
}

export async function getIntelCapabilitySnapshot(agentId: string): Promise<IntelCapabilitySnapshot> {
  const metrics = await getAgentIntelMetrics(agentId);

  const awakenedRequirements: IntelPhaseRequirement[] = [
    { key: 'pd_matches', value: metrics.pdMatches, target: AWAKENING_CONDITIONS.minPDMatches, met: metrics.pdMatches >= AWAKENING_CONDITIONS.minPDMatches },
    { key: 'peak_balance_ratio', value: metrics.peakBalanceRatio, target: AWAKENING_CONDITIONS.peakBalanceRatio, met: metrics.peakBalanceRatio >= AWAKENING_CONDITIONS.peakBalanceRatio },
    { key: 'ticks_alive', value: metrics.ticksAlive, target: AWAKENING_CONDITIONS.minTicksAlive, met: metrics.ticksAlive >= AWAKENING_CONDITIONS.minTicksAlive },
    { key: 'reputation', value: metrics.reputationScore, target: AWAKENING_CONDITIONS.minReputation, met: metrics.reputationScore >= AWAKENING_CONDITIONS.minReputation },
  ];

  const insightfulRequirements: IntelPhaseRequirement[] = [
    { key: 'total_matches', value: metrics.totalMatches, target: INSIGHT_CONDITIONS.minTotalMatches, met: metrics.totalMatches >= INSIGHT_CONDITIONS.minTotalMatches },
    { key: 'phase_changes', value: metrics.phaseChanges, target: INSIGHT_CONDITIONS.minEconomyCycles, met: metrics.phaseChanges >= INSIGHT_CONDITIONS.minEconomyCycles },
    { key: 'foreign_knowledge', value: metrics.foreignKnownCount, target: INSIGHT_CONDITIONS.minForeignKnowledge, met: metrics.foreignKnownCount >= INSIGHT_CONDITIONS.minForeignKnowledge },
  ];

  const awakenedMetCount = awakenedRequirements.filter((requirement) => requirement.met).length;
  const insightfulMetCount = insightfulRequirements.filter((requirement) => requirement.met).length;

  const awakened =
    metrics.pdMatches >= AWAKENING_CONDITIONS.minPDMatches &&
    awakenedMetCount >= 2;
  const insightful =
    awakened &&
    insightfulMetCount >= 3;

  return {
    agentId,
    phase: insightful ? 'insightful' : awakened ? 'awakened' : 'initial',
    unlocks: {
      selfDiscover: awakened,
      buy: awakened,
      spy: insightful,
      trade: insightful,
    },
    metrics,
    requirements: {
      awakened: awakenedRequirements,
      insightful: insightfulRequirements,
    },
  };
}

async function getAgentIntelMetrics(agentId: string): Promise<IntelCapabilitySnapshot['metrics']> {
  const pool = getPool();

  const [agentResult, matchResult, tickResult, socialResult, intelResult] = await Promise.all([
    pool.query<{ initial_balance: string; reputation_score: number }>(
      'SELECT initial_balance, reputation_score FROM agents WHERE agent_id = $1',
      [agentId],
    ),
    pool.query<{ match_count: string }>(
      `SELECT COUNT(*) as match_count
       FROM arena_matches
       WHERE status = 'settled'
         AND (player_a_id = $1 OR player_b_id = $1)`,
      [agentId],
    ),
    pool.query<{ max_tick: string; min_tick: string; peak_balance: string | null }>(
      `SELECT
         COALESCE(MAX(tick_number), 0) as max_tick,
         COALESCE(MIN(tick_number), 0) as min_tick,
         MAX(NULLIF(agent_balances ->> $1, '')::numeric) as peak_balance
       FROM tick_snapshots`,
      [agentId],
    ),
    pool.query<{ dead_count: string; total_matches: string; phase_changes: string }>(
      `SELECT
         (SELECT COUNT(*) FROM agents WHERE is_alive = false) as dead_count,
         (SELECT COUNT(*) FROM arena_matches WHERE status = 'settled') as total_matches,
         (SELECT COUNT(DISTINCT economy_phase) FROM economy_state) as phase_changes`,
    ),
    pool.query<{ self_known_count: string; foreign_known_count: string; listable_intel_count: string }>(
      `SELECT
         COUNT(DISTINCT dimension) FILTER (WHERE knower_agent_id = $1 AND subject_agent_id = $1) as self_known_count,
         COUNT(*) FILTER (WHERE knower_agent_id = $1 AND subject_agent_id != $1) as foreign_known_count,
         COUNT(*) FILTER (
           WHERE knower_agent_id = $1
             AND subject_agent_id != $1
             AND source_type IN ('spy', 'purchase')
         ) as listable_intel_count
       FROM intel_records`,
      [agentId],
    ),
  ]);

  if (agentResult.rows.length === 0) {
    return {
      pdMatches: 0,
      peakBalanceRatio: 1,
      ticksAlive: 0,
      reputationScore: 0,
      deadCount: 0,
      totalMatches: 0,
      phaseChanges: 0,
      selfKnownCount: 0,
      foreignKnownCount: 0,
      listableIntelCount: 0,
    };
  }

  const agent = agentResult.rows[0];
  const ticks = tickResult.rows[0];
  const social = socialResult.rows[0];
  const intel = intelResult.rows[0];
  const initialBalance = Math.max(0.000001, Number(agent.initial_balance));
  const peakBalance = Number(ticks.peak_balance ?? agent.initial_balance);

  return {
    pdMatches: Number(matchResult.rows[0]?.match_count ?? 0),
    peakBalanceRatio: Number((peakBalance / initialBalance).toFixed(3)),
    ticksAlive: Math.max(0, Number(ticks.max_tick ?? 0) - Number(ticks.min_tick ?? 0)),
    reputationScore: Number(agent.reputation_score ?? 0),
    deadCount: Number(social?.dead_count ?? 0),
    totalMatches: Number(matchResult.rows[0]?.match_count ?? 0),
    phaseChanges: Number(social?.phase_changes ?? 0),
    selfKnownCount: Number(intel?.self_known_count ?? 0),
    foreignKnownCount: Number(intel?.foreign_known_count ?? 0),
    listableIntelCount: Number(intel?.listable_intel_count ?? 0),
  };
}

export async function canSelfDiscover(agentId: string, _currentTick: number): Promise<boolean> {
  const snapshot = await getIntelCapabilitySnapshot(agentId);
  if (!snapshot.unlocks.selfDiscover) return false;

  const pool = getPool();
  const last = await pool.query<{ max_created_at: string | null }>(
    `SELECT MAX(created_at) as max_created_at
     FROM intel_records
     WHERE knower_agent_id = $1 AND subject_agent_id = $1 AND source_type = 'self_discover'`,
    [agentId],
  );

  const lastCreatedAt = last.rows[0]?.max_created_at ? new Date(last.rows[0].max_created_at).getTime() : 0;
  if (!lastCreatedAt) return true;
  const elapsedTicks = Math.floor((Date.now() - lastCreatedAt) / APPROX_TICK_MS);
  return elapsedTicks >= SELF_DISCOVER_COOLDOWN;
}

export async function canSpy(agentId: string, _currentTick: number): Promise<boolean> {
  const snapshot = await getIntelCapabilitySnapshot(agentId);
  if (!snapshot.unlocks.spy) return false;

  const pool = getPool();
  const last = await pool.query<{ max_created_at: string | null }>(
    `SELECT MAX(created_at) as max_created_at
     FROM intel_records
     WHERE knower_agent_id = $1 AND subject_agent_id != $1 AND source_type = 'spy'`,
    [agentId],
  );

  const lastCreatedAt = last.rows[0]?.max_created_at ? new Date(last.rows[0].max_created_at).getTime() : 0;
  if (!lastCreatedAt) return true;
  const elapsedTicks = Math.floor((Date.now() - lastCreatedAt) / APPROX_TICK_MS);
  return elapsedTicks >= SPY_COOLDOWN;
}

export async function getDiscoverPrice(agentId: string): Promise<number> {
  const pool = getPool();
  const known = await pool.query<{ cnt: string }>(
    `SELECT COUNT(DISTINCT dimension) as cnt FROM intel_records WHERE subject_agent_id = $1 AND knower_agent_id = $1`,
    [agentId],
  );
  const knownCount = Number(known.rows[0]?.cnt ?? 0);
  const multiplier = await getIntelDivinationPriceMultiplier();
  return Number((DISCOVER_BASE_PRICE * Math.pow(2, knownCount) * multiplier).toFixed(6));
}

export async function getSpyPrice(agentId: string, targetId: string): Promise<number> {
  const pool = getPool();
  const known = await pool.query<{ cnt: string }>(
    `SELECT COUNT(DISTINCT dimension) as cnt FROM intel_records WHERE subject_agent_id = $1 AND knower_agent_id = $2`,
    [targetId, agentId],
  );
  const knownCount = Number(known.rows[0]?.cnt ?? 0);
  const multiplier = await getIntelDivinationPriceMultiplier();
  return Number((SPY_BASE_PRICE * Math.pow(2, knownCount) * multiplier).toFixed(6));
}

export async function canBuyIntel(agentId: string): Promise<boolean> {
  const snapshot = await getIntelCapabilitySnapshot(agentId);
  return snapshot.unlocks.buy;
}

export async function canTradeIntel(agentId: string): Promise<boolean> {
  const snapshot = await getIntelCapabilitySnapshot(agentId);
  return snapshot.unlocks.trade;
}

export { SELF_DISCOVER_COOLDOWN, SPY_COOLDOWN };

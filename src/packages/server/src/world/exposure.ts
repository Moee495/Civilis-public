import { getPool } from '../db/postgres.js';
import { calculatePayoff, resolvePdPayoutSemantics } from '../arena/payoff-matrix.js';
import { getCurrentTick } from './tick-engine.js';
import { getLatestWorldSignalSnapshot } from './signals.js';
import { getLatestWorldTickRun } from './tick-runs.js';
import {
  getActiveWorldEventCount,
  getActiveWorldModifierCount,
  resolveWorldModifierValueFromRecords,
  resolveActiveWorldModifiers,
  summarizeWorldModifierStacks,
  type WorldModifierRecord,
} from './modifiers.js';

export interface AgentExposureSummary {
  agentId: string;
  tick: number;
  worldRegime: string;
  globalModifierCount: number;
  scopedModifierCount: number;
  recentEventCount: number;
  activeModifiers: WorldModifierRecord[];
  modifierStacks: ReturnType<typeof summarizeWorldModifierStacks>;
  recentEvents: Array<{
    id: number;
    eventType: string;
    title: string;
    category: string;
    severity: string;
    tickNumber: number;
    status: string;
    affectedAgents: string[];
    scopeType: string;
    scopeRef: string | null;
    createdAt: string;
  }>;
  domainCounts: Array<{ domain: string; count: number }>;
}

export interface WorldAnalyticsWindowBounds {
  source: 'tick_snapshots';
  coverage: 'full' | 'partial' | 'insufficient';
  currentStartTick: number;
  currentEndTick: number;
  previousStartTick: number | null;
  previousEndTick: number | null;
  currentStartAt: string | null;
  currentEndAt: string | null;
  previousStartAt: string | null;
  previousEndAt: string | null;
  currentTickCoverage: number;
  previousTickCoverage: number;
}

export interface WorldActivityComparison {
  metric: string;
  currentWindow: number;
  previousWindow: number;
  delta: number;
  trend: 'up' | 'down' | 'flat';
}

export interface TickRangeBounds {
  startTick: number;
  endTick: number;
  startAt: string | null;
  endAt: string | null;
  tickCoverage: number;
  coverage: 'full' | 'partial' | 'insufficient';
}

export interface WorldEventImpactComparison {
  event: {
    id: number;
    eventType: string;
    title: string;
    category: string;
    severity: string;
    status: string;
    tickNumber: number;
  };
  windowSizeTicks: number;
  beforeBounds: TickRangeBounds;
  afterBounds: TickRangeBounds;
  overlapSummary: {
    overlappingEventCount: number;
    overlappingEventIds: number[];
    overlapLevel: 'isolated' | 'mixed' | 'crowded';
    attributionConfidence: 'higher' | 'medium' | 'lower';
  };
  activityComparisons: WorldActivityComparison[];
  dominantActivityDelta: WorldActivityComparison | null;
}

export interface WorldEmotionWindowComparison {
  coverage: 'full' | 'partial' | 'insufficient';
  currentTickCoverage: number;
  previousTickCoverage: number;
  currentRawAverageValence: number | null;
  previousRawAverageValence: number | null;
  rawValenceDelta: number | null;
  currentRawAverageArousal: number | null;
  previousRawAverageArousal: number | null;
  rawArousalDelta: number | null;
  currentEffectiveAverageValence: number | null;
  previousEffectiveAverageValence: number | null;
  effectiveValenceDelta: number | null;
  currentEffectiveAverageArousal: number | null;
  previousEffectiveAverageArousal: number | null;
  effectiveArousalDelta: number | null;
}

export interface WorldModifierValidationSummary {
  emotionWindow: WorldEmotionWindowComparison;
  decisionTraceComparisons: WorldActivityComparison[];
  activeModifierCounts: Array<{ modifierType: string; count: number }>;
  naturalWindowValidations: WorldModifierNaturalValidationSummary[];
  pdPayoutSemantics: WorldPdPayoutValidationSummary;
}

export interface WorldConsumerCoverageSummary {
  subsystem: 'agent' | 'social' | 'commons' | 'prediction' | 'arena' | 'fate_intel';
  modifierTypes: string[];
  activeModifierTypes: string[];
  activeModifierCount: number;
  implementationStatus: 'connected' | 'partial';
  evidenceStatus:
    | 'verified'
    | 'partial'
    | 'synthetic_only'
    | 'missing_natural_sample'
    | 'environment_dependent';
  currentStatus: 'active' | 'idle';
  note: string;
}

export interface WorldPdPayoutValidationSummary {
  semanticsMode: 'treasury_cut_inverse';
  resolvedMultiplier: number;
  contributorCount: number;
  capped: boolean;
  baseTreasuryCutRate: number;
  effectiveTreasuryCutRate: number;
  baseNetPoolShare: number;
  effectiveNetPoolShare: number;
  playerShareDelta: number;
  note: string;
  samplePrizePool: number;
  baselineSample: {
    cooperateEach: number;
    betrayWinner: number;
    betrayLoser: number;
    defectEach: number;
    treasuryCC: number;
    treasuryCD: number;
    treasuryDD: number;
  };
  effectiveSample: {
    cooperateEach: number;
    betrayWinner: number;
    betrayLoser: number;
    defectEach: number;
    treasuryCC: number;
    treasuryCD: number;
    treasuryDD: number;
  };
}

export interface WorldModifierNaturalValidationSummary {
  modifierType: string;
  naturalOccurrenceCount: number;
  validationStatus: 'verified' | 'partial' | 'missing_natural_sample';
  latestEvent: {
    id: number;
    eventType: string;
    title: string;
    tickNumber: number;
    status: string;
  } | null;
  latestWindow: {
    startTick: number;
    endTick: number;
    coverage: 'full' | 'partial' | 'insufficient';
  } | null;
  linkedArenaMatch: {
    matchId: number;
    exists: boolean;
    status: string | null;
    totalRounds: number | null;
    playerAId: string | null;
    playerBId: string | null;
    settledAt: string | null;
  } | null;
  activityEvidence: WorldActivityComparison[];
  resolvedScopeValues: Array<{
    scopeRef: string;
    effectiveValue: number | boolean | null;
    contributorCount: number;
  }>;
  dominantDecisionTraceDelta: WorldActivityComparison | null;
  emotionWindow: WorldEmotionWindowComparison | null;
  note: string;
}

export interface WorldConsumerIntegrationBreakdown {
  subsystem: WorldConsumerCoverageSummary['subsystem'];
  awardedPoints: number;
  maxPoints: number;
  reason: string;
}

export interface WorldConsumerIntegrationProgress {
  overallPercent: number;
  awardedPoints: number;
  maxPoints: number;
  breakdown: WorldConsumerIntegrationBreakdown[];
}

export interface WorldAnalyticsSummary {
  tick: number;
  worldRegime: string;
  activeEventCount: number;
  activeModifierCount: number;
  latestTickRun: Awaited<ReturnType<typeof getLatestWorldTickRun>>;
  windowBounds: WorldAnalyticsWindowBounds;
  activityComparisons: WorldActivityComparison[];
  eventImpactComparisons: WorldEventImpactComparison[];
  modifierValidation: WorldModifierValidationSummary;
  consumerCoverage: WorldConsumerCoverageSummary[];
  consumerIntegrationProgress: WorldConsumerIntegrationProgress;
  modifierDomainCounts: Array<{ domain: string; count: number }>;
  modifierTypeCounts: Array<{ modifierType: string; count: number }>;
  recentEventCategoryCounts: Array<{ category: string; count: number }>;
  recentEventSeverityCounts: Array<{ severity: string; count: number }>;
  recentEventStatusCounts: Array<{ status: string; count: number }>;
}

const WORLD_CONSUMER_INTEGRATION_WEIGHTS: Record<WorldConsumerCoverageSummary['subsystem'], number> = {
  agent: 16,
  social: 12,
  commons: 14,
  prediction: 14,
  arena: 18,
  fate_intel: 26,
};

const WORLD_CONSUMER_COVERAGE_REGISTRY: Array<{
  subsystem: WorldConsumerCoverageSummary['subsystem'];
  modifierTypes: string[];
  implementationStatus: WorldConsumerCoverageSummary['implementationStatus'];
  evidenceStatus: WorldConsumerCoverageSummary['evidenceStatus'];
  note: string;
}> = [
  {
    subsystem: 'agent',
    modifierTypes: ['risk_tolerance_shift', 'forced_match_pressure', 'tournament_attention'],
    implementationStatus: 'connected',
    evidenceStatus: 'verified',
    note: 'World context, stack policy, and exposure surfaces are validated through API and browser checks.',
  },
  {
    subsystem: 'social',
    modifierTypes: ['social_post_cost_multiplier'],
    implementationStatus: 'connected',
    evidenceStatus: 'partial',
    note: 'Consumer is wired, but stronger natural-window verification still needs to be surfaced.',
  },
  {
    subsystem: 'commons',
    modifierTypes: ['commons_base_injection_override', 'commons_multiplier_bonus', 'commons_coop_override'],
    implementationStatus: 'connected',
    evidenceStatus: 'verified',
    note: 'Local runtime samples confirmed modifier-driven commons multiplier and injection changes.',
  },
  {
    subsystem: 'prediction',
    modifierTypes: ['prediction_odds_bonus'],
    implementationStatus: 'connected',
    evidenceStatus: 'verified',
    note: 'Local runtime samples confirmed modifier-driven odds changes.',
  },
  {
    subsystem: 'arena',
    modifierTypes: ['pd_payout_multiplier', 'forced_match_pressure', 'tournament_attention'],
    implementationStatus: 'connected',
    evidenceStatus: 'verified',
    note: 'Forced-match behavior, PD payout semantics, and natural tournament attention are all validated.',
  },
  {
    subsystem: 'fate_intel',
    modifierTypes: ['divination_price_multiplier', 'valence_shift', 'arousal_shift'],
    implementationStatus: 'connected',
    evidenceStatus: 'partial',
    note: 'Pricing is validated, but live natural emotion samples are still missing in the current dataset.',
  },
];

function countByKey<T extends string>(values: T[]): Array<{ key: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return String(a.key).localeCompare(String(b.key));
    });
}

function buildActivityComparison(metric: string, currentWindow: number, previousWindow: number): WorldActivityComparison {
  const delta = currentWindow - previousWindow;
  return {
    metric,
    currentWindow,
    previousWindow,
    delta,
    trend: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
  };
}

function getDominantActivityDelta(comparisons: WorldActivityComparison[]): WorldActivityComparison | null {
  const candidates = comparisons
    .filter((comparison) => comparison.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return candidates[0] ?? null;
}

function getConsumerCoverageSummary(
  activeModifiers: WorldModifierRecord[],
  modifierValidation: WorldModifierValidationSummary,
): WorldConsumerCoverageSummary[] {
  const activeTypeCounts = new Map<string, number>();
  for (const modifier of activeModifiers) {
    activeTypeCounts.set(modifier.modifierType, (activeTypeCounts.get(modifier.modifierType) ?? 0) + 1);
  }

  const naturalValidationByType = new Map(
    modifierValidation.naturalWindowValidations.map((entry) => [entry.modifierType, entry.validationStatus]),
  );

  return WORLD_CONSUMER_COVERAGE_REGISTRY.map((entry) => {
    const activeModifierTypes = entry.modifierTypes.filter((modifierType) => activeTypeCounts.has(modifierType));
    const activeModifierCount = activeModifierTypes.reduce(
      (sum, modifierType) => sum + (activeTypeCounts.get(modifierType) ?? 0),
      0,
    );

    let evidenceStatus = entry.evidenceStatus;
    if (entry.subsystem === 'social') {
      const socialStatus = naturalValidationByType.get('social_post_cost_multiplier');
      if (socialStatus === 'verified') {
        evidenceStatus = 'verified';
      }
    }
    if (entry.subsystem === 'fate_intel') {
      const valenceStatus = naturalValidationByType.get('valence_shift');
      const arousalStatus = naturalValidationByType.get('arousal_shift');
      if (valenceStatus === 'missing_natural_sample' && arousalStatus === 'missing_natural_sample') {
        evidenceStatus = 'missing_natural_sample';
      }
    }

    return {
      subsystem: entry.subsystem,
      modifierTypes: entry.modifierTypes,
      activeModifierTypes,
      activeModifierCount,
      implementationStatus: entry.implementationStatus,
      evidenceStatus,
      currentStatus: activeModifierCount > 0 ? 'active' : 'idle',
      note: entry.note,
    };
  });
}

function getConsumerIntegrationProgress(
  consumerCoverage: WorldConsumerCoverageSummary[],
): WorldConsumerIntegrationProgress {
  const breakdown = consumerCoverage.map((entry) => {
    const maxPoints = WORLD_CONSUMER_INTEGRATION_WEIGHTS[entry.subsystem];
    let awardedPoints = 0;
    let reason = entry.note;

    switch (entry.subsystem) {
      case 'agent':
      case 'commons':
      case 'prediction':
      case 'arena':
        awardedPoints = entry.evidenceStatus === 'verified' ? maxPoints : Math.round(maxPoints * 0.6);
        break;
      case 'social':
        awardedPoints =
          entry.evidenceStatus === 'verified'
            ? maxPoints
            : entry.evidenceStatus === 'partial'
              ? 8
              : 6;
        reason =
          entry.evidenceStatus === 'verified'
            ? 'Natural reputation-contest sample resolved the role-specific multipliers and the bounded social window moved.'
            : 'Consumer wiring exists, but the natural social window still lacks stronger role-linked behavior evidence.';
        break;
      case 'fate_intel':
        awardedPoints =
          entry.evidenceStatus === 'verified'
            ? maxPoints
            : entry.evidenceStatus === 'missing_natural_sample'
              ? 14
              : 18;
        reason =
          entry.evidenceStatus === 'missing_natural_sample'
            ? 'Pricing and synthetic observability are verified, but natural valence/arousal samples have not appeared in the current dataset.'
            : entry.note;
        break;
      default:
        awardedPoints = entry.evidenceStatus === 'verified' ? maxPoints : Math.round(maxPoints * 0.5);
    }

    return {
      subsystem: entry.subsystem,
      awardedPoints,
      maxPoints,
      reason,
    };
  });

  const awardedPoints = breakdown.reduce((sum, entry) => sum + entry.awardedPoints, 0);
  const maxPoints = breakdown.reduce((sum, entry) => sum + entry.maxPoints, 0);

  return {
    overallPercent: maxPoints > 0 ? Math.round((awardedPoints / maxPoints) * 100) : 0,
    awardedPoints,
    maxPoints,
    breakdown,
  };
}

function buildPdOutcomeSample(multiplier: number): WorldPdPayoutValidationSummary['baselineSample'] {
  const cooperate = calculatePayoff('cooperate', 'cooperate', 2, 'prisoners_dilemma', {
    pdPayoutMultiplier: multiplier,
  });
  const betray = calculatePayoff('cooperate', 'betray', 2, 'prisoners_dilemma', {
    pdPayoutMultiplier: multiplier,
  });
  const defect = calculatePayoff('betray', 'betray', 2, 'prisoners_dilemma', {
    pdPayoutMultiplier: multiplier,
  });

  return {
    cooperateEach: cooperate.playerAPayout,
    betrayWinner: betray.playerBPayout,
    betrayLoser: betray.playerAPayout,
    defectEach: defect.playerAPayout,
    treasuryCC: cooperate.treasuryDelta,
    treasuryCD: betray.treasuryDelta,
    treasuryDD: defect.treasuryDelta,
  };
}

function getPdPayoutValidationSummary(
  activeModifiers: WorldModifierRecord[],
): WorldPdPayoutValidationSummary {
  const resolved = resolveWorldModifierValueFromRecords(activeModifiers, 'pd_payout_multiplier');
  const resolvedMultiplier =
    typeof resolved.effectiveValue === 'number' && Number.isFinite(resolved.effectiveValue)
      ? resolved.effectiveValue
      : 1;
  const semantics = resolvePdPayoutSemantics(resolvedMultiplier);
  const samplePrizePool = 2;

  return {
    semanticsMode: semantics.semanticsMode,
    resolvedMultiplier,
    contributorCount: resolved.selected.length,
    capped: resolved.capped,
    baseTreasuryCutRate: semantics.baseTreasuryCutRate,
    effectiveTreasuryCutRate: semantics.effectiveTreasuryCutRate,
    baseNetPoolShare: semantics.baseNetPoolShare,
    effectiveNetPoolShare: semantics.effectiveNetPoolShare,
    playerShareDelta: semantics.playerShareDelta,
    note: semantics.note,
    samplePrizePool,
    baselineSample: buildPdOutcomeSample(1),
    effectiveSample: buildPdOutcomeSample(resolvedMultiplier),
  };
}

async function getTickRangeBounds(startTick: number, endTick: number): Promise<TickRangeBounds> {
  const pool = getPool();
  if (endTick < startTick || endTick <= 0) {
    return {
      startTick,
      endTick,
      startAt: null,
      endAt: null,
      tickCoverage: 0,
      coverage: 'insufficient',
    };
  }

  const result = await pool.query<{
    start_at: string | null;
    end_at: string | null;
    tick_count: string;
  }>(
    `SELECT
       MIN(created_at) AS start_at,
       MAX(created_at) AS end_at,
       COUNT(*) AS tick_count
     FROM tick_snapshots
     WHERE tick_number BETWEEN $1 AND $2`,
    [startTick, endTick],
  );

  const row = result.rows[0];
  const tickCoverage = Number(row?.tick_count ?? 0);
  const expectedTicks = Math.max(0, endTick - startTick + 1);
  let coverage: TickRangeBounds['coverage'] = 'insufficient';
  if (tickCoverage >= expectedTicks && expectedTicks > 0) {
    coverage = 'full';
  } else if (tickCoverage > 0) {
    coverage = 'partial';
  }

  return {
    startTick,
    endTick,
    startAt: row?.start_at ?? null,
    endAt: row?.end_at ?? null,
    tickCoverage,
    coverage,
  };
}

async function queryActivityComparisonsForTimeBounds(input: {
  currentStartAt: string | null;
  currentEndAt: string | null;
  previousStartAt: string | null;
  previousEndAt: string | null;
}): Promise<WorldActivityComparison[]> {
  const pool = getPool();
  if (!input.currentStartAt || !input.currentEndAt) {
    return [];
  }

  const metricsResult = await pool.query<{
    current_posts: string;
    previous_posts: string;
    current_replies: string;
    previous_replies: string;
    current_tips: string;
    previous_tips: string;
    current_paywall_unlocks: string;
    previous_paywall_unlocks: string;
    current_arena_created: string;
    previous_arena_created: string;
    current_arena_settled: string;
    previous_arena_settled: string;
    current_commons_rounds: string;
    previous_commons_rounds: string;
    current_prediction_rounds: string;
    previous_prediction_rounds: string;
    current_x402_transactions: string;
    previous_x402_transactions: string;
    current_intel_listings: string;
    previous_intel_listings: string;
    current_intel_sales: string;
    previous_intel_sales: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM posts WHERE created_at >= $1 AND created_at <= $2) AS current_posts,
       (SELECT COUNT(*) FROM posts WHERE created_at >= $3 AND created_at <= $4) AS previous_posts,
       (SELECT COUNT(*) FROM replies WHERE created_at >= $1 AND created_at <= $2) AS current_replies,
       (SELECT COUNT(*) FROM replies WHERE created_at >= $3 AND created_at <= $4) AS previous_replies,
       (SELECT COUNT(*) FROM tips WHERE created_at >= $1 AND created_at <= $2) AS current_tips,
       (SELECT COUNT(*) FROM tips WHERE created_at >= $3 AND created_at <= $4) AS previous_tips,
       (SELECT COUNT(*) FROM paywall_unlocks WHERE created_at >= $1 AND created_at <= $2) AS current_paywall_unlocks,
       (SELECT COUNT(*) FROM paywall_unlocks WHERE created_at >= $3 AND created_at <= $4) AS previous_paywall_unlocks,
       (SELECT COUNT(*) FROM arena_matches WHERE created_at >= $1 AND created_at <= $2) AS current_arena_created,
       (SELECT COUNT(*) FROM arena_matches WHERE created_at >= $3 AND created_at <= $4) AS previous_arena_created,
       (SELECT COUNT(*) FROM arena_matches WHERE settled_at >= $1 AND settled_at <= $2) AS current_arena_settled,
       (SELECT COUNT(*) FROM arena_matches WHERE settled_at >= $3 AND settled_at <= $4) AS previous_arena_settled,
       (SELECT COUNT(*) FROM commons_rounds WHERE created_at >= $1 AND created_at <= $2) AS current_commons_rounds,
       (SELECT COUNT(*) FROM commons_rounds WHERE created_at >= $3 AND created_at <= $4) AS previous_commons_rounds,
       (SELECT COUNT(*) FROM prediction_rounds WHERE created_at >= $1 AND created_at <= $2) AS current_prediction_rounds,
       (SELECT COUNT(*) FROM prediction_rounds WHERE created_at >= $3 AND created_at <= $4) AS previous_prediction_rounds,
       (SELECT COUNT(*) FROM x402_transactions WHERE created_at >= $1 AND created_at <= $2) AS current_x402_transactions,
       (SELECT COUNT(*) FROM x402_transactions WHERE created_at >= $3 AND created_at <= $4) AS previous_x402_transactions,
       (SELECT COUNT(*) FROM intel_listings WHERE created_at >= $1 AND created_at <= $2) AS current_intel_listings,
       (SELECT COUNT(*) FROM intel_listings WHERE created_at >= $3 AND created_at <= $4) AS previous_intel_listings,
       (SELECT COUNT(*) FROM intel_listings WHERE sold_at >= $1 AND sold_at <= $2) AS current_intel_sales,
       (SELECT COUNT(*) FROM intel_listings WHERE sold_at >= $3 AND sold_at <= $4) AS previous_intel_sales`,
    [
      input.currentStartAt,
      input.currentEndAt,
      input.previousStartAt,
      input.previousEndAt,
    ],
  );

  const row = metricsResult.rows[0];
  return [
    buildActivityComparison('posts', Number(row?.current_posts ?? 0), Number(row?.previous_posts ?? 0)),
    buildActivityComparison('replies', Number(row?.current_replies ?? 0), Number(row?.previous_replies ?? 0)),
    buildActivityComparison('tips', Number(row?.current_tips ?? 0), Number(row?.previous_tips ?? 0)),
    buildActivityComparison('paywall_unlocks', Number(row?.current_paywall_unlocks ?? 0), Number(row?.previous_paywall_unlocks ?? 0)),
    buildActivityComparison('arena_created', Number(row?.current_arena_created ?? 0), Number(row?.previous_arena_created ?? 0)),
    buildActivityComparison('arena_settled', Number(row?.current_arena_settled ?? 0), Number(row?.previous_arena_settled ?? 0)),
    buildActivityComparison('commons_rounds', Number(row?.current_commons_rounds ?? 0), Number(row?.previous_commons_rounds ?? 0)),
    buildActivityComparison('prediction_rounds', Number(row?.current_prediction_rounds ?? 0), Number(row?.previous_prediction_rounds ?? 0)),
    buildActivityComparison('x402_transactions', Number(row?.current_x402_transactions ?? 0), Number(row?.previous_x402_transactions ?? 0)),
    buildActivityComparison('intel_listings', Number(row?.current_intel_listings ?? 0), Number(row?.previous_intel_listings ?? 0)),
    buildActivityComparison('intel_sales', Number(row?.current_intel_sales ?? 0), Number(row?.previous_intel_sales ?? 0)),
  ];
}

async function queryDecisionTraceComparisonsForTimeBounds(input: {
  currentStartAt: string | null;
  currentEndAt: string | null;
  previousStartAt: string | null;
  previousEndAt: string | null;
}): Promise<WorldActivityComparison[]> {
  const pool = getPool();
  if (!input.currentStartAt || !input.currentEndAt) {
    return [];
  }

  const metricsResult = await pool.query<{
    current_arena_scene_traces: string;
    previous_arena_scene_traces: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM agent_decision_traces WHERE created_at >= $1 AND created_at <= $2 AND scene = 'arena') AS current_arena_scene_traces,
       (SELECT COUNT(*) FROM agent_decision_traces WHERE created_at >= $3 AND created_at <= $4 AND scene = 'arena') AS previous_arena_scene_traces`,
    [
      input.currentStartAt,
      input.currentEndAt,
      input.previousStartAt,
      input.previousEndAt,
    ],
  );

  const row = metricsResult.rows[0];
  return [
    buildActivityComparison(
      'arena_scene_traces',
      Number(row?.current_arena_scene_traces ?? 0),
      Number(row?.previous_arena_scene_traces ?? 0),
    ),
  ];
}

async function queryPeakActiveArenaComparisonForTickRanges(input: {
  currentStartTick: number;
  currentEndTick: number;
  previousStartTick: number;
  previousEndTick: number;
}): Promise<WorldActivityComparison> {
  const pool = getPool();
  const result = await pool.query<{
    current_peak_active_arena: string | null;
    previous_peak_active_arena: string | null;
  }>(
    `SELECT
       MAX(active_arena_count) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_peak_active_arena,
       MAX(active_arena_count) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_peak_active_arena
     FROM tick_snapshots`,
    [
      input.currentStartTick,
      input.currentEndTick,
      input.previousStartTick,
      input.previousEndTick,
    ],
  );

  const row = result.rows[0];
  return buildActivityComparison(
    'peak_active_arena',
    Number(row?.current_peak_active_arena ?? 0),
    Number(row?.previous_peak_active_arena ?? 0),
  );
}

async function getAnalyticsWindowBounds(
  tick: number,
  recentTickWindow: number,
): Promise<WorldAnalyticsWindowBounds> {
  const pool = getPool();
  const currentStartTick = Math.max(tick - recentTickWindow + 1, 1);
  const currentEndTick = tick;
  const previousEndTick = currentStartTick > 1 ? currentStartTick - 1 : 0;
  const previousStartTick = previousEndTick > 0
    ? Math.max(previousEndTick - recentTickWindow + 1, 1)
    : null;

  const boundsResult = await pool.query<{
    current_start_at: string | null;
    current_end_at: string | null;
    previous_start_at: string | null;
    previous_end_at: string | null;
    current_tick_count: string;
    previous_tick_count: string;
  }>(
    `SELECT
       MIN(created_at) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_start_at,
       MAX(created_at) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_end_at,
       MIN(created_at) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_start_at,
       MAX(created_at) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_end_at,
       COUNT(*) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_tick_count,
       COUNT(*) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_tick_count
     FROM tick_snapshots`,
    [
      currentStartTick,
      currentEndTick,
      previousStartTick ?? 0,
      previousEndTick,
    ],
  );

  const row = boundsResult.rows[0];
  const currentTickCoverage = Number(row?.current_tick_count ?? 0);
  const previousTickCoverage = Number(row?.previous_tick_count ?? 0);

  let coverage: WorldAnalyticsWindowBounds['coverage'] = 'insufficient';
  if (currentTickCoverage > 0 && previousTickCoverage > 0) {
    coverage = 'full';
  } else if (currentTickCoverage > 0) {
    coverage = 'partial';
  }

  return {
    source: 'tick_snapshots',
    coverage,
    currentStartTick,
    currentEndTick,
    previousStartTick,
    previousEndTick: previousEndTick > 0 ? previousEndTick : null,
    currentStartAt: row?.current_start_at ?? null,
    currentEndAt: row?.current_end_at ?? null,
    previousStartAt: row?.previous_start_at ?? null,
    previousEndAt: row?.previous_end_at ?? null,
    currentTickCoverage,
    previousTickCoverage,
  };
}

async function getWindowedActivityComparisons(
  bounds: WorldAnalyticsWindowBounds,
): Promise<WorldActivityComparison[]> {
  return queryActivityComparisonsForTimeBounds({
    currentStartAt: bounds.currentStartAt,
    currentEndAt: bounds.currentEndAt,
    previousStartAt: bounds.previousStartAt,
    previousEndAt: bounds.previousEndAt,
  });
}

async function getEmotionWindowComparison(
  bounds: WorldAnalyticsWindowBounds,
): Promise<WorldEmotionWindowComparison> {
  const pool = getPool();
  const result = await pool.query<{
    current_average_valence: string | null;
    previous_average_valence: string | null;
    current_average_arousal: string | null;
    previous_average_arousal: string | null;
    current_effective_average_valence: string | null;
    previous_effective_average_valence: string | null;
    current_effective_average_arousal: string | null;
    previous_effective_average_arousal: string | null;
    current_emotion_tick_count: string;
    previous_emotion_tick_count: string;
  }>(
    `SELECT
       AVG(average_valence) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_average_valence,
       AVG(average_valence) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_average_valence,
       AVG(average_arousal) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_average_arousal,
       AVG(average_arousal) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_average_arousal,
       AVG(effective_average_valence) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_effective_average_valence,
       AVG(effective_average_valence) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_effective_average_valence,
       AVG(effective_average_arousal) FILTER (WHERE tick_number BETWEEN $1 AND $2) AS current_effective_average_arousal,
       AVG(effective_average_arousal) FILTER (WHERE tick_number BETWEEN $3 AND $4) AS previous_effective_average_arousal,
       COUNT(*) FILTER (
         WHERE tick_number BETWEEN $1 AND $2
           AND effective_average_valence IS NOT NULL
           AND effective_average_arousal IS NOT NULL
       ) AS current_emotion_tick_count,
       COUNT(*) FILTER (
         WHERE tick_number BETWEEN $3 AND $4
           AND effective_average_valence IS NOT NULL
           AND effective_average_arousal IS NOT NULL
       ) AS previous_emotion_tick_count
     FROM tick_snapshots`,
    [
      bounds.currentStartTick,
      bounds.currentEndTick,
      bounds.previousStartTick ?? 0,
      bounds.previousEndTick ?? 0,
    ],
  );

  const row = result.rows[0];
  const currentTickCoverage = Number(row?.current_emotion_tick_count ?? 0);
  const previousTickCoverage = Number(row?.previous_emotion_tick_count ?? 0);
  let coverage: WorldEmotionWindowComparison['coverage'] = 'insufficient';
  if (
    currentTickCoverage > 0 &&
    previousTickCoverage > 0 &&
    currentTickCoverage >= bounds.currentTickCoverage &&
    previousTickCoverage >= bounds.previousTickCoverage
  ) {
    coverage = 'full';
  } else if (currentTickCoverage > 0 || previousTickCoverage > 0) {
    coverage = 'partial';
  }

  const currentRawAverageValence = row?.current_average_valence != null ? Number(row.current_average_valence) : null;
  const previousRawAverageValence = row?.previous_average_valence != null ? Number(row.previous_average_valence) : null;
  const currentRawAverageArousal = row?.current_average_arousal != null ? Number(row.current_average_arousal) : null;
  const previousRawAverageArousal = row?.previous_average_arousal != null ? Number(row.previous_average_arousal) : null;
  const currentEffectiveAverageValence = row?.current_effective_average_valence != null ? Number(row.current_effective_average_valence) : null;
  const previousEffectiveAverageValence = row?.previous_effective_average_valence != null ? Number(row.previous_effective_average_valence) : null;
  const currentEffectiveAverageArousal = row?.current_effective_average_arousal != null ? Number(row.current_effective_average_arousal) : null;
  const previousEffectiveAverageArousal = row?.previous_effective_average_arousal != null ? Number(row.previous_effective_average_arousal) : null;

  return {
    coverage,
    currentTickCoverage,
    previousTickCoverage,
    currentRawAverageValence,
    previousRawAverageValence,
    rawValenceDelta:
      currentRawAverageValence != null && previousRawAverageValence != null
        ? currentRawAverageValence - previousRawAverageValence
        : null,
    currentRawAverageArousal,
    previousRawAverageArousal,
    rawArousalDelta:
      currentRawAverageArousal != null && previousRawAverageArousal != null
        ? currentRawAverageArousal - previousRawAverageArousal
        : null,
    currentEffectiveAverageValence,
    previousEffectiveAverageValence,
    effectiveValenceDelta:
      currentEffectiveAverageValence != null && previousEffectiveAverageValence != null
        ? currentEffectiveAverageValence - previousEffectiveAverageValence
        : null,
    currentEffectiveAverageArousal,
    previousEffectiveAverageArousal,
    effectiveArousalDelta:
      currentEffectiveAverageArousal != null && previousEffectiveAverageArousal != null
        ? currentEffectiveAverageArousal - previousEffectiveAverageArousal
        : null,
  };
}

async function getModifierValidationSummary(
  bounds: WorldAnalyticsWindowBounds,
  activeModifiers: WorldModifierRecord[],
): Promise<WorldModifierValidationSummary> {
  const [emotionWindow, decisionTraceComparisons, naturalWindowValidations] = await Promise.all([
    getEmotionWindowComparison(bounds),
    queryDecisionTraceComparisonsForTimeBounds({
      currentStartAt: bounds.currentStartAt,
      currentEndAt: bounds.currentEndAt,
      previousStartAt: bounds.previousStartAt,
      previousEndAt: bounds.previousEndAt,
    }),
    getNaturalModifierValidationSummaries([
      'social_post_cost_multiplier',
      'tournament_attention',
      'valence_shift',
      'arousal_shift',
    ]),
  ]);

  const trackedModifiers = activeModifiers.filter((modifier) =>
    ['social_post_cost_multiplier', 'tournament_attention', 'valence_shift', 'arousal_shift'].includes(
      modifier.modifierType,
    ),
  );

  return {
    emotionWindow,
    decisionTraceComparisons,
    activeModifierCounts: countByKey(trackedModifiers.map((modifier) => modifier.modifierType)).map((entry) => ({
      modifierType: entry.key,
      count: entry.count,
    })),
    naturalWindowValidations,
    pdPayoutSemantics: getPdPayoutValidationSummary(activeModifiers),
  };
}

async function buildWindowBoundsForTicks(
  currentStartTick: number,
  currentEndTick: number,
  previousStartTick: number,
  previousEndTick: number,
): Promise<WorldAnalyticsWindowBounds> {
  const [currentBounds, previousBounds] = await Promise.all([
    getTickRangeBounds(currentStartTick, currentEndTick),
    getTickRangeBounds(previousStartTick, previousEndTick),
  ]);

  let coverage: WorldAnalyticsWindowBounds['coverage'] = 'insufficient';
  if (currentBounds.coverage === 'full' && previousBounds.coverage === 'full') {
    coverage = 'full';
  } else if (currentBounds.coverage !== 'insufficient' || previousBounds.coverage !== 'insufficient') {
    coverage = 'partial';
  }

  return {
    source: 'tick_snapshots',
    coverage,
    currentStartTick,
    currentEndTick,
    previousStartTick,
    previousEndTick,
    currentStartAt: currentBounds.startAt,
    currentEndAt: currentBounds.endAt,
    previousStartAt: previousBounds.startAt,
    previousEndAt: previousBounds.endAt,
    currentTickCoverage: currentBounds.tickCoverage,
    previousTickCoverage: previousBounds.tickCoverage,
  };
}

async function getNaturalModifierValidationSummaries(
  modifierTypes: string[],
): Promise<WorldModifierNaturalValidationSummary[]> {
  const pool = getPool();
  const [countsResult, latestResult] = await Promise.all([
    pool.query<{ modifier_type: string; count: string }>(
      `SELECT wm.modifier_type, COUNT(*) AS count
       FROM world_modifiers wm
       JOIN world_events we ON we.id = wm.source_event_id
       WHERE wm.modifier_type = ANY($1::text[])
       GROUP BY wm.modifier_type`,
      [modifierTypes],
    ),
    pool.query<{
      modifier_type: string;
      source_event_id: number;
      starts_at_tick: number;
      ends_at_tick: number | null;
      status: string;
      event_type: string;
      title: string;
      tick_number: number;
      impact: Record<string, unknown> | null;
    }>(
    `SELECT DISTINCT ON (wm.modifier_type)
         wm.modifier_type,
         wm.source_event_id,
         wm.starts_at_tick,
         wm.ends_at_tick,
         wm.status,
         we.event_type,
         we.title,
         we.tick_number,
         we.impact
       FROM world_modifiers wm
       JOIN world_events we ON we.id = wm.source_event_id
       WHERE wm.modifier_type = ANY($1::text[])
       ORDER BY wm.modifier_type, wm.starts_at_tick DESC, wm.id DESC`,
      [modifierTypes],
    ),
  ]);

  const countMap = new Map(countsResult.rows.map((row) => [row.modifier_type, Number(row.count)]));
  const latestMap = new Map(latestResult.rows.map((row) => [row.modifier_type, row]));

  return Promise.all(
    modifierTypes.map(async (modifierType) => {
      const naturalOccurrenceCount = countMap.get(modifierType) ?? 0;
      const latest = latestMap.get(modifierType);

      if (!latest) {
        return {
          modifierType,
          naturalOccurrenceCount,
          validationStatus: 'missing_natural_sample',
          latestEvent: null,
          latestWindow: null,
          linkedArenaMatch: null,
          activityEvidence: [],
          resolvedScopeValues: [],
          dominantDecisionTraceDelta: null,
          emotionWindow: null,
          note: 'No natural sample exists in the current local dataset.',
        } satisfies WorldModifierNaturalValidationSummary;
      }

      const currentStartTick = latest.starts_at_tick;
      const currentEndTick = latest.ends_at_tick ?? latest.starts_at_tick;
      const windowSize = Math.max(1, currentEndTick - currentStartTick + 1);
      const previousEndTick = Math.max(0, currentStartTick - 1);
      const previousStartTick = Math.max(1, currentStartTick - windowSize);
      const bounds = await buildWindowBoundsForTicks(
        currentStartTick,
        currentEndTick,
        previousStartTick,
        previousEndTick,
      );

      const [decisionTraceComparisons, emotionWindow] = await Promise.all([
        queryDecisionTraceComparisonsForTimeBounds({
          currentStartAt: bounds.currentStartAt,
          currentEndAt: bounds.currentEndAt,
          previousStartAt: bounds.previousStartAt,
          previousEndAt: bounds.previousEndAt,
        }),
        getEmotionWindowComparison(bounds),
      ]);

      const dominantDecisionTraceDelta = getDominantActivityDelta(decisionTraceComparisons);
      const linkedMatchId =
        latest.modifier_type === 'tournament_attention' && latest.impact && typeof latest.impact === 'object'
          ? Number((latest.impact as Record<string, unknown>).matchId ?? Number.NaN)
          : Number.NaN;
      const latestWindow = {
        startTick: currentStartTick,
        endTick: currentEndTick,
        coverage: bounds.coverage,
      } as const;

      if (modifierType === 'tournament_attention') {
        const [activityComparisons, peakActiveArenaComparison, linkedArenaMatchResult, linkedArenaRoundsResult] =
          await Promise.all([
            queryActivityComparisonsForTimeBounds({
              currentStartAt: bounds.currentStartAt,
              currentEndAt: bounds.currentEndAt,
              previousStartAt: bounds.previousStartAt,
              previousEndAt: bounds.previousEndAt,
            }),
            queryPeakActiveArenaComparisonForTickRanges({
              currentStartTick,
              currentEndTick,
              previousStartTick,
              previousEndTick,
            }),
            Number.isFinite(linkedMatchId)
              ? pool.query<{
                  id: number;
                  status: string;
                  total_rounds: number | null;
                  player_a_id: string | null;
                  player_b_id: string | null;
                  settled_at: string | null;
                }>(
                  `SELECT id, status, total_rounds, player_a_id, player_b_id, settled_at
                   FROM arena_matches
                   WHERE id = $1`,
                  [linkedMatchId],
                )
              : Promise.resolve({ rows: [] } as { rows: any[] }),
            Number.isFinite(linkedMatchId)
              ? pool.query<{ rounds: string }>(
                  `SELECT COUNT(*) AS rounds
                   FROM arena_rounds
                   WHERE match_id = $1`,
                  [linkedMatchId],
                )
              : Promise.resolve({ rows: [] } as { rows: any[] }),
          ]);

        const linkedMatch = linkedArenaMatchResult.rows[0] ?? null;
        const linkedArenaMatch = Number.isFinite(linkedMatchId)
          ? {
              matchId: linkedMatchId,
              exists: Boolean(linkedMatch),
              status: linkedMatch?.status ?? null,
              totalRounds: linkedMatch?.total_rounds != null ? Number(linkedMatch.total_rounds) : Number(linkedArenaRoundsResult.rows[0]?.rounds ?? 0),
              playerAId: linkedMatch?.player_a_id ?? null,
              playerBId: linkedMatch?.player_b_id ?? null,
              settledAt: linkedMatch?.settled_at ?? null,
            }
          : null;
        const activityEvidence = [
          ...activityComparisons.filter((entry) => ['arena_created', 'x402_transactions'].includes(entry.metric)),
          peakActiveArenaComparison,
        ];
        const hasBehaviorEvidence =
          Boolean(dominantDecisionTraceDelta) || activityEvidence.some((entry) => entry.delta !== 0);
        const validationStatus =
          bounds.coverage === 'full' && linkedArenaMatch?.exists && hasBehaviorEvidence
            ? 'verified'
            : bounds.coverage !== 'insufficient'
              ? 'partial'
              : 'partial';

        return {
          modifierType,
          naturalOccurrenceCount,
          validationStatus,
          latestEvent: {
            id: latest.source_event_id,
            eventType: latest.event_type,
            title: latest.title,
            tickNumber: latest.tick_number,
            status: latest.status,
          },
          latestWindow,
          linkedArenaMatch,
          activityEvidence,
          resolvedScopeValues: [],
          dominantDecisionTraceDelta,
          emotionWindow: null,
          note:
            validationStatus === 'verified'
              ? (dominantDecisionTraceDelta
                ? 'Natural tournament window exists, the linked match is present, and arena-scene traces are comparable.'
                : 'Natural tournament window exists, the linked match is present, and downstream arena/x402 activity changed in the same bounded window.')
              : 'Natural tournament sample exists and links to a real arena match, but behavioral trace evidence is still partial.',
        } satisfies WorldModifierNaturalValidationSummary;
      }

      if (modifierType === 'social_post_cost_multiplier') {
        const [activityComparisons, sourceModifierRows] = await Promise.all([
          queryActivityComparisonsForTimeBounds({
            currentStartAt: bounds.currentStartAt,
            currentEndAt: bounds.currentEndAt,
            previousStartAt: bounds.previousStartAt,
            previousEndAt: bounds.previousEndAt,
          }),
          pool.query<{
            id: number;
            source_event_id: number | null;
            modifier_type: string;
            domain: string;
            scope_type: string;
            scope_ref: string | null;
            value: Record<string, unknown>;
            starts_at_tick: number;
            ends_at_tick: number | null;
            status: 'active' | 'expired';
            created_at: string;
          }>(
            `SELECT
               id,
               source_event_id,
               modifier_type,
               domain,
               scope_type,
               scope_ref,
               value,
               starts_at_tick,
               ends_at_tick,
               status,
               created_at
             FROM world_modifiers
             WHERE source_event_id = $1
               AND modifier_type = 'social_post_cost_multiplier'
             ORDER BY id ASC`,
            [latest.source_event_id],
          ),
        ]);

        const activityEvidence = activityComparisons.filter((entry) =>
          ['posts', 'replies', 'tips', 'paywall_unlocks'].includes(entry.metric),
        );
        const impact = latest.impact && typeof latest.impact === 'object'
          ? latest.impact as Record<string, unknown>
          : null;
        const heraldAgent = typeof impact?.heraldAgent === 'string' ? impact.heraldAgent : null;
        const suspectAgent = typeof impact?.suspectAgent === 'string' ? impact.suspectAgent : null;
        const sourceModifiers: WorldModifierRecord[] = sourceModifierRows.rows.map((row) => ({
          id: row.id,
          sourceEventId: row.source_event_id,
          modifierType: row.modifier_type,
          domain: row.domain,
          scopeType: row.scope_type,
          scopeRef: row.scope_ref,
          value: row.value,
          startsAtTick: row.starts_at_tick,
          endsAtTick: row.ends_at_tick,
          status: row.status,
          createdAt: row.created_at,
        }));
        const resolvedScopeValues = [heraldAgent, suspectAgent]
          .filter((agentId): agentId is string => Boolean(agentId))
          .map((agentId) => {
            const resolved = resolveWorldModifierValueFromRecords(
              sourceModifiers.filter((modifier) => modifier.scopeRef === agentId),
              'social_post_cost_multiplier',
            );
            return {
              scopeRef: agentId,
              effectiveValue: resolved.effectiveValue,
              contributorCount: resolved.selected.length,
            };
          });

        const roleResolutionPass =
          resolvedScopeValues.length >= 2 &&
          resolvedScopeValues.every((entry) => entry.contributorCount > 0) &&
          resolvedScopeValues.some((entry) => entry.effectiveValue === 0) &&
          resolvedScopeValues.some((entry) => entry.effectiveValue === 2);
        const hasBehaviorEvidence = activityEvidence.some((entry) => entry.delta !== 0);
        const validationStatus =
          bounds.coverage === 'full' && roleResolutionPass && hasBehaviorEvidence
            ? 'verified'
            : bounds.coverage !== 'insufficient'
              ? 'partial'
              : 'partial';

        return {
          modifierType,
          naturalOccurrenceCount,
          validationStatus,
          latestEvent: {
            id: latest.source_event_id,
            eventType: latest.event_type,
            title: latest.title,
            tickNumber: latest.tick_number,
            status: latest.status,
          },
          latestWindow,
          linkedArenaMatch: null,
          activityEvidence,
          resolvedScopeValues,
          dominantDecisionTraceDelta: null,
          emotionWindow: null,
          note:
            validationStatus === 'verified'
              ? 'Natural reputation-contest sample resolved the role-specific post-cost multipliers and the bounded social window changed.'
              : 'Natural reputation-contest sample exists, but role-linked social behavior evidence is still partial.',
        } satisfies WorldModifierNaturalValidationSummary;
      }

      const validationStatus =
        emotionWindow.coverage === 'full' &&
        (emotionWindow.effectiveValenceDelta != null || emotionWindow.effectiveArousalDelta != null)
          ? 'verified'
          : emotionWindow.coverage !== 'insufficient'
            ? 'partial'
            : 'partial';

      return {
        modifierType,
        naturalOccurrenceCount,
        validationStatus,
        latestEvent: {
          id: latest.source_event_id,
          eventType: latest.event_type,
          title: latest.title,
          tickNumber: latest.tick_number,
          status: latest.status,
        },
        latestWindow,
        linkedArenaMatch: null,
        activityEvidence: [],
        resolvedScopeValues: [],
        dominantDecisionTraceDelta: null,
        emotionWindow,
        note:
          validationStatus === 'verified'
            ? 'Natural emotion window exists with comparable effective emotion averages.'
            : 'Natural emotion sample exists, but coverage is still partial.',
      } satisfies WorldModifierNaturalValidationSummary;
    }),
  );
}

async function getEventImpactComparisons(
  tick: number,
  impactWindowTicks: number,
): Promise<WorldEventImpactComparison[]> {
  const pool = getPool();
  const recentEventsResult = await pool.query<{
    id: number;
    event_type: string;
    title: string;
    category: string;
    severity: string;
    status: string;
    tick_number: number;
  }>(
    `SELECT id, event_type, title, category, severity, status, tick_number
     FROM world_events
     WHERE tick_number <= $1
     ORDER BY tick_number DESC, created_at DESC
     LIMIT 4`,
    [tick],
  );

  const comparisons = await Promise.all(recentEventsResult.rows.map(async (event) => {
    const afterBounds = await getTickRangeBounds(
      event.tick_number,
      Math.min(tick, event.tick_number + impactWindowTicks - 1),
    );
    const beforeBounds = await getTickRangeBounds(
      Math.max(1, event.tick_number - impactWindowTicks),
      Math.max(0, event.tick_number - 1),
    );
    const activityComparisons = await queryActivityComparisonsForTimeBounds({
      currentStartAt: afterBounds.startAt,
      currentEndAt: afterBounds.endAt,
      previousStartAt: beforeBounds.startAt,
      previousEndAt: beforeBounds.endAt,
    });
    const overlapResult = await pool.query<{ id: number }>(
      `SELECT id
       FROM world_events
       WHERE id <> $1
         AND tick_number BETWEEN $2 AND $3
       ORDER BY tick_number ASC, created_at ASC`,
      [event.id, afterBounds.startTick, afterBounds.endTick],
    );
    const overlappingEventIds = overlapResult.rows.map((row) => row.id);
    const overlappingEventCount = overlappingEventIds.length;
    const overlapLevel: WorldEventImpactComparison['overlapSummary']['overlapLevel'] = overlappingEventCount === 0
      ? 'isolated'
      : overlappingEventCount === 1
        ? 'mixed'
        : 'crowded';
    const attributionConfidence: WorldEventImpactComparison['overlapSummary']['attributionConfidence'] = overlappingEventCount === 0
      ? 'higher'
      : overlappingEventCount === 1
        ? 'medium'
        : 'lower';

    return {
      event: {
        id: event.id,
        eventType: event.event_type,
        title: event.title,
        category: event.category,
        severity: event.severity,
        status: event.status,
        tickNumber: event.tick_number,
      },
      windowSizeTicks: impactWindowTicks,
      beforeBounds,
      afterBounds,
      overlapSummary: {
        overlappingEventCount,
        overlappingEventIds,
        overlapLevel,
        attributionConfidence,
      },
      activityComparisons,
      dominantActivityDelta: getDominantActivityDelta(activityComparisons),
    } satisfies WorldEventImpactComparison;
  }));

  return comparisons;
}

export async function getAgentWorldExposure(
  agentId: string,
  recentTickWindow: number = 20,
): Promise<AgentExposureSummary> {
  const pool = getPool();
  const latestSignal = await getLatestWorldSignalSnapshot();
  const tick = Math.max(getCurrentTick(), latestSignal?.tickNumber ?? 0);
  const activeModifiers = await resolveActiveWorldModifiers({
    scopeRefs: [agentId],
    includeGlobal: true,
    limit: 100,
  });
  const recentEventsResult = await pool.query<{
    id: number;
    event_type: string;
    title: string;
    category: string;
    severity: string;
    tick_number: number;
    status: string;
    affected_agents: string[] | null;
    scope_type: string;
    scope_ref: string | null;
    created_at: string;
  }>(
    `SELECT
       id,
       event_type,
       title,
       category,
       severity,
       tick_number,
       status,
       affected_agents,
       scope_type,
       scope_ref,
       created_at
     FROM world_events
     WHERE tick_number >= GREATEST($2, 0)
       AND (
         scope_type = 'global'
         OR scope_ref = $1
         OR ($1 = ANY(COALESCE(affected_agents, ARRAY[]::text[])))
       )
     ORDER BY tick_number DESC, created_at DESC
     LIMIT 25`,
    [agentId, tick - recentTickWindow],
  );

  const domainCounts = countByKey(activeModifiers.map((modifier) => modifier.domain)).map((entry) => ({
    domain: entry.key,
    count: entry.count,
  }));

  return {
    agentId,
    tick,
    worldRegime: latestSignal?.worldRegime ?? 'stable',
    globalModifierCount: activeModifiers.filter((modifier) => modifier.scopeType === 'global').length,
    scopedModifierCount: activeModifiers.filter((modifier) => modifier.scopeType !== 'global').length,
    recentEventCount: recentEventsResult.rows.length,
    activeModifiers,
    modifierStacks: summarizeWorldModifierStacks(activeModifiers),
    recentEvents: recentEventsResult.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      title: row.title,
      category: row.category,
      severity: row.severity,
      tickNumber: row.tick_number,
      status: row.status,
      affectedAgents: row.affected_agents ?? [],
      scopeType: row.scope_type,
      scopeRef: row.scope_ref,
      createdAt: row.created_at,
    })),
    domainCounts,
  };
}

export async function getWorldAnalyticsSummary(
  recentTickWindow: number = 20,
): Promise<WorldAnalyticsSummary> {
  const pool = getPool();
  const latestSignal = await getLatestWorldSignalSnapshot();
  const latestTickRun = await getLatestWorldTickRun();
  const tick = Math.max(getCurrentTick(), latestSignal?.tickNumber ?? 0);
  const windowBounds = await getAnalyticsWindowBounds(tick, recentTickWindow);
  const [activeEventCount, activeModifierCount, activeModifiers, recentEventsResult] = await Promise.all([
    getActiveWorldEventCount(),
    getActiveWorldModifierCount(),
    resolveActiveWorldModifiers({ includeGlobal: true, limit: 200 }),
    pool.query<{
      category: string;
      severity: string;
      status: string;
    }>(
      `SELECT category, severity, status
       FROM world_events
       WHERE tick_number >= GREATEST($1, 0)`,
      [tick - recentTickWindow],
    ),
  ]);
  const [activityComparisons, eventImpactComparisons, modifierValidation] = await Promise.all([
    getWindowedActivityComparisons(windowBounds),
    getEventImpactComparisons(tick, 5),
    getModifierValidationSummary(windowBounds, activeModifiers),
  ]);
  const consumerCoverage = getConsumerCoverageSummary(activeModifiers, modifierValidation);
  const consumerIntegrationProgress = getConsumerIntegrationProgress(consumerCoverage);

  return {
    tick,
    worldRegime: latestSignal?.worldRegime ?? 'stable',
    activeEventCount,
    activeModifierCount,
    latestTickRun,
    windowBounds,
    activityComparisons,
    eventImpactComparisons,
    modifierValidation,
    consumerCoverage,
    consumerIntegrationProgress,
    modifierDomainCounts: countByKey(activeModifiers.map((modifier) => modifier.domain)).map((entry) => ({
      domain: entry.key,
      count: entry.count,
    })),
    modifierTypeCounts: countByKey(activeModifiers.map((modifier) => modifier.modifierType)).map((entry) => ({
      modifierType: entry.key,
      count: entry.count,
    })),
    recentEventCategoryCounts: countByKey(recentEventsResult.rows.map((row) => row.category)).map((entry) => ({
      category: entry.key,
      count: entry.count,
    })),
    recentEventSeverityCounts: countByKey(recentEventsResult.rows.map((row) => row.severity)).map((entry) => ({
      severity: entry.key,
      count: entry.count,
    })),
    recentEventStatusCounts: countByKey(recentEventsResult.rows.map((row) => row.status)).map((entry) => ({
      status: entry.key,
      count: entry.count,
    })),
  };
}

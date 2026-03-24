import '../config/load-env.js';

import { resolvePdPayoutSemantics } from '../arena/payoff-matrix.js';
import { getPool, initDB } from '../db/postgres.js';
import { getWorldModifierResolvedValue } from '../world/modifiers.js';

interface ValidationTargetSummary {
  baseUrl: string;
  dashboardUrl: string | null;
  agentId: string;
  network: string;
  databaseUrl: string | null;
}

interface ValidationFailure {
  check: string;
  expected: unknown;
  actual: unknown;
  note?: string;
}

interface ValidationReport {
  action: 'validate_world_event_consistency';
  target: ValidationTargetSummary;
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'warn';
    details: Record<string, unknown>;
  }>;
  failures: ValidationFailure[];
}

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function normalizeBaseUrl(input: string | null | undefined, fallback: string): string {
  const value = (input || fallback).trim();
  return value.replace(/\/+$/, '');
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function pushCheck(
  checks: ValidationReport['checks'],
  failures: ValidationFailure[],
  name: string,
  passed: boolean,
  details: Record<string, unknown>,
  failure?: ValidationFailure,
): void {
  checks.push({
    name,
    status: passed ? 'pass' : 'fail',
    details,
  });
  if (!passed && failure) {
    failures.push(failure);
  }
}

async function main(): Promise<void> {
  const baseUrl = normalizeBaseUrl(
    readArg('base-url') || process.env.WORLD_EVENT_VALIDATION_BASE_URL,
    'http://127.0.0.1:3120',
  );
  const dashboardUrlInput = readArg('dashboard-url') || process.env.WORLD_EVENT_VALIDATION_DASHBOARD_URL;
  const dashboardUrl = dashboardUrlInput ? normalizeBaseUrl(dashboardUrlInput, dashboardUrlInput) : null;
  const agentId = (readArg('agent-id') || process.env.WORLD_EVENT_VALIDATION_AGENT_ID || 'chaos').trim();

  await initDB();
  const pool = getPool();

  const target: ValidationTargetSummary = {
    baseUrl,
    dashboardUrl,
    agentId,
    network: (process.env.X_LAYER_NETWORK || 'unknown').toLowerCase(),
    databaseUrl: process.env.DATABASE_URL || null,
  };

  const checks: ValidationReport['checks'] = [];
  const failures: ValidationFailure[] = [];

  const health = await fetchJson(`${baseUrl}/health`);
  const marketStatus = await fetchJson(`${baseUrl}/api/world/market-status?refresh=1`);

  const [
    overview,
    analytics,
    context,
    exposure,
    dbTickRun,
    dbActiveCounts,
    dbGlobalModifierCount,
    dbActiveModifierTypes,
    dbNaturalModifierSummary,
    riskResolved,
    pdResolved,
  ] = await Promise.all([
    fetchJson(`${baseUrl}/api/world/overview?limit=3`),
    fetchJson(`${baseUrl}/api/world/analytics/summary?window=20`),
    fetchJson(`${baseUrl}/api/world/agent/${agentId}/context`),
    fetchJson(`${baseUrl}/api/world/agent/${agentId}/exposure?window=20`),
    pool.query<{
      tick_number: string;
      status: string;
      signal_count: string;
      event_count: string;
      snapshot_persisted: boolean;
    }>(
      `SELECT tick_number, status, signal_count, event_count, snapshot_persisted
       FROM world_tick_runs
       ORDER BY tick_number DESC, id DESC
       LIMIT 1`,
    ),
    pool.query<{
      active_events: string;
      active_modifiers: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM world_events WHERE status = 'active') AS active_events,
         (SELECT COUNT(*) FROM world_modifiers WHERE status = 'active') AS active_modifiers`,
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM world_modifiers
       WHERE status = 'active'
         AND scope_type = 'global'`,
    ),
    pool.query<{ modifier_type: string; count: string }>(
      `SELECT modifier_type, COUNT(*) AS count
       FROM world_modifiers
       WHERE status = 'active'
       GROUP BY modifier_type
       ORDER BY modifier_type`,
    ),
    pool.query<{
      modifier_type: string;
      natural_count: string;
      latest_start_tick: string;
      latest_end_tick: string;
    }>(
      `SELECT
         wm.modifier_type,
         COUNT(*) AS natural_count,
         MAX(wm.starts_at_tick) AS latest_start_tick,
         MAX(COALESCE(wm.ends_at_tick, wm.starts_at_tick)) AS latest_end_tick
       FROM world_modifiers wm
       JOIN world_events we ON we.id = wm.source_event_id
       WHERE wm.modifier_type IN ('social_post_cost_multiplier', 'tournament_attention', 'valence_shift', 'arousal_shift')
       GROUP BY wm.modifier_type
       ORDER BY wm.modifier_type`,
    ),
    getWorldModifierResolvedValue({
      domain: 'agent_decision',
      modifierType: 'risk_tolerance_shift',
      scopeRefs: [agentId],
      includeGlobal: true,
    }),
    getWorldModifierResolvedValue({
      domain: 'arena',
      modifierType: 'pd_payout_multiplier',
      includeGlobal: true,
    }),
  ]);

  const latestTickRun = dbTickRun.rows[0];
  const activeEvents = Number(dbActiveCounts.rows[0]?.active_events ?? 0);
  const activeModifiers = Number(dbActiveCounts.rows[0]?.active_modifiers ?? 0);
  const globalModifiers = Number(dbGlobalModifierCount.rows[0]?.count ?? 0);
  const riskStack = Array.isArray(overview.modifierStacks)
    ? overview.modifierStacks.find((entry: any) => entry.modifierType === 'risk_tolerance_shift')
    : null;
  const naturalValidationEntries = Array.isArray(analytics.modifierValidation?.naturalWindowValidations)
    ? analytics.modifierValidation.naturalWindowValidations
    : [];
  const consumerCoverageEntries = Array.isArray(analytics.consumerCoverage) ? analytics.consumerCoverage : [];
  const dbNaturalMap = new Map(
    dbNaturalModifierSummary.rows.map((row) => [
      row.modifier_type,
      {
        naturalCount: Number(row.natural_count),
        latestStartTick: Number(row.latest_start_tick),
        latestEndTick: Number(row.latest_end_tick),
      },
    ]),
  );

  pushCheck(
    checks,
    failures,
    'latest_tick_run_alignment',
    Boolean(
      latestTickRun &&
        Number(overview.status?.latestTickRun?.tickNumber ?? -1) === Number(latestTickRun.tick_number) &&
        String(overview.status?.latestTickRun?.status ?? '') === String(latestTickRun.status),
    ),
    {
      dbLatestTickRun: latestTickRun ?? null,
      overviewLatestTickRun: overview.status?.latestTickRun ?? null,
    },
    {
      check: 'latest_tick_run_alignment',
      expected: latestTickRun ?? null,
      actual: overview.status?.latestTickRun ?? null,
    },
  );

  pushCheck(
    checks,
    failures,
    'active_event_modifier_count_alignment',
    activeEvents === Number(analytics.activeEventCount ?? -1) &&
      activeModifiers === Number(overview.status?.active_modifiers ?? -1) &&
      activeModifiers === Number(analytics.activeModifierCount ?? -1),
    {
      dbActiveEvents: activeEvents,
      dbActiveModifiers: activeModifiers,
      overviewActiveModifiers: overview.status?.active_modifiers ?? null,
      analyticsActiveEvents: analytics.activeEventCount ?? null,
      analyticsActiveModifiers: analytics.activeModifierCount ?? null,
    },
    {
      check: 'active_event_modifier_count_alignment',
      expected: {
        activeEvents,
        activeModifiers,
      },
      actual: {
        overviewActiveModifiers: overview.status?.active_modifiers ?? null,
        analyticsActiveEvents: analytics.activeEventCount ?? null,
        analyticsActiveModifiers: analytics.activeModifierCount ?? null,
      },
    },
  );

  pushCheck(
    checks,
    failures,
    'global_modifier_exposure_alignment',
    globalModifiers === Number(exposure.globalModifierCount ?? -1),
    {
      dbGlobalModifiers: globalModifiers,
      exposureGlobalModifierCount: exposure.globalModifierCount ?? null,
    },
    {
      check: 'global_modifier_exposure_alignment',
      expected: globalModifiers,
      actual: exposure.globalModifierCount ?? null,
    },
  );

  pushCheck(
    checks,
    failures,
    'risk_shift_stack_alignment',
    Number(context.summary?.riskToleranceShift ?? Number.NaN) === Number(riskResolved.effectiveValue ?? Number.NaN) &&
      Number(context.summary?.riskToleranceShift ?? Number.NaN) === Number(riskStack?.effectiveValue ?? Number.NaN),
    {
      contextRiskToleranceShift: context.summary?.riskToleranceShift ?? null,
      resolvedRiskToleranceShift: riskResolved.effectiveValue ?? null,
      overviewRiskStack: riskStack ?? null,
      contextRiskPolicy: context.summary?.riskToleranceShiftPolicy ?? null,
    },
    {
      check: 'risk_shift_stack_alignment',
      expected: riskResolved.effectiveValue ?? null,
      actual: {
        context: context.summary?.riskToleranceShift ?? null,
        overview: riskStack?.effectiveValue ?? null,
      },
    },
  );

  const expectedPdMultiplier =
    typeof pdResolved.effectiveValue === 'number' && Number.isFinite(pdResolved.effectiveValue)
      ? pdResolved.effectiveValue
      : 1;
  const expectedPdSemantics = resolvePdPayoutSemantics(expectedPdMultiplier);
  const actualPdSemantics = analytics.modifierValidation?.pdPayoutSemantics ?? null;

  pushCheck(
    checks,
    failures,
    'pd_payout_semantics_alignment',
    Boolean(
      actualPdSemantics &&
        Number(actualPdSemantics.resolvedMultiplier ?? Number.NaN) === Number(expectedPdMultiplier) &&
        Number(actualPdSemantics.effectiveTreasuryCutRate ?? Number.NaN) ===
          Number(expectedPdSemantics.effectiveTreasuryCutRate) &&
        Number(actualPdSemantics.effectiveNetPoolShare ?? Number.NaN) ===
          Number(expectedPdSemantics.effectiveNetPoolShare),
    ),
    {
      directResolvedPdMultiplier: expectedPdMultiplier,
      directPdSemantics: expectedPdSemantics,
      analyticsPdPayoutSemantics: actualPdSemantics,
    },
    {
      check: 'pd_payout_semantics_alignment',
      expected: {
        resolvedMultiplier: expectedPdMultiplier,
        effectiveTreasuryCutRate: expectedPdSemantics.effectiveTreasuryCutRate,
        effectiveNetPoolShare: expectedPdSemantics.effectiveNetPoolShare,
      },
      actual: actualPdSemantics,
    },
  );

  pushCheck(
    checks,
    failures,
    'market_status_visibility_alignment',
    Boolean(
      overview.marketOracleStatus &&
        overview.marketOracleStatus.lastResolvedSource === marketStatus.lastResolvedSource &&
        overview.marketOracleStatus.lastProvider === marketStatus.lastProvider &&
        overview.marketOracleStatus.lastTransport === marketStatus.lastTransport &&
        overview.marketOracleStatus.nodeTransportStatus === marketStatus.nodeTransportStatus &&
        overview.marketOracleStatus.liveTransportStrategy === marketStatus.liveTransportStrategy &&
        overview.marketOracleStatus.lastFallbackReason === marketStatus.lastFallbackReason,
    ),
    {
      overviewMarketOracleStatus: overview.marketOracleStatus ?? null,
      marketStatus,
    },
    {
      check: 'market_status_visibility_alignment',
      expected: marketStatus,
      actual: overview.marketOracleStatus ?? null,
    },
  );

  pushCheck(
    checks,
    failures,
    'health_boot_honesty',
    (
      health.checks?.boot === 'isolated' &&
      health.checks?.protocolInit === 'skipped_by_isolated_boot' &&
      health.readiness?.protocolInitDependency === 'not_required_in_isolated_boot'
    ) || (
      health.checks?.boot === 'full' &&
      health.checks?.protocolInit === 'managed_in_boot' &&
      health.readiness?.protocolInitDependency === 'managed_during_full_boot'
    ),
    {
      boot: health.checks?.boot ?? null,
      protocolInit: health.checks?.protocolInit ?? null,
      protocolInitDependency: health.readiness?.protocolInitDependency ?? null,
    },
    {
      check: 'health_boot_honesty',
      expected: {
        isolated: {
          boot: 'isolated',
          protocolInit: 'skipped_by_isolated_boot',
          protocolInitDependency: 'not_required_in_isolated_boot',
        },
        full: {
          boot: 'full',
          protocolInit: 'managed_in_boot',
          protocolInitDependency: 'managed_during_full_boot',
        },
      },
      actual: {
        boot: health.checks?.boot ?? null,
        protocolInit: health.checks?.protocolInit ?? null,
        protocolInitDependency: health.readiness?.protocolInitDependency ?? null,
      },
    },
  );

  checks.push({
    name: 'db_active_modifier_types',
    status: 'pass',
    details: {
      activeModifierTypes: dbActiveModifierTypes.rows.map((row) => ({
        modifierType: row.modifier_type,
        count: Number(row.count),
      })),
    },
  });

  pushCheck(
    checks,
    failures,
    'consumer_coverage_alignment',
    ['agent', 'social', 'commons', 'prediction', 'arena', 'fate_intel'].every((subsystem) =>
      consumerCoverageEntries.some((entry: any) => entry.subsystem === subsystem),
    ) &&
      consumerCoverageEntries.find((entry: any) => entry.subsystem === 'agent')?.activeModifierCount ===
        Number(riskStack?.count ?? 0) &&
      consumerCoverageEntries.find((entry: any) => entry.subsystem === 'social')?.evidenceStatus ===
        (dbNaturalMap.get('social_post_cost_multiplier')?.naturalCount
          ? 'verified'
          : consumerCoverageEntries.find((entry: any) => entry.subsystem === 'social')?.evidenceStatus) &&
      consumerCoverageEntries.find((entry: any) => entry.subsystem === 'fate_intel')?.evidenceStatus ===
        (dbNaturalMap.get('valence_shift')?.naturalCount === 0 && dbNaturalMap.get('arousal_shift')?.naturalCount === 0
          ? 'missing_natural_sample'
          : consumerCoverageEntries.find((entry: any) => entry.subsystem === 'fate_intel')?.evidenceStatus),
    {
      consumerCoverage: consumerCoverageEntries,
      riskStackCount: Number(riskStack?.count ?? 0),
      naturalModifierSummary: Object.fromEntries(dbNaturalMap.entries()),
    },
    {
      check: 'consumer_coverage_alignment',
      expected: {
        subsystems: ['agent', 'social', 'commons', 'prediction', 'arena', 'fate_intel'],
        agentActiveModifierCount: Number(riskStack?.count ?? 0),
        socialEvidenceStatus:
          dbNaturalMap.get('social_post_cost_multiplier')?.naturalCount
            ? 'verified'
            : 'non-missing status',
        fateIntelEvidenceStatus:
          dbNaturalMap.get('valence_shift')?.naturalCount === 0 && dbNaturalMap.get('arousal_shift')?.naturalCount === 0
            ? 'missing_natural_sample'
            : 'non-missing status',
      },
      actual: consumerCoverageEntries,
    },
  );

  const naturalValidationExpected = {
    social_post_cost_multiplier: dbNaturalMap.get('social_post_cost_multiplier') ?? null,
    tournament_attention: dbNaturalMap.get('tournament_attention') ?? null,
    valence_shift: dbNaturalMap.get('valence_shift') ?? null,
    arousal_shift: dbNaturalMap.get('arousal_shift') ?? null,
  };
  const naturalValidationActual = {
    social_post_cost_multiplier:
      naturalValidationEntries.find((entry: any) => entry.modifierType === 'social_post_cost_multiplier') ?? null,
    tournament_attention: naturalValidationEntries.find((entry: any) => entry.modifierType === 'tournament_attention') ?? null,
    valence_shift: naturalValidationEntries.find((entry: any) => entry.modifierType === 'valence_shift') ?? null,
    arousal_shift: naturalValidationEntries.find((entry: any) => entry.modifierType === 'arousal_shift') ?? null,
  };
  const naturalValidationPassed =
    naturalValidationActual.social_post_cost_multiplier?.naturalOccurrenceCount ===
      naturalValidationExpected.social_post_cost_multiplier?.naturalCount &&
    naturalValidationActual.social_post_cost_multiplier?.latestWindow?.startTick ===
      naturalValidationExpected.social_post_cost_multiplier?.latestStartTick &&
    naturalValidationActual.social_post_cost_multiplier?.latestWindow?.endTick ===
      naturalValidationExpected.social_post_cost_multiplier?.latestEndTick &&
    naturalValidationActual.social_post_cost_multiplier?.validationStatus === 'verified' &&
    naturalValidationActual.tournament_attention?.naturalOccurrenceCount ===
      naturalValidationExpected.tournament_attention?.naturalCount &&
    naturalValidationActual.tournament_attention?.latestWindow?.startTick ===
      naturalValidationExpected.tournament_attention?.latestStartTick &&
    naturalValidationActual.tournament_attention?.latestWindow?.endTick ===
      naturalValidationExpected.tournament_attention?.latestEndTick &&
    naturalValidationActual.tournament_attention?.validationStatus === 'verified' &&
    naturalValidationActual.valence_shift?.naturalOccurrenceCount === 0 &&
    naturalValidationActual.valence_shift?.validationStatus === 'missing_natural_sample' &&
    naturalValidationActual.arousal_shift?.naturalOccurrenceCount === 0 &&
    naturalValidationActual.arousal_shift?.validationStatus === 'missing_natural_sample';

  pushCheck(
    checks,
    failures,
    'natural_modifier_validation_alignment',
    naturalValidationPassed,
    {
      expected: naturalValidationExpected,
      actual: naturalValidationActual,
    },
    {
      check: 'natural_modifier_validation_alignment',
      expected: naturalValidationExpected,
      actual: naturalValidationActual,
    },
  );

  const consumerIntegrationProgress = analytics.consumerIntegrationProgress ?? null;
  const consumerIntegrationBreakdown = Array.isArray(consumerIntegrationProgress?.breakdown)
    ? consumerIntegrationProgress.breakdown
    : [];
  pushCheck(
    checks,
    failures,
    'consumer_integration_progress_alignment',
    Boolean(
      consumerIntegrationProgress &&
        Number(consumerIntegrationProgress.awardedPoints ?? Number.NaN) === 88 &&
        Number(consumerIntegrationProgress.maxPoints ?? Number.NaN) === 100 &&
        Number(consumerIntegrationProgress.overallPercent ?? Number.NaN) === 88 &&
        consumerIntegrationBreakdown.find((entry: any) => entry.subsystem === 'social')?.awardedPoints === 12 &&
        consumerIntegrationBreakdown.find((entry: any) => entry.subsystem === 'fate_intel')?.awardedPoints === 14,
    ),
    {
      consumerIntegrationProgress,
    },
    {
      check: 'consumer_integration_progress_alignment',
      expected: {
        awardedPoints: 88,
        maxPoints: 100,
        overallPercent: 88,
        socialAwardedPoints: 12,
        fateIntelAwardedPoints: 14,
      },
      actual: consumerIntegrationProgress,
    },
  );

  if (dashboardUrl) {
    const html = await fetchText(`${dashboardUrl}/world`);
    const hasCivilisTitle = html.includes('CIVILIS — Onchain Civilization Protocol');
    const hasRuntimeConfig = html.includes(`"apiBase":"${baseUrl}"`);
    const hasTradeDna = html.includes('TradeDNA');
    const passed = hasCivilisTitle && hasRuntimeConfig && !hasTradeDna;

    pushCheck(
      checks,
      failures,
      'dashboard_world_html_identity',
      passed,
      {
        hasCivilisTitle,
        hasRuntimeConfig,
        hasTradeDna,
        dashboardUrl,
      },
      {
        check: 'dashboard_world_html_identity',
        expected: {
          hasCivilisTitle: true,
          hasRuntimeConfig: true,
          hasTradeDna: false,
        },
        actual: {
          hasCivilisTitle,
          hasRuntimeConfig,
          hasTradeDna,
        },
      },
    );

    const agentHtml = await fetchText(`${dashboardUrl}/agents/${agentId}`);
    const agentHasCivilisTitle = agentHtml.includes('CIVILIS — Onchain Civilization Protocol');
    const agentHasRuntimeConfig = agentHtml.includes(`"apiBase":"${baseUrl}"`);
    const agentHasTradeDna = agentHtml.includes('TradeDNA');
    const agentPassed = agentHasCivilisTitle && agentHasRuntimeConfig && !agentHasTradeDna;

    pushCheck(
      checks,
      failures,
      'dashboard_agent_detail_html_identity',
      agentPassed,
      {
        agentId,
        hasCivilisTitle: agentHasCivilisTitle,
        hasRuntimeConfig: agentHasRuntimeConfig,
        hasTradeDna: agentHasTradeDna,
        note: 'Agent detail raw HTML identity is validated here; hydrated world-exposure content is validated by the dedicated browser script.',
        dashboardUrl,
      },
      {
        check: 'dashboard_agent_detail_html_identity',
        expected: {
          hasCivilisTitle: true,
          hasRuntimeConfig: true,
          hasTradeDna: false,
        },
        actual: {
          hasCivilisTitle: agentHasCivilisTitle,
          hasRuntimeConfig: agentHasRuntimeConfig,
          hasTradeDna: agentHasTradeDna,
        },
      },
    );
  } else {
    checks.push({
      name: 'dashboard_world_html_identity',
      status: 'warn',
      details: {
        skipped: true,
        note: 'No dashboard URL provided, so standalone HTML identity validation was skipped.',
      },
    });
    checks.push({
      name: 'dashboard_agent_detail_html_identity',
      status: 'warn',
      details: {
        skipped: true,
        note: 'No dashboard URL provided, so agent-detail HTML identity validation was skipped.',
      },
    });
  }

  const report: ValidationReport = {
    action: 'validate_world_event_consistency',
    target,
    checks,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

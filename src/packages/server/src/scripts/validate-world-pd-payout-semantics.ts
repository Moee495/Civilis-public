import '../config/load-env.js';

import { calculatePayoff, resolvePdPayoutSemantics } from '../arena/payoff-matrix.js';
import { getPool, initDB } from '../db/postgres.js';
import { persistWorldEvent } from '../world/events.js';
import { getWorldAnalyticsSummary } from '../world/exposure.js';
import { getWorldModifierResolvedValue } from '../world/modifiers.js';

function summarizeDatabaseTarget(databaseUrl: string | undefined): {
  host: string | null;
  database: string | null;
  safetyClass: 'local' | 'staging_like' | 'unknown_remote';
} {
  if (!databaseUrl) {
    return { host: null, database: null, safetyClass: 'unknown_remote' };
  }

  try {
    const parsed = new URL(databaseUrl);
    const database = parsed.pathname.replace(/^\//, '') || null;
    const loweredHost = (parsed.hostname || '').toLowerCase();
    const loweredDatabase = (database || '').toLowerCase();
    const safetyClass =
      loweredHost === 'localhost' || loweredHost === '127.0.0.1'
        ? 'local'
        : loweredHost.includes('test') ||
            loweredHost.includes('staging') ||
            loweredDatabase.includes('test') ||
            loweredDatabase.includes('staging')
          ? 'staging_like'
          : 'unknown_remote';

    return {
      host: parsed.host || null,
      database,
      safetyClass,
    };
  } catch {
    return { host: null, database: null, safetyClass: 'unknown_remote' };
  }
}

async function pickValidationTick(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ next_tick: string }>(
    `SELECT GREATEST(
       COALESCE((SELECT MAX(tick_number) FROM world_signals), 0),
       COALESCE((SELECT MAX(tick_number) FROM tick_snapshots), 0),
       COALESCE((SELECT MAX(tick_number) FROM world_tick_runs), 0),
       COALESCE((SELECT MAX(tick_number) FROM economy_state), 0)
     ) + 1 AS next_tick`,
  );
  return Number(result.rows[0]?.next_tick ?? 1);
}

async function insertSyntheticSignals(tick: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO world_signals
      (tick_number, signal_type, signal_key, signal_value, payload, source)
     VALUES
      ($1, 'macro', 'validation_macro', 0, $2, 'validation_script'),
      ($1, 'social', 'validation_social', 0, $3, 'validation_script')`,
    [
      tick,
      JSON.stringify({
        economyPhase: 'stable',
        validation: true,
      }),
      JSON.stringify({
        validation: true,
        activeMatches: 0,
      }),
    ],
  );
}

async function cleanupValidationArtifacts(tick: number, eventIds: number[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM world_signals
     WHERE tick_number = $1
       AND source = 'validation_script'`,
    [tick],
  );
  if (eventIds.length > 0) {
    await pool.query('DELETE FROM world_modifiers WHERE source_event_id = ANY($1::int[])', [eventIds]);
    await pool.query('DELETE FROM world_events WHERE id = ANY($1::int[])', [eventIds]);
  }
}

async function main(): Promise<void> {
  const network = (process.env.X_LAYER_NETWORK || 'testnet').toLowerCase();
  const databaseTarget = summarizeDatabaseTarget(process.env.DATABASE_URL);

  if (network === 'mainnet') {
    throw new Error('Refusing to run PD payout semantics validation while X_LAYER_NETWORK=mainnet');
  }
  if (databaseTarget.safetyClass === 'unknown_remote') {
    throw new Error('Refusing to run PD payout semantics validation on an unknown remote DATABASE_URL target');
  }

  await initDB();

  const tick = await pickValidationTick();
  const createdEventIds: number[] = [];

  try {
    await insertSyntheticSignals(tick);

    const goldenAge = await persistWorldEvent(
      {
        type: 'golden_age',
        title: 'Synthetic PD Payout Validation',
        description: 'Local-only validation event for PD payout semantics.',
        affected: [],
        impact: {
          pdPayoutMultiplier: 1.2,
          commonsMultiplierBonus: 0,
          predictionOddsBonus: 0,
          duration: 5,
        },
      },
      tick,
    );
    createdEventIds.push(goldenAge.id);

    const [pdResolved, analytics, modifierCountResult] = await Promise.all([
      getWorldModifierResolvedValue({
        domain: 'arena',
        modifierType: 'pd_payout_multiplier',
        includeGlobal: true,
      }),
      getWorldAnalyticsSummary(20),
      getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM world_modifiers
         WHERE status = 'active'
           AND source_event_id = ANY($1::int[])
           AND modifier_type = 'pd_payout_multiplier'`,
        [createdEventIds],
      ),
    ]);

    const resolvedMultiplier =
      typeof pdResolved.effectiveValue === 'number' && Number.isFinite(pdResolved.effectiveValue)
        ? pdResolved.effectiveValue
        : 1;
    const directSemantics = resolvePdPayoutSemantics(resolvedMultiplier);
    const baselineCooperate = calculatePayoff('cooperate', 'cooperate', 2, 'prisoners_dilemma', {
      pdPayoutMultiplier: 1,
    });
    const effectiveCooperate = calculatePayoff('cooperate', 'cooperate', 2, 'prisoners_dilemma', {
      pdPayoutMultiplier: resolvedMultiplier,
    });

    console.log(
      JSON.stringify(
        {
          action: 'validate_world_pd_payout_semantics',
          network,
          databaseTarget,
          validationTick: tick,
          createdEventIds,
          activeSyntheticPdModifiers: Number(modifierCountResult.rows[0]?.count ?? 0),
          resolvedMultiplier,
          directSemantics,
          analyticsPdPayoutSemantics: analytics.modifierValidation.pdPayoutSemantics,
          sampleComparison: {
            baselineCooperateEach: baselineCooperate.playerAPayout,
            effectiveCooperateEach: effectiveCooperate.playerAPayout,
            baselineTreasuryCC: baselineCooperate.treasuryDelta,
            effectiveTreasuryCC: effectiveCooperate.treasuryDelta,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanupValidationArtifacts(tick, createdEventIds);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

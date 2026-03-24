import '../config/load-env.js';
import { getPool, initDB } from '../db/postgres.js';
import { persistWorldEvent } from '../world/events.js';
import { getWorldAnalyticsSummary } from '../world/exposure.js';
import { captureWorldTickSnapshot } from '../world/tick-engine.js';

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
  await pool.query('DELETE FROM tick_snapshots WHERE tick_number = $1', [tick]);
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
    throw new Error('Refusing to run world modifier observability validation while X_LAYER_NETWORK=mainnet');
  }
  if (databaseTarget.safetyClass === 'unknown_remote') {
    throw new Error('Refusing to run world modifier observability validation on an unknown remote DATABASE_URL target');
  }

  await initDB();

  const tick = await pickValidationTick();
  const createdEventIds: number[] = [];

  try {
    await insertSyntheticSignals(tick);

    const lostBeacon = await persistWorldEvent(
      {
        type: 'lost_beacon',
        title: 'Synthetic Lost Beacon Validation',
        description: 'Local-only validation event for emotion modifier observability.',
        affected: [],
        impact: {
          allAgentValence: -0.3,
          allAgentArousal: 0.2,
          duration: 10,
        },
      },
      tick,
    );
    createdEventIds.push(lostBeacon.id);

    const tournament = await persistWorldEvent(
      {
        type: 'tournament',
        title: 'Synthetic Tournament Validation',
        description: 'Local-only validation event for tournament-attention observability.',
        affected: [],
        impact: {
          matchId: 'synthetic-validation-match',
          duration: 5,
        },
      },
      tick,
    );
    createdEventIds.push(tournament.id);

    await captureWorldTickSnapshot({ tick, worldRegime: 'stable' });

    const pool = getPool();
    const [snapshotResult, modifierCountsResult, analytics] = await Promise.all([
      pool.query<{
        tick_number: number;
        average_valence: string | null;
        average_arousal: string | null;
        effective_average_valence: string | null;
        effective_average_arousal: string | null;
      }>(
        `SELECT
           tick_number,
           average_valence,
           average_arousal,
           effective_average_valence,
           effective_average_arousal
         FROM tick_snapshots
         WHERE tick_number = $1`,
        [tick],
      ),
      pool.query<{ modifier_type: string; count: string }>(
        `SELECT modifier_type, COUNT(*) AS count
         FROM world_modifiers
         WHERE status = 'active'
           AND source_event_id = ANY($1::int[])
         GROUP BY modifier_type
         ORDER BY modifier_type`,
        [createdEventIds],
      ),
      getWorldAnalyticsSummary(20),
    ]);

    console.log(
      JSON.stringify(
        {
          action: 'validate_world_modifier_observability',
          network,
          databaseTarget,
          validationTick: tick,
          createdEventIds,
          modifierCounts: modifierCountsResult.rows.map((row) => ({
            modifierType: row.modifier_type,
            count: Number(row.count),
          })),
          snapshot: snapshotResult.rows[0]
            ? {
                tickNumber: snapshotResult.rows[0].tick_number,
                rawAverageValence:
                  snapshotResult.rows[0].average_valence != null
                    ? Number(snapshotResult.rows[0].average_valence)
                    : null,
                rawAverageArousal:
                  snapshotResult.rows[0].average_arousal != null
                    ? Number(snapshotResult.rows[0].average_arousal)
                    : null,
                effectiveAverageValence:
                  snapshotResult.rows[0].effective_average_valence != null
                    ? Number(snapshotResult.rows[0].effective_average_valence)
                    : null,
                effectiveAverageArousal:
                  snapshotResult.rows[0].effective_average_arousal != null
                    ? Number(snapshotResult.rows[0].effective_average_arousal)
                    : null,
              }
            : null,
          analytics: {
            tick: analytics.tick,
            modifierValidation: analytics.modifierValidation,
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

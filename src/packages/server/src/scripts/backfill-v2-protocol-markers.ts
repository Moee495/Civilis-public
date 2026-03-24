import '../config/load-env.js';
import { getPool } from '../db/postgres.js';

function summarizeDatabaseTarget(databaseUrl: string | undefined): {
  host: string | null;
  database: string | null;
  safetyClass: 'local' | 'staging_like' | 'unknown_remote';
} {
  if (!databaseUrl) {
    return {
      host: null,
      database: null,
      safetyClass: 'unknown_remote',
    };
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
    return {
      host: null,
      database: null,
      safetyClass: 'unknown_remote',
    };
  }
}

type MarkerColumns = {
  acp_jobs: { protocol_version: boolean; sync_state: boolean };
  agents: { erc8004_registration_mode: boolean };
  erc8004_feedback: { sync_state: boolean };
  erc8004_validations: { sync_state: boolean };
};

interface MarkerCoverageSnapshot {
  acpJobs: { legacy: string; v2: string; mixed: string; unmarked: string };
  agents: { legacy: string; v2: string; mixed: string; unmarked: string };
  feedback: { legacy: string; v2: string; mixed: string; unmarked: string };
  validations: { legacy: string; v2: string; mixed: string; unmarked: string };
}

async function loadMarkerColumns() {
  const pool = getPool();
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'acp_jobs' AND column_name IN ('protocol_version', 'sync_state')) OR
         (table_name = 'agents' AND column_name IN ('erc8004_registration_mode')) OR
         (table_name = 'erc8004_feedback' AND column_name IN ('sync_state')) OR
         (table_name = 'erc8004_validations' AND column_name IN ('sync_state'))
       )
     ORDER BY table_name, column_name`,
  );

  const columns: MarkerColumns = {
    acp_jobs: { protocol_version: false, sync_state: false },
    agents: { erc8004_registration_mode: false },
    erc8004_feedback: { sync_state: false },
    erc8004_validations: { sync_state: false },
  };

  for (const row of result.rows) {
    (columns as Record<string, Record<string, boolean>>)[row.table_name][row.column_name] = true;
  }

  return columns;
}

async function loadCoverageSnapshot(): Promise<MarkerCoverageSnapshot> {
  const pool = getPool();
  const [acpJobs, agents, feedback, validations] = await Promise.all([
    pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE protocol_version = 'legacy')::text AS legacy,
         COUNT(*) FILTER (WHERE protocol_version = 'v2' AND sync_state = 'v2')::text AS v2,
         COUNT(*) FILTER (WHERE sync_state = 'mixed')::text AS mixed,
         COUNT(*) FILTER (WHERE protocol_version IS NULL OR sync_state IS NULL)::text AS unmarked
       FROM acp_jobs`,
    ),
    pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE erc8004_registration_mode = 'legacy')::text AS legacy,
         COUNT(*) FILTER (WHERE erc8004_registration_mode = 'v2')::text AS v2,
         COUNT(*) FILTER (WHERE erc8004_registration_mode = 'mixed')::text AS mixed,
         COUNT(*) FILTER (WHERE erc8004_registration_mode IS NULL)::text AS unmarked
       FROM agents`,
    ),
    pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE sync_state = 'legacy')::text AS legacy,
         COUNT(*) FILTER (WHERE sync_state = 'v2')::text AS v2,
         COUNT(*) FILTER (WHERE sync_state = 'mixed')::text AS mixed,
         COUNT(*) FILTER (WHERE sync_state IS NULL)::text AS unmarked
       FROM erc8004_feedback`,
    ),
    pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE sync_state = 'legacy')::text AS legacy,
         COUNT(*) FILTER (WHERE sync_state = 'v2')::text AS v2,
         COUNT(*) FILTER (WHERE sync_state = 'mixed')::text AS mixed,
         COUNT(*) FILTER (WHERE sync_state IS NULL)::text AS unmarked
       FROM erc8004_validations`,
    ),
  ]);

  return {
    acpJobs: acpJobs.rows[0],
    agents: agents.rows[0],
    feedback: feedback.rows[0],
    validations: validations.rows[0],
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const network = (process.env.X_LAYER_NETWORK || 'testnet').toLowerCase();
  const databaseTarget = summarizeDatabaseTarget(process.env.DATABASE_URL);
  const markerColumns = await loadMarkerColumns();
  const allRequiredColumnsPresent =
    markerColumns.acp_jobs.protocol_version &&
    markerColumns.acp_jobs.sync_state &&
    markerColumns.agents.erc8004_registration_mode &&
    markerColumns.erc8004_feedback.sync_state &&
    markerColumns.erc8004_validations.sync_state;

  const safeToExecute =
    network !== 'mainnet' &&
    databaseTarget.safetyClass !== 'unknown_remote' &&
    allRequiredColumnsPresent;
  const pool = getPool();
  const before = allRequiredColumnsPresent ? await loadCoverageSnapshot() : null;

  const plannedUpdates = allRequiredColumnsPresent
    ? {
        acpJobs: await pool.query<{ rows_to_update: string }>(
          `SELECT COUNT(*)::text AS rows_to_update
           FROM acp_jobs
           WHERE protocol_version IS NULL OR sync_state IS NULL`,
        ).then((result) => result.rows[0]),
        agents: await pool.query<{ rows_to_update: string }>(
          `SELECT COUNT(*)::text AS rows_to_update
           FROM agents
           WHERE erc8004_registration_mode IS NULL`,
        ).then((result) => result.rows[0]),
        feedback: await pool.query<{ rows_to_update: string }>(
          `SELECT COUNT(*)::text AS rows_to_update
           FROM erc8004_feedback
           WHERE sync_state IS NULL`,
        ).then((result) => result.rows[0]),
        validations: await pool.query<{ rows_to_update: string }>(
          `SELECT COUNT(*)::text AS rows_to_update
           FROM erc8004_validations
           WHERE sync_state IS NULL`,
        ).then((result) => result.rows[0]),
      }
    : null;

  if (execute) {
    if (!safeToExecute) {
      throw new Error(
        'Execution denied: require non-mainnet target, non-production-like DATABASE_URL, and all marker columns present.',
      );
    }

    const updatedCounts = {
      acpJobs: 0,
      agents: 0,
      feedback: 0,
      validations: 0,
    };

    await pool.query('BEGIN');
    try {
      updatedCounts.acpJobs = Number(
        (
          await pool.query<{ count: string }>(
            `WITH updated AS (
               UPDATE acp_jobs
               SET
                 protocol_version = COALESCE(
                   protocol_version,
                   CASE
                     WHEN COALESCE(metadata->>'onChainProtocolVersion', '') = 'v2' THEN 'v2'
                     ELSE 'legacy'
                   END
                 ),
                 sync_state = COALESCE(
                   sync_state,
                   CASE
                     WHEN COALESCE(metadata->>'onChainProtocolVersion', '') = 'v2' AND on_chain_tx_hash IS NOT NULL THEN 'v2'
                     WHEN COALESCE(metadata->>'onChainProtocolVersion', '') = 'v2' THEN 'mixed'
                     ELSE 'legacy'
                   END
                 )
               WHERE protocol_version IS NULL OR sync_state IS NULL
               RETURNING 1
             )
             SELECT COUNT(*)::text AS count FROM updated`,
          )
        ).rows[0].count,
      );

      updatedCounts.agents = Number(
        (
          await pool.query<{ count: string }>(
            `WITH updated AS (
               UPDATE agents
               SET erc8004_registration_mode = COALESCE(erc8004_registration_mode, 'legacy')
               WHERE erc8004_registration_mode IS NULL
               RETURNING 1
             )
             SELECT COUNT(*)::text AS count FROM updated`,
          )
        ).rows[0].count,
      );

      updatedCounts.feedback = Number(
        (
          await pool.query<{ count: string }>(
            `WITH updated AS (
               UPDATE erc8004_feedback
               SET sync_state = COALESCE(sync_state, 'legacy')
               WHERE sync_state IS NULL
               RETURNING 1
             )
             SELECT COUNT(*)::text AS count FROM updated`,
          )
        ).rows[0].count,
      );

      updatedCounts.validations = Number(
        (
          await pool.query<{ count: string }>(
            `WITH updated AS (
               UPDATE erc8004_validations
               SET sync_state = COALESCE(sync_state, 'legacy')
               WHERE sync_state IS NULL
               RETURNING 1
             )
             SELECT COUNT(*)::text AS count FROM updated`,
          )
        ).rows[0].count,
      );

      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

    const after = await loadCoverageSnapshot();

    console.log(JSON.stringify({
      mode: 'execute',
      network,
      databaseTarget,
      markerColumns,
      safeToExecute,
      plannedUpdates,
      updatedCounts,
      before,
      after,
      note: 'Only protocol/version/sync markers were updated.',
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    mode: 'dry_run_only',
    network,
    databaseTarget,
    purpose: 'Preview protocol marker backfill steps for legacy/v2/mixed records',
    markerColumns,
    safeToExecute,
    before,
    plannedUpdates,
    plannedTargets: [
      'acp_jobs.protocol_version',
      'acp_jobs.sync_state',
      'agents.erc8004_registration_mode',
      'erc8004_feedback.sync_state',
      'erc8004_validations.sync_state',
    ],
    prerequisites: [
      'schema columns must exist',
      'final v2 addresses must be deployed',
      'preflight must pass without placeholder blockers',
      'explicit migration approval required',
    ],
    note: 'No writes performed.',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

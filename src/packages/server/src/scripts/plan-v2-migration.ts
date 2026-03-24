import '../config/load-env.js';
import { getPool } from '../db/postgres.js';

function summarizeDatabaseTarget(databaseUrl: string | undefined): {
  source: string;
  host: string | null;
  database: string | null;
  safetyClass: 'local' | 'staging_like' | 'unknown_remote';
} {
  if (!databaseUrl) {
    return {
      source: 'unset',
      host: null,
      database: null,
      safetyClass: 'unknown_remote',
    };
  }

  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.host || null;
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
      source: 'env:DATABASE_URL',
      host,
      database,
      safetyClass,
    };
  } catch {
    return {
      source: 'env:DATABASE_URL',
      host: null,
      database: null,
      safetyClass: 'unknown_remote',
    };
  }
}

async function main(): Promise<void> {
  const pool = getPool();
  const databaseTarget = summarizeDatabaseTarget(process.env.DATABASE_URL);

  const [agents, jobs, feedback, validations, markerColumns] = await Promise.all([
    pool.query<{ total: string; with_token: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE erc8004_token_id IS NOT NULL)::text AS with_token
       FROM agents`,
    ),
    pool.query<{ total: string; onchain: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE on_chain_tx_hash IS NOT NULL)::text AS onchain
       FROM acp_jobs`,
    ),
    pool.query<{ total: string; onchain: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE on_chain_tx_hash IS NOT NULL)::text AS onchain
       FROM erc8004_feedback`,
    ),
    pool.query<{ total: string; responded: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE response_tx_hash IS NOT NULL)::text AS responded
       FROM erc8004_validations`,
    ),
    pool.query<{ table_name: string; column_name: string }>(
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
    ),
  ]);

  const markerSummary = {
    acp_jobs: {
      protocol_version: false,
      sync_state: false,
    },
    agents: {
      erc8004_registration_mode: false,
    },
    erc8004_feedback: {
      sync_state: false,
    },
    erc8004_validations: {
      sync_state: false,
    },
  };

  for (const row of markerColumns.rows) {
    if (row.table_name in markerSummary) {
      (markerSummary as Record<string, Record<string, boolean>>)[row.table_name][row.column_name] = true;
    }
  }

  const markerCoverage = markerSummary.acp_jobs.protocol_version &&
    markerSummary.acp_jobs.sync_state &&
    markerSummary.agents.erc8004_registration_mode &&
    markerSummary.erc8004_feedback.sync_state &&
    markerSummary.erc8004_validations.sync_state
    ? {
        acpJobs: await pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE protocol_version = 'legacy')::text AS legacy,
             COUNT(*) FILTER (WHERE protocol_version = 'v2' AND sync_state = 'v2')::text AS v2,
             COUNT(*) FILTER (WHERE sync_state = 'mixed')::text AS mixed,
             COUNT(*) FILTER (WHERE protocol_version IS NULL OR sync_state IS NULL)::text AS unmarked
           FROM acp_jobs`,
        ).then((result) => result.rows[0]),
        agents: await pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE erc8004_registration_mode = 'legacy')::text AS legacy,
             COUNT(*) FILTER (WHERE erc8004_registration_mode = 'v2')::text AS v2,
             COUNT(*) FILTER (WHERE erc8004_registration_mode = 'mixed')::text AS mixed,
             COUNT(*) FILTER (WHERE erc8004_registration_mode IS NULL)::text AS unmarked
           FROM agents`,
        ).then((result) => result.rows[0]),
        feedback: await pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE sync_state = 'legacy')::text AS legacy,
             COUNT(*) FILTER (WHERE sync_state = 'v2')::text AS v2,
             COUNT(*) FILTER (WHERE sync_state = 'mixed')::text AS mixed,
             COUNT(*) FILTER (WHERE sync_state IS NULL)::text AS unmarked
           FROM erc8004_feedback`,
        ).then((result) => result.rows[0]),
        validations: await pool.query<{ legacy: string; v2: string; mixed: string; unmarked: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE sync_state = 'legacy')::text AS legacy,
             COUNT(*) FILTER (WHERE sync_state = 'v2')::text AS v2,
             COUNT(*) FILTER (WHERE sync_state = 'mixed')::text AS mixed,
             COUNT(*) FILTER (WHERE sync_state IS NULL)::text AS unmarked
           FROM erc8004_validations`,
        ).then((result) => result.rows[0]),
      }
    : null;

  console.log(JSON.stringify({
    phase: 'planning_only',
    databaseTarget,
    writeMode: {
      oldContracts: 'read_only',
      newContracts: 'write_path',
    },
    suggestedDataMarkers: {
      protocolVersion: ['legacy', 'v2'],
      syncState: ['legacy', 'mixed', 'v2'],
      addressSource: ['v2_env', 'legacy_env_alias', 'unset'],
    },
    inventory: {
      agents: agents.rows[0],
      acpJobs: jobs.rows[0],
      feedback: feedback.rows[0],
      validations: validations.rows[0],
    },
    markerColumns: markerSummary,
    markerCoverage,
    automaticBackfillCandidates: [
      'agent token registration mode markers',
      'acp local rows with on-chain tx hash present',
      'feedback rows with on_chain_tx_hash present',
      'validation rows with response_tx_hash present',
    ],
    manualConfirmationRequired: [
      'final v2 contract addresses',
      'legacy alias retirement timing',
      'schema changes for protocol_version / sync_state if not already present',
      'production cutover window',
    ],
    note: 'This script is read-only and does not perform migration writes.',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

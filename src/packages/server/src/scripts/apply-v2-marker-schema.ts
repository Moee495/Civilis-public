import '../config/load-env.js';
import { getPool, initDB } from '../db/postgres.js';

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

async function readMarkerColumns() {
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

  return {
    acp_jobs: {
      protocol_version: result.rows.some((row) => row.table_name === 'acp_jobs' && row.column_name === 'protocol_version'),
      sync_state: result.rows.some((row) => row.table_name === 'acp_jobs' && row.column_name === 'sync_state'),
    },
    agents: {
      erc8004_registration_mode: result.rows.some(
        (row) => row.table_name === 'agents' && row.column_name === 'erc8004_registration_mode',
      ),
    },
    erc8004_feedback: {
      sync_state: result.rows.some((row) => row.table_name === 'erc8004_feedback' && row.column_name === 'sync_state'),
    },
    erc8004_validations: {
      sync_state: result.rows.some((row) => row.table_name === 'erc8004_validations' && row.column_name === 'sync_state'),
    },
  };
}

async function readAcpJobIndexes() {
  const pool = getPool();
  const result = await pool.query<{ indexname: string }>(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'acp_jobs'
       AND indexname IN (
         'idx_acp_jobs_on_chain_job_id_unique',
         'idx_acp_jobs_on_chain_job_id',
         'idx_acp_jobs_protocol_job_unique'
       )
     ORDER BY indexname`,
  );

  return {
    legacyUnique: result.rows.some((row) => row.indexname === 'idx_acp_jobs_on_chain_job_id_unique'),
    plainLookup: result.rows.some((row) => row.indexname === 'idx_acp_jobs_on_chain_job_id'),
    protocolScopedUnique: result.rows.some((row) => row.indexname === 'idx_acp_jobs_protocol_job_unique'),
  };
}

async function main(): Promise<void> {
  const network = (process.env.X_LAYER_NETWORK || 'testnet').toLowerCase();
  const databaseTarget = summarizeDatabaseTarget(process.env.DATABASE_URL);

  if (network === 'mainnet') {
    throw new Error('Refusing to apply marker schema while X_LAYER_NETWORK=mainnet');
  }
  if (databaseTarget.safetyClass === 'unknown_remote') {
    throw new Error('Refusing to apply marker schema to an unknown remote DATABASE_URL target');
  }

  const before = {
    markerColumns: await readMarkerColumns(),
    acpJobIndexes: await readAcpJobIndexes(),
  };
  await initDB();
  const after = {
    markerColumns: await readMarkerColumns(),
    acpJobIndexes: await readAcpJobIndexes(),
  };

  console.log(JSON.stringify({
    action: 'apply_v2_marker_schema',
    network,
    databaseTarget,
    before,
    after,
    note: 'Schema changes are additive and non-destructive, and ACP job uniqueness is now protocol-version scoped to support legacy/v2 coexistence.',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

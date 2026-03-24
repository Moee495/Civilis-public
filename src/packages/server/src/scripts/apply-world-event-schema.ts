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

async function readWorldSchemaState() {
  const pool = getPool();
  const tableResult = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('world_signals', 'world_modifiers', 'world_event_runs', 'world_tick_runs')
     ORDER BY table_name`,
  );
  const columnResult = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'world_events' AND column_name IN (
           'category', 'severity', 'scope_type', 'scope_ref', 'starts_at_tick', 'ends_at_tick', 'source_signal_ref', 'engine_version', 'status'
         )) OR
         (table_name = 'tick_snapshots' AND column_name IN (
           'world_regime', 'active_modifier_count', 'active_event_count', 'average_valence', 'average_arousal',
           'effective_average_valence', 'effective_average_arousal'
         )) OR
         (table_name = 'world_tick_runs' AND column_name IN ('signals_written_at', 'events_written_at', 'snapshot_written_at'))
       )
     ORDER BY table_name, column_name`,
  );

  return {
    tables: tableResult.rows.map((row) => row.table_name),
    worldEventColumns: columnResult.rows
      .filter((row) => row.table_name === 'world_events')
      .map((row) => row.column_name),
    tickSnapshotColumns: columnResult.rows
      .filter((row) => row.table_name === 'tick_snapshots')
      .map((row) => row.column_name),
    worldTickRunColumns: columnResult.rows
      .filter((row) => row.table_name === 'world_tick_runs')
      .map((row) => row.column_name),
  };
}

async function main(): Promise<void> {
  const network = (process.env.X_LAYER_NETWORK || 'testnet').toLowerCase();
  const databaseTarget = summarizeDatabaseTarget(process.env.DATABASE_URL);

  if (network === 'mainnet') {
    throw new Error('Refusing to apply world-event schema while X_LAYER_NETWORK=mainnet');
  }
  if (databaseTarget.safetyClass === 'unknown_remote') {
    throw new Error('Refusing to apply world-event schema to an unknown remote DATABASE_URL target');
  }

  const before = await readWorldSchemaState();
  await initDB();
  const after = await readWorldSchemaState();

  console.log(
    JSON.stringify(
      {
        action: 'apply_world_event_schema',
        network,
        databaseTarget,
        before,
        after,
        note: 'Schema changes are additive and enable world signal snapshots, active modifiers, and event evaluation audit trails.',
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

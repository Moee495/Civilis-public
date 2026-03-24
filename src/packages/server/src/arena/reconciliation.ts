import { getPool } from '../db/postgres.js';

/**
 * Heal stale arena states caused by timeouts or old concurrent writes.
 * This keeps read paths and the world tick consistent even if earlier
 * requests left rows in an outdated status.
 */
export async function reconcileArenaMatchStates(): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE arena_matches
     SET status = 'settled'
     WHERE settled_at IS NOT NULL
       AND status <> 'settled'`,
  );

  await pool.query(
    `UPDATE arena_matches
     SET status = 'deciding'
     WHERE settled_at IS NULL
       AND status = 'negotiating'
       AND negotiation_deadline IS NOT NULL
       AND negotiation_deadline < NOW()`,
  );
}

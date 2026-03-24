import '../config/load-env.js';
import { getPool } from '../db/postgres.js';

const SELF_AUTHORED_TAGS = [
  'commons_cooperation',
  'commons_sabotage',
  'prediction_accuracy',
  'prediction_miss',
  'intel_accuracy',
  'intel_fraud',
] as const;

async function main(): Promise<void> {
  const pool = getPool();

  const before = await pool.query<{
    tag1: string;
    count: string;
  }>(
    `SELECT tag1, COUNT(*)::text AS count
     FROM erc8004_feedback
     WHERE client_address = 'mock_evaluator'
       AND tag1 = ANY($1::text[])
       AND on_chain_tx_hash IS NULL
     GROUP BY tag1
     ORDER BY tag1`,
    [SELF_AUTHORED_TAGS],
  );

  const updated = await pool.query<{
    id: number;
    tag1: string;
    client_address: string;
  }>(
    `WITH rewired AS (
       UPDATE erc8004_feedback f
       SET client_address = a.wallet_address,
           sync_state = 'legacy'
       FROM agents a
       WHERE f.agent_erc8004_id = a.erc8004_token_id
         AND f.client_address = 'mock_evaluator'
         AND f.tag1 = ANY($1::text[])
         AND f.on_chain_tx_hash IS NULL
         AND a.wallet_address ~ '^0x[0-9a-fA-F]{40}$'
       RETURNING f.id, f.tag1, f.client_address
     )
     SELECT id, tag1, client_address
     FROM rewired
     ORDER BY id`,
    [SELF_AUTHORED_TAGS],
  );

  const after = await pool.query<{
    tag1: string;
    count: string;
  }>(
    `SELECT tag1, COUNT(*)::text AS count
     FROM erc8004_feedback
     WHERE client_address = 'mock_evaluator'
       AND tag1 = ANY($1::text[])
       AND on_chain_tx_hash IS NULL
     GROUP BY tag1
     ORDER BY tag1`,
    [SELF_AUTHORED_TAGS],
  );

  console.log(
    JSON.stringify(
      {
        action: 'backfill_feedback_client_addresses',
        selfAuthoredTags: SELF_AUTHORED_TAGS,
        before: before.rows,
        updatedCount: updated.rowCount,
        sample: updated.rows.slice(0, 20),
        after: after.rows,
      },
      null,
      2,
    ),
  );

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

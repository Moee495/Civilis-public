import '../config/load-env.js';
import { initDB, getPool, withTransaction } from '../db/postgres.js';

type TxRow = {
  id: number;
  tx_type: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  amount: string;
  metadata: Record<string, unknown> | null;
};

async function main(): Promise<void> {
  await initDB();
  const pool = getPool();

  const pending = await pool.query<TxRow>(
    `SELECT id, tx_type, from_agent_id, to_agent_id, amount, metadata
     FROM x402_transactions
     WHERE from_agent_id IS NOT NULL
       AND COALESCE(onchain_status, 'local_confirmed') <> 'confirmed'
       AND COALESCE(onchain_status, 'local_confirmed') <> 'local_confirmed'
     ORDER BY id ASC`,
  );

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM chain_settlements
       WHERE settlement_kind IN ('x402_payment_submit', 'x402_payment_batch_submit')`,
    );

    if (!pending.rows.length) {
      return;
    }

    await client.query(
      `UPDATE x402_transactions
       SET tx_hash = NULL,
           onchain_payment_id = NULL,
           onchain_status = 'queued',
           onchain_attempts = 0,
           onchain_error = NULL
       WHERE id = ANY($1::int[])`,
      [pending.rows.map((row) => row.id)],
    );

    for (const row of pending.rows) {
      await client.query(
        `INSERT INTO chain_settlements
          (settlement_kind, reference_table, reference_id, from_agent_id, to_agent_id, amount, tx_type, metadata, status)
         VALUES ('x402_payment_submit', 'x402_transactions', $1, $2, $3, $4, $5, $6, 'queued')`,
        [
          row.id,
          row.from_agent_id,
          row.to_agent_id ?? 'treasury',
          row.amount,
          row.tx_type,
          JSON.stringify({
            payments: [
              {
                txId: row.id,
                txType: row.tx_type,
                fromAgentId: row.from_agent_id,
                toAgentId: row.to_agent_id ?? 'treasury',
                amount: Number(row.amount),
                metadata: row.metadata ?? {},
              },
            ],
          }),
        ],
      );
    }
  });

  console.log(`[x402] Rebuilt ${pending.rows.length} settlement jobs`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

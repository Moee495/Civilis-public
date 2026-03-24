import { ethers } from 'ethers';
import { getPool } from '../db/postgres.js';
import { validationRegistry } from '../erc8004/validation-registry.js';

async function main(): Promise<void> {
  const pool = getPool();
  const result = await pool.query<{
    intel_item_id: number;
    category: string;
    producer_agent_id: string;
    producer_token_id: number;
    content: unknown;
  }>(
    `SELECT DISTINCT
       i.id AS intel_item_id,
       i.category,
       i.producer_agent_id,
       a.erc8004_token_id AS producer_token_id,
       i.content
     FROM intel_purchases p
     JOIN intel_items i ON i.id = p.intel_item_id
     JOIN agents a ON a.agent_id = i.producer_agent_id
     LEFT JOIN erc8004_validations v ON v.intel_item_id = i.id
     WHERE v.id IS NULL
       AND a.erc8004_token_id IS NOT NULL
     ORDER BY i.id ASC`,
  );

  let created = 0;

  for (const row of result.rows) {
    const contentHash = ethers.id(JSON.stringify(row.content ?? {}));
    const request = await validationRegistry.requestValidation({
      producerTokenId: Number(row.producer_token_id),
      intelItemId: Number(row.intel_item_id),
      category: row.category,
      contentHash,
    });

    created++;
    console.log(
      `[IntelValidationBackfill] item #${row.intel_item_id} (${row.category}) -> ${request.requestHash} tx=${request.txHash ?? 'local-only'}`,
    );
  }

  console.log(JSON.stringify({ created, scanned: result.rows.length }));
}

main().catch((error) => {
  console.error('[IntelValidationBackfill] failed:', error);
  process.exit(1);
});

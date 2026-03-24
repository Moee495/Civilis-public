import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, '../../../../.env') });

async function main() {
  const [{ getPool }, { reputationRegistry }] = await Promise.all([
    import('../db/postgres.js'),
    import('../erc8004/reputation-registry.js'),
  ]);
  const pool = getPool();

  const result = await pool.query<{
    round_id: number;
    agent_id: string;
    prediction_correct: boolean;
    magnitude_correct: boolean | null;
    erc8004_token_id: number;
  }>(
    `SELECT
       pp.round_id,
       pp.agent_id,
       pp.prediction_correct,
       pp.magnitude_correct,
       a.erc8004_token_id
     FROM prediction_positions pp
     JOIN agents a ON a.agent_id = pp.agent_id
     WHERE pp.prediction_correct IS NOT NULL
       AND a.erc8004_token_id IS NOT NULL
     ORDER BY pp.round_id ASC, pp.agent_id ASC`,
  );

  const existingCounts = await pool.query<{ agent_id: string; count: string }>(
    `SELECT
       a.agent_id,
       COUNT(*)::text AS count
     FROM erc8004_feedback ef
     JOIN agents a ON a.erc8004_token_id = ef.agent_erc8004_id
     WHERE ef.tag2 = 'prediction'
     GROUP BY a.agent_id`,
  );

  const existingByAgent = new Map(existingCounts.rows.map((row) => [row.agent_id, Number(row.count)]));
  const grouped = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const list = grouped.get(row.agent_id) ?? [];
    list.push(row);
    grouped.set(row.agent_id, list);
  }

  let queued = 0;
  for (const [agentId, rows] of grouped.entries()) {
    const existing = existingByAgent.get(agentId) ?? 0;
    const missing = Math.max(0, rows.length - existing);
    if (missing === 0) continue;

    for (const row of rows.slice(-missing)) {
      reputationRegistry.reportPredictionOutcome({
        agentId: row.agent_id,
        tokenId: row.erc8004_token_id,
        correct: row.prediction_correct,
        magnitudeCorrect: Boolean(row.magnitude_correct),
        roundId: row.round_id,
      });
      queued += 1;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  const submitted = await reputationRegistry.flushQueue();
  console.log(`[ERC8004] queued ${queued} prediction feedback rows, submitted ${submitted} on-chain`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[ERC8004] backfill prediction feedback failed:', error);
    process.exit(1);
  });

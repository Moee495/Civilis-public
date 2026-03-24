import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db/postgres.js';
import { ACP_CONTRACT_ABI } from '../erc8183/acp-abi.js';
import { getXLayerRpcUrl } from '../config/xlayer.js';

type ACPJobRow = {
  id: number;
  on_chain_job_id: number;
  on_chain_tx_hash: string | null;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(SCRIPT_DIR, '../../../../');

dotenv.config({ path: path.join(SRC_ROOT, '.env') });

const configuredACPAddress = process.env.ACP_CONTRACT_ADDRESS;

if (!configuredACPAddress) {
  throw new Error('ACP_CONTRACT_ADDRESS is not configured');
}
const acpAddress = configuredACPAddress;

const provider = new ethers.JsonRpcProvider(getXLayerRpcUrl());
const acpInterface = new ethers.Interface(ACP_CONTRACT_ABI);

function extractJobCreatedId(
  receipt: ethers.TransactionReceipt | null,
  contractAddress: string,
): number | null {
  if (!receipt) {
    return null;
  }

  const normalized = contractAddress.toLowerCase();

  for (const log of receipt.logs) {
    if ((log.address ?? '').toLowerCase() !== normalized) {
      continue;
    }

    try {
      const parsed = acpInterface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });

      if (parsed?.name !== 'JobCreated') {
        continue;
      }

      const jobId = Number(parsed.args?.jobId ?? parsed.args?.[0] ?? NaN);
      if (Number.isFinite(jobId) && jobId >= 0) {
        return jobId;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function main(): Promise<void> {
  const pool = getPool();
  const rows = await pool.query<ACPJobRow>(
    `SELECT id, on_chain_job_id, on_chain_tx_hash
     FROM acp_jobs
     WHERE on_chain_tx_hash IS NOT NULL
     ORDER BY id ASC`,
  );

  let updated = 0;
  let missingReceipt = 0;
  let missingEvent = 0;

  for (const row of rows.rows) {
    if (!row.on_chain_tx_hash) {
      continue;
    }

    const receipt = await provider.getTransactionReceipt(row.on_chain_tx_hash);
    if (!receipt) {
      missingReceipt += 1;
      continue;
    }

    const resolvedJobId = extractJobCreatedId(receipt, acpAddress);
    if (resolvedJobId === null) {
      missingEvent += 1;
      continue;
    }

    if (resolvedJobId === row.on_chain_job_id) {
      continue;
    }

    await pool.query(
      `UPDATE acp_jobs
       SET on_chain_job_id = $2
       WHERE id = $1`,
      [row.id, resolvedJobId],
    );
    updated += 1;
  }

  const duplicateResult = await pool.query<{
    on_chain_job_id: number;
    count: number;
    local_ids: number[];
  }>(
    `SELECT
       on_chain_job_id,
       COUNT(*)::int AS count,
       array_agg(id ORDER BY id) AS local_ids
     FROM acp_jobs
     GROUP BY on_chain_job_id
     HAVING COUNT(*) > 1
     ORDER BY on_chain_job_id ASC`,
  );

  console.log(
    JSON.stringify(
      {
        scanned: rows.rowCount,
        updated,
        missingReceipt,
        missingEvent,
        remainingDuplicates: duplicateResult.rows,
      },
      null,
      2,
    ),
  );

  if (duplicateResult.rows.length > 0) {
    process.exitCode = 1;
  }
}

await main();

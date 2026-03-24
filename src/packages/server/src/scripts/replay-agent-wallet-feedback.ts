import '../config/load-env.js';
import { ethers } from 'ethers';
import { getPool } from '../db/postgres.js';
import { initOkxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import { initERC8004 } from '../standards/erc8004.js';
import { getSharedProvider } from '../onchainos/shared-signers.js';
import { reputationRegistry } from '../erc8004/reputation-registry.js';

const REPUTATION_ABI = [
  'event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)',
] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  initOkxTeeWallet();
  initERC8004();

  const pool = getPool();
  const provider = getSharedProvider();
  const iface = new ethers.Interface(REPUTATION_ABI);

  const walletRows = await pool.query<{ wallet_address: string }>(
    'SELECT wallet_address FROM agents WHERE wallet_address IS NOT NULL ORDER BY agent_id',
  );
  const walletAddresses = walletRows.rows.map((row) => row.wallet_address.toLowerCase());

  const countsBefore = await pool.query<{ sync_state: string | null; count: string }>(
    `SELECT COALESCE(sync_state, 'legacy') AS sync_state, COUNT(*)::text AS count
     FROM erc8004_feedback
     WHERE on_chain_tx_hash IS NULL
     GROUP BY COALESCE(sync_state, 'legacy')
     ORDER BY COALESCE(sync_state, 'legacy')`,
  );

  const reactivatedClients = await pool.query<{ id: number }>(
    `UPDATE erc8004_feedback
     SET sync_state = 'legacy'
     WHERE on_chain_tx_hash IS NULL
       AND sync_state = 'blocked_client'
       AND LOWER(client_address) = ANY($1::text[])
       AND agent_erc8004_id BETWEEN 1 AND 8
     RETURNING id`,
    [walletAddresses],
  );

  const reactivatedIds = reactivatedClients.rows.map((row) => row.id);

  const submittedBatches: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pendingBefore = await reputationRegistry.getPendingFeedbackCount();
    if (pendingBefore === 0) {
      break;
    }

    const submitted = await reputationRegistry.flushQueue();
    submittedBatches.push(submitted);

    const pendingAfter = await reputationRegistry.getPendingFeedbackCount();
    if (submitted === 0 && pendingAfter === pendingBefore) {
      break;
    }

    await delay(750);
  }

  const countsAfter = await pool.query<{ sync_state: string | null; count: string }>(
    `SELECT COALESCE(sync_state, 'legacy') AS sync_state, COUNT(*)::text AS count
     FROM erc8004_feedback
     WHERE on_chain_tx_hash IS NULL
     GROUP BY COALESCE(sync_state, 'legacy')
     ORDER BY COALESCE(sync_state, 'legacy')`,
  );

  const recentlySynced = await pool.query<{
    id: number;
    agent_erc8004_id: number;
    client_address: string;
    tag1: string | null;
    on_chain_tx_hash: string;
  }>(
    `SELECT id, agent_erc8004_id, client_address, tag1, on_chain_tx_hash
     FROM erc8004_feedback
     WHERE id = ANY($1::int[])
       AND on_chain_tx_hash IS NOT NULL
     ORDER BY id DESC
     LIMIT 20`,
    [reactivatedIds.length > 0 ? reactivatedIds : [0]],
  );

  const receipts = [];
  for (const row of recentlySynced.rows) {
    const receipt = await provider.getTransactionReceipt(row.on_chain_tx_hash);
    const parsed = receipt?.logs
      .map((log) => {
        try {
          return iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.name === 'NewFeedback');

    receipts.push({
      id: row.id,
      tokenId: row.agent_erc8004_id,
      tag1: row.tag1,
      txHash: row.on_chain_tx_hash,
      expectedClient: row.client_address,
      eventClient: parsed ? String(parsed.args[1]) : null,
    });
  }

  console.log(
    JSON.stringify(
      {
        action: 'erc8004_reputation_replay',
        reactivatedBlockedClientRows: reactivatedIds.length,
        submittedBatches,
        countsBefore: countsBefore.rows,
        countsAfter: countsAfter.rows,
        onchainReceipts: receipts,
      },
      null,
      2,
    ),
  );

  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[ERC8004-REP] replay agent wallet feedback failed:', error);
    process.exit(1);
  });

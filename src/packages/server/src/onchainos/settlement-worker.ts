/**
 * Async Settlement Worker
 *
 * Runs independently from the world tick. It first submits queued local-first
 * x402 payments to chain, then checks submitted transactions for confirmation.
 */

import { getPool } from '../db/postgres.js';
import { isX402DirectWalletMode } from '../config/xlayer.js';
import {
  getX402MaxRetries,
  loadQueuedPayments,
  X402QueuedPayment,
} from '../x402/payment-processor.js';
import {
  creditAgentOnchainBalance,
  getAgentWalletAddress,
  getOnchainBalance,
  getTreasuryUsdtBalance,
} from '../agents/wallet-sync.js';
import { x402Bridge } from './x402bridge.js';
import { okxTeeWallet } from './okx-tee-wallet.js';
import { getSharedProvider } from './shared-signers.js';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let cleanupHandle: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;
const WORKER_INTERVAL_MS = 10_000;
const MAX_QUEUED_SETTLEMENTS_PER_CYCLE = 100;
const MAX_SUBMITTED_SETTLEMENTS_PER_CYCLE = 100;
const RECEIPT_LOOKUP_TIMEOUT_MS = 8_000;

type SettlementRow = {
  id: number;
  settlement_kind: string | null;
  reference_id: number | null;
  tx_hash: string | null;
  order_id: string | null;
  metadata: Record<string, unknown> | null;
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function resolveSubmittedStatus(
  provider: ReturnType<typeof getSharedProvider>,
  row: SettlementRow,
): Promise<'pending' | 'confirmed' | 'failed'> {
  const orderId = row.order_id ?? row.tx_hash ?? '';
  if (!orderId) {
    return 'pending';
  }

  if (
    orderId.startsWith('0xmock') ||
    orderId.startsWith('mock-') ||
    orderId.startsWith('local-')
  ) {
    return 'confirmed';
  }

  if (orderId.startsWith('0x')) {
    try {
      const receipt = await withTimeout(
        provider.getTransactionReceipt(orderId),
        RECEIPT_LOOKUP_TIMEOUT_MS,
        `tx receipt lookup ${orderId}`,
      );
      if (!receipt) {
        return 'pending';
      }

      return receipt.status === 1 ? 'confirmed' : 'failed';
    } catch (error) {
      console.warn(`[SettlementWorker] receipt lookup failed for ${orderId}:`, error);
      return 'pending';
    }
  }

  try {
    return await withTimeout(
      okxTeeWallet.getTransactionStatus(orderId),
      RECEIPT_LOOKUP_TIMEOUT_MS,
      `wallet order status ${orderId}`,
    );
  } catch (error) {
    console.warn(`[SettlementWorker] wallet status lookup failed for ${orderId}:`, error);
    return 'pending';
  }
}

async function ensureBuyerBalances(payments: X402QueuedPayment[]): Promise<void> {
  const grouped = new Map<string, number>();

  for (const payment of payments) {
    grouped.set(
      payment.fromAgentId,
      Number(((grouped.get(payment.fromAgentId) ?? 0) + payment.amount).toFixed(6)),
    );
  }

  const deficits = new Map<string, number>();
  let totalDeficit = 0;

  for (const [agentId, requiredAmount] of grouped.entries()) {
    const currentBalance = await getOnchainBalance(agentId);
    if (currentBalance === null) {
      continue;
    }

    const deficit = Number((requiredAmount - currentBalance).toFixed(6));
    if (deficit <= 0) {
      continue;
    }

    deficits.set(agentId, deficit);
    totalDeficit = Number((totalDeficit + deficit).toFixed(6));
  }

  if (totalDeficit <= 0) {
    return;
  }

  const treasuryFloat = await getTreasuryUsdtBalance();
  if (treasuryFloat !== null && totalDeficit > treasuryFloat + 1e-9) {
    throw new Error(
      `[x402] Insufficient treasury float for queued settlements: need ${totalDeficit.toFixed(6)} USDT, have ${treasuryFloat.toFixed(6)} USDT`,
    );
  }

  for (const [agentId, deficit] of deficits.entries()) {
    const walletAddress = await getAgentWalletAddress(agentId);
    await creditAgentOnchainBalance(walletAddress, deficit);
  }
}

async function processQueuedSettlements(): Promise<void> {
  const pool = getPool();

  const queued = await pool.query<SettlementRow>(
    `SELECT id, settlement_kind, reference_id, tx_hash, order_id, metadata
     FROM chain_settlements
     WHERE status IN ('queued', 'retrying')
       AND settlement_kind IN ('x402_payment_submit', 'x402_payment_batch_submit')
     ORDER BY created_at ASC
     LIMIT $1`,
    [MAX_QUEUED_SETTLEMENTS_PER_CYCLE],
  );

  if (!queued.rows.length) {
    return;
  }

  const hydratable = await Promise.all(
    queued.rows.map(async (row) => ({
      row,
      payments: await hydratePayments(row),
    })),
  );

  const validGroups = hydratable.filter((entry) => entry.payments.length > 0);
  const invalidRows = hydratable.filter((entry) => entry.payments.length === 0);

  for (const entry of invalidRows) {
    await pool.query(
      `UPDATE chain_settlements
       SET status = 'failed'
       WHERE id = $1`,
      [entry.row.id],
    );
  }

  if (!validGroups.length) {
    return;
  }

  const rows = validGroups.map((entry) => entry.row);
  const payments = validGroups.flatMap((entry) => entry.payments);

  try {
    await ensureBuyerBalances(payments);

    if (payments.length === 1) {
      const payment = payments[0];
      const result = await x402Bridge.processPayment(
        payment.fromAgentId,
        payment.toAgentId,
        payment.serviceType,
        payment.amount,
      );

      await pool.query(
        `UPDATE x402_transactions
         SET tx_hash = $2,
             onchain_payment_id = $3,
             onchain_status = 'submitted',
             onchain_error = NULL,
             onchain_attempts = onchain_attempts + 1
         WHERE id = $1`,
        [payment.txId, result.txHash, result.paymentId],
      );

      await pool.query(
        `UPDATE chain_settlements
         SET tx_hash = $2,
             status = 'submitted'
         WHERE id = $1`,
        [rows[0].id, result.txHash],
      );
      return;
    }

    const result = await x402Bridge.processPaymentBatch(
      payments.map((payment) => ({
        buyerAgentId: payment.fromAgentId,
        sellerAgentId: payment.toAgentId,
        serviceType: payment.serviceType,
        price: payment.amount,
      })),
    );

    for (let index = 0; index < payments.length; index++) {
      const payment = payments[index];
      const paymentId = result.paymentIds[index] ?? null;
      await pool.query(
        `UPDATE x402_transactions
         SET tx_hash = $2,
             onchain_payment_id = $3,
             onchain_status = 'submitted',
             onchain_error = NULL,
             onchain_attempts = onchain_attempts + 1
         WHERE id = $1`,
        [payment.txId, result.txHash, paymentId],
      );
    }

    await pool.query(
      `UPDATE chain_settlements
       SET tx_hash = $2,
           status = 'submitted'
       WHERE id = ANY($1::int[])`,
      [rows.map((row) => row.id), result.txHash],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = payments.every((payment) => payment.onchainAttempts + 1 >= getX402MaxRetries());
    const nextStatus = exhausted ? 'failed' : 'retrying';

    await pool.query(
      `UPDATE x402_transactions
       SET onchain_status = $2,
           onchain_error = $3,
           onchain_attempts = onchain_attempts + 1
       WHERE id = ANY($1::int[])`,
      [payments.map((payment) => payment.txId), nextStatus, message],
    );

    await pool.query(
      `UPDATE chain_settlements
       SET status = $2
       WHERE id = ANY($1::int[])`,
      [rows.map((row) => row.id), nextStatus],
    );
  }
}

async function processSubmittedSettlements(): Promise<void> {
  const pool = getPool();
  const provider = getSharedProvider();

  const submitted = await pool.query<SettlementRow>(
    `SELECT id, settlement_kind, reference_id, tx_hash, order_id, metadata
     FROM chain_settlements
     WHERE status = 'submitted'
     ORDER BY created_at ASC
     LIMIT $1`,
    [MAX_SUBMITTED_SETTLEMENTS_PER_CYCLE],
  );

  for (const row of submitted.rows) {
    const payments = await hydratePayments(row);
    if (!payments.length) {
      continue;
    }

    const status = await resolveSubmittedStatus(provider, row);

    if (status === 'confirmed') {
      await pool.query(
        `UPDATE chain_settlements
         SET status = 'confirmed', confirmed_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      await pool.query(
        `UPDATE x402_transactions
         SET onchain_status = 'confirmed',
             onchain_error = NULL
         WHERE id = ANY($1::int[])`,
        [payments.map((payment) => payment.txId)],
      );
    } else if (status === 'failed') {
      await pool.query(
        `UPDATE chain_settlements
         SET status = 'failed'
         WHERE id = $1`,
        [row.id],
      );
      await pool.query(
        `UPDATE x402_transactions
         SET onchain_status = 'failed',
             onchain_error = COALESCE(onchain_error, 'on-chain confirmation failed')
         WHERE id = ANY($1::int[])`,
        [payments.map((payment) => payment.txId)],
      );
    }
  }
}

async function hydratePayments(row: SettlementRow): Promise<X402QueuedPayment[]> {
  const txIdsFromMetadata = Array.isArray(row.metadata?.payments)
    ? (row.metadata!.payments as Array<Record<string, unknown>>)
        .map((payment) => Number(payment.txId))
        .filter((txId) => Number.isFinite(txId) && txId > 0)
    : [];

  if (txIdsFromMetadata.length) {
    return loadQueuedPayments(txIdsFromMetadata);
  }

  if (row.reference_id) {
    return loadQueuedPayments([row.reference_id]);
  }

  return [];
}

async function cleanupOldSettlements(): Promise<void> {
  try {
    await getPool().query(
      `DELETE FROM chain_settlements
       WHERE status IN ('confirmed', 'failed')
         AND created_at < NOW() - INTERVAL '24 hours'`,
    );
  } catch {
    /* best-effort */
  }
}

async function runWorkerCycle(): Promise<void> {
  if (cycleInFlight) {
    console.warn('[SettlementWorker] previous cycle still running, skipping overlap');
    return;
  }

  cycleInFlight = true;
  try {
    await processQueuedSettlements();
    await processSubmittedSettlements();
  } catch (err) {
    console.warn('[SettlementWorker] cycle failed:', err);
  } finally {
    cycleInFlight = false;
  }
}

export function startSettlementWorker(): void {
  if (intervalHandle) return;
  if (isX402DirectWalletMode()) {
    console.log('[SettlementWorker] Direct-wallet x402 mode active — async worker disabled');
    return;
  }

  console.log(`[SettlementWorker] Started (${WORKER_INTERVAL_MS / 1000}s interval)`);

  intervalHandle = setInterval(() => {
    void runWorkerCycle();
  }, WORKER_INTERVAL_MS);

  void runWorkerCycle();
  cleanupHandle = setInterval(() => void cleanupOldSettlements(), 600_000);
}

export function stopSettlementWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (cleanupHandle) {
    clearInterval(cleanupHandle);
    cleanupHandle = null;
  }
}

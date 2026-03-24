import { ethers } from 'ethers';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { x402Bridge } from '../onchainos/x402bridge.js';
import {
  getAgentWalletAddress,
  getAgentWalletExecutionContext,
  getOnchainBalance,
  getTreasuryUsdtBalance,
  getTreasuryAddress,
  setAgentOnchainBalanceSnapshot,
} from '../agents/wallet-sync.js';
import { TxType, X402_PRICES } from './pricing.js';
import {
  getUsdtAddress,
  getXLayerCaip,
  getXLayerChainId,
  getXLayerNetwork,
  isStrictOnchainMode,
  isX402DirectWalletMode,
} from '../config/xlayer.js';
import { okxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import { okxPaymentsClient } from '../onchainos/okx-payments.js';

export interface PaymentResult {
  success: boolean;
  txId: number;
  txHash?: string;
  amount: number;
  fromBalance?: number;
  toBalance?: number;
}

export interface PaymentRequest {
  txType: TxType;
  fromAgentId: string | null;
  toAgentId: string | null;
  amount?: number;
  metadata?: JsonRecord;
}

export interface X402QueuedPayment {
  txId: number;
  txType: TxType;
  fromAgentId: string;
  toAgentId: string;
  amount: number;
  serviceType: number;
  metadata: JsonRecord;
  onchainAttempts: number;
}

type JsonRecord = Record<string, unknown>;

const X402_MAX_RETRIES = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

interface PreparedPayment extends PaymentRequest {
  amount: number;
  metadata: JsonRecord;
  requiresOnchain: boolean;
  onchainSellerId: string | null;
  serviceType: number;
}

interface ExecutedPayment extends PreparedPayment {
  txHash: string | null;
  paymentId: number | null;
  onchainStatus: string;
  settlementKind: string | null;
  confirmedAt: string | null;
  onchainAttempts: number;
  proofProvider: string | null;
  proofHeaderName: string | null;
  proofPayload: unknown;
  proofRequirements: unknown;
  proofAuthorization: unknown;
  proofSignature: string | null;
  proofVerifyEndpoint: string | null;
  proofVerifyResponse: unknown;
  proofVerifiedAt: string | null;
  proofSettleEndpoint: string | null;
  proofSettleResponse: unknown;
  proofSettledAt: string | null;
  proofPayerAddress: string | null;
  proofPayeeAddress: string | null;
}

interface OkxVerifyResult {
  isValid: boolean;
  payer?: string | null;
  invalidReason?: string | null;
}

interface OkxSettleResult {
  success: boolean;
  payer?: string | null;
  txHash?: string | null;
  errorReason?: string | null;
  chainIndex?: string | null;
  chainName?: string | null;
}

function checkRateLimit(agentId: string | null): void {
  if (!agentId) return;
  const now = Date.now();
  let bucket = rateBuckets.get(agentId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(agentId, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    throw new Error(`Rate limit exceeded for agent ${agentId} (${RATE_LIMIT_MAX}/min)`);
  }
}

export async function processX402Payment(
  txType: TxType,
  fromAgentId: string | null,
  toAgentId: string | null,
  amount?: number,
  metadata?: JsonRecord,
): Promise<PaymentResult> {
  const [result] = await processX402PaymentBatch([
    { txType, fromAgentId, toAgentId, amount, metadata },
  ]);
  return result;
}

export async function processX402PaymentBatch(
  payments: PaymentRequest[],
): Promise<PaymentResult[]> {
  if (!payments.length) {
    return [];
  }

  const prepared = payments.map((payment) => preparePayment(payment));
  await validatePreparedPayments(prepared);

  if (isX402DirectWalletMode()) {
    return processDirectPaymentBatch(prepared);
  }

  return processAsyncPaymentBatch(prepared);
}

async function processAsyncPaymentBatch(
  prepared: PreparedPayment[],
): Promise<PaymentResult[]> {
  const results = await withTransaction<PaymentResult[]>(async (client) => {
    const output: PaymentResult[] = [];
    const queueable: X402QueuedPayment[] = [];

    for (const payment of prepared) {
      const balances = await applyLocalBalanceDelta(client, payment);

      const onchainStatus = payment.requiresOnchain ? 'queued' : 'local_confirmed';
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO x402_transactions
          (tx_type, from_agent_id, to_agent_id, amount, metadata, onchain_status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          payment.txType,
          payment.fromAgentId,
          payment.toAgentId,
          payment.amount.toFixed(6),
          payment.metadata ? JSON.stringify(payment.metadata) : null,
          onchainStatus,
        ],
      );

      const txId = inserted.rows[0].id;

      if (payment.requiresOnchain && payment.fromAgentId) {
        queueable.push({
          txId,
          txType: payment.txType,
          fromAgentId: payment.fromAgentId,
          toAgentId: payment.onchainSellerId ?? 'treasury',
          amount: payment.amount,
          serviceType: payment.serviceType,
          metadata: payment.metadata ?? {},
          onchainAttempts: 0,
        });
      }

      output.push({
        success: true,
        txId,
        amount: payment.amount,
        ...balances,
      });
    }

    if (queueable.length === 1) {
      await client.query(
        `INSERT INTO chain_settlements
          (settlement_kind, reference_table, reference_id, from_agent_id, to_agent_id, amount, tx_type, metadata, status)
         VALUES ('x402_payment_submit', 'x402_transactions', $1, $2, $3, $4, $5, $6, 'queued')`,
        [
          queueable[0].txId,
          queueable[0].fromAgentId,
          queueable[0].toAgentId,
          queueable[0].amount.toFixed(6),
          queueable[0].txType,
          JSON.stringify({ payments: [queueable[0]] }),
        ],
      );
    } else if (queueable.length > 1) {
      await client.query(
        `INSERT INTO chain_settlements
          (settlement_kind, reference_table, reference_id, amount, tx_type, metadata, status)
         VALUES ('x402_payment_batch_submit', 'x402_transactions', $1, $2, 'batch', $3, 'queued')`,
        [
          queueable[0].txId,
          queueable.reduce((sum, payment) => sum + payment.amount, 0).toFixed(6),
          JSON.stringify({ payments: queueable }),
        ],
      );
    }

    return output;
  });

  emitPaymentEvents(
    prepared.map((payment, index) => ({
      ...payment,
      txHash: null,
      paymentId: null,
      onchainStatus: payment.requiresOnchain ? 'queued' : 'local_confirmed',
      settlementKind: payment.requiresOnchain ? 'x402_payment_submit' : null,
      confirmedAt: null,
      onchainAttempts: payment.requiresOnchain ? 0 : 1,
      proofProvider: null,
      proofHeaderName: null,
      proofPayload: null,
      proofRequirements: null,
      proofAuthorization: null,
      proofSignature: null,
      proofVerifyEndpoint: null,
      proofVerifyResponse: null,
      proofVerifiedAt: null,
      proofSettleEndpoint: null,
      proofSettleResponse: null,
      proofSettledAt: null,
      proofPayerAddress: null,
      proofPayeeAddress: null,
    })),
    results,
  );

  return results;
}

async function processDirectPaymentBatch(
  prepared: PreparedPayment[],
): Promise<PaymentResult[]> {
  const executed: ExecutedPayment[] = [];

  try {
    for (const payment of prepared) {
      executed.push(await executeDirectPayment(payment));
    }
  } catch (error) {
    if (executed.length > 0) {
      await compensateFailedDirectBatch(executed, error);
    }
    throw error;
  }

  const results = await persistExecutedPayments(executed);
  emitPaymentEvents(executed, results);
  return results;
}

async function executeDirectPayment(payment: PreparedPayment): Promise<ExecutedPayment> {
  if (!payment.requiresOnchain) {
    return {
      ...payment,
      txHash: null,
      paymentId: null,
      onchainStatus: 'local_confirmed',
      settlementKind: null,
      confirmedAt: null,
      onchainAttempts: 0,
      proofProvider: null,
      proofHeaderName: null,
      proofPayload: null,
      proofRequirements: null,
      proofAuthorization: null,
      proofSignature: null,
      proofVerifyEndpoint: null,
      proofVerifyResponse: null,
      proofVerifiedAt: null,
      proofSettleEndpoint: null,
      proofSettleResponse: null,
      proofSettledAt: null,
      proofPayerAddress: null,
      proofPayeeAddress: null,
    };
  }

  if (shouldUseProofFirst(payment)) {
    return processProofFirstPayment(payment);
  }

  const direct = await x402Bridge.processDirectPayment(
    payment.fromAgentId,
    payment.onchainSellerId,
    payment.serviceType,
    payment.amount,
  );

  return {
    ...payment,
    txHash: direct.txHash,
    paymentId: direct.paymentId,
    onchainStatus: 'confirmed',
    settlementKind: 'x402_payment_direct',
    confirmedAt: direct.confirmedAt,
    onchainAttempts: 1,
    proofProvider: null,
    proofHeaderName: null,
    proofPayload: null,
    proofRequirements: null,
    proofAuthorization: null,
    proofSignature: null,
    proofVerifyEndpoint: null,
    proofVerifyResponse: null,
    proofVerifiedAt: null,
    proofSettleEndpoint: null,
    proofSettleResponse: null,
    proofSettledAt: null,
    proofPayerAddress: direct.buyerAddress,
    proofPayeeAddress: direct.sellerAddress,
  };
}

async function processProofFirstPayment(payment: PreparedPayment): Promise<ExecutedPayment> {
  if (!payment.fromAgentId) {
    throw new Error('[x402] proof-first requires a payer agent');
  }

  const context = await getAgentWalletExecutionContext(payment.fromAgentId);
  if (!context.teeKeyRef) {
    throw new Error(`[x402] ${payment.fromAgentId} has no wallet signing reference`);
  }

  const payeeAddress = payment.onchainSellerId
    ? await getAgentWalletAddress(payment.onchainSellerId)
    : getTreasuryAddress();
  const minimalAmount = ethers.parseUnits(payment.amount.toFixed(6), 6).toString();

  const proof = await okxTeeWallet.signX402Payment(context.teeKeyRef, {
    x402Version: 2,
    network: getXLayerCaip(),
    chainIndex: getXLayerChainId(),
    amount: minimalAmount,
    payTo: payeeAddress,
    asset: getUsdtAddress(),
    from: context.walletAddress,
    maxTimeoutSeconds: 300,
    resource: buildPaymentResource(payment),
    description: buildPaymentDescription(payment),
    mimeType: 'application/json',
    extra: {
      txType: payment.txType,
      serviceType: payment.serviceType,
      fromAgentId: payment.fromAgentId,
      toAgentId: payment.toAgentId,
      metadata: payment.metadata,
    },
  });

  const proofRequestBody = {
    x402Version: proof.x402Version,
    chainIndex: proof.chainIndex,
    paymentPayload: proof.paymentPayload,
    paymentRequirements: proof.paymentRequirements,
  };

  const verifiedAt = new Date().toISOString();
  const verify = await okxPaymentsClient.verify(proofRequestBody);
  const verifyResult = normalizeOkxVerifyResult(verify.payload);
  if (!verifyResult.isValid) {
    throw new Error(
      `[x402] official verify rejected payment: ${verifyResult.invalidReason ?? 'invalid_payment'}`,
    );
  }

  const settledAt = new Date().toISOString();
  const settle = await okxPaymentsClient.settle(proofRequestBody);
  const settleResult = normalizeOkxSettleResult(settle.payload);
  if (!settleResult.success || !settleResult.txHash) {
    throw new Error(
      `[x402] official settle failed: ${settleResult.errorReason ?? 'missing_tx_hash'}`,
    );
  }

  return {
    ...payment,
    txHash: settleResult.txHash,
    paymentId: null,
    onchainStatus: 'settled',
    settlementKind: 'x402_payment_proof_settle',
    confirmedAt: settledAt,
    onchainAttempts: 1,
    proofProvider: proof.provider,
    proofHeaderName: proof.headerName,
    proofPayload: proof.paymentPayload as unknown,
    proofRequirements: proof.paymentRequirements as unknown,
    proofAuthorization: proof.authorization as unknown,
    proofSignature: proof.signature,
    proofVerifyEndpoint: verify.endpoint,
    proofVerifyResponse: verify.payload,
    proofVerifiedAt: verifiedAt,
    proofSettleEndpoint: settle.endpoint,
    proofSettleResponse: settle.payload,
    proofSettledAt: settledAt,
    proofPayerAddress: proof.payerAddress,
    proofPayeeAddress: proof.payeeAddress,
  };
}

async function compensateFailedDirectBatch(
  executed: ExecutedPayment[],
  rootError: unknown,
): Promise<void> {
  const refunds: ExecutedPayment[] = [];

  for (const payment of [...executed].reverse()) {
    if (payment.txType !== 'arena_entry' || payment.toAgentId !== null || !payment.fromAgentId) {
      throw new Error(
        `[x402] direct batch failed after partial execution and cannot auto-compensate ${payment.txType}`,
      );
    }

    const refund = await x402Bridge.processDirectPayment(
      null,
      payment.fromAgentId,
      payment.serviceType,
      payment.amount,
    );

    refunds.push({
      txType: 'arena_entry_refund',
      fromAgentId: null,
      toAgentId: payment.fromAgentId,
      amount: payment.amount,
      metadata: {
        originalTxHash: payment.txHash,
        originalPaymentId: payment.paymentId,
        originalTxType: payment.txType,
        compensationReason:
          rootError instanceof Error ? rootError.message : String(rootError),
      },
      requiresOnchain: true,
      onchainSellerId: payment.fromAgentId,
      serviceType: payment.serviceType,
      txHash: refund.txHash,
      paymentId: refund.paymentId,
      onchainStatus: 'confirmed',
      settlementKind: 'x402_payment_direct_refund',
      confirmedAt: refund.confirmedAt,
      onchainAttempts: 1,
      proofProvider: null,
      proofHeaderName: null,
      proofPayload: null,
      proofRequirements: null,
      proofAuthorization: null,
      proofSignature: null,
      proofVerifyEndpoint: null,
      proofVerifyResponse: null,
      proofVerifiedAt: null,
      proofSettleEndpoint: null,
      proofSettleResponse: null,
      proofSettledAt: null,
      proofPayerAddress: refund.buyerAddress,
      proofPayeeAddress: refund.sellerAddress,
    });
  }

  await persistExecutedPayments([...executed, ...refunds]);
}

async function persistExecutedPayments(
  executed: ExecutedPayment[],
): Promise<PaymentResult[]> {
  return withTransaction(async (client) => {
    const output: PaymentResult[] = [];

    for (const payment of executed) {
      const balances = await applyLocalBalanceDelta(client, payment);

      const inserted = await client.query<{ id: number }>(
        `INSERT INTO x402_transactions
          (
            tx_type,
            from_agent_id,
            to_agent_id,
            amount,
            tx_hash,
            onchain_payment_id,
            onchain_status,
            onchain_error,
            onchain_attempts,
            metadata,
            proof_provider,
            proof_header_name,
            proof_payload,
            proof_requirements,
            proof_authorization,
            proof_signature,
            proof_verify_endpoint,
            proof_verify_response,
            proof_verified_at,
            proof_settle_endpoint,
            proof_settle_response,
            proof_settled_at,
            proof_payer_address,
            proof_payee_address
          )
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING id`,
        [
          payment.txType,
          payment.fromAgentId,
          payment.toAgentId,
          payment.amount.toFixed(6),
          payment.txHash,
          payment.paymentId,
          payment.onchainStatus,
          payment.onchainAttempts,
          payment.metadata ? JSON.stringify(payment.metadata) : null,
          payment.proofProvider,
          payment.proofHeaderName,
          payment.proofPayload ? JSON.stringify(payment.proofPayload) : null,
          payment.proofRequirements ? JSON.stringify(payment.proofRequirements) : null,
          payment.proofAuthorization ? JSON.stringify(payment.proofAuthorization) : null,
          payment.proofSignature,
          payment.proofVerifyEndpoint,
          payment.proofVerifyResponse ? JSON.stringify(payment.proofVerifyResponse) : null,
          payment.proofVerifiedAt,
          payment.proofSettleEndpoint,
          payment.proofSettleResponse ? JSON.stringify(payment.proofSettleResponse) : null,
          payment.proofSettledAt,
          payment.proofPayerAddress,
          payment.proofPayeeAddress,
        ],
      );

      const txId = inserted.rows[0].id;

      if (payment.txHash) {
        await client.query(
          `INSERT INTO chain_settlements
            (settlement_kind, reference_table, reference_id, tx_hash, order_id, from_agent_id, to_agent_id, amount, tx_type, metadata, status, confirmed_at)
           VALUES ($1, 'x402_transactions', $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
          [
            payment.settlementKind ?? 'x402_payment_direct',
            txId,
            payment.txHash,
            payment.txHash,
            payment.proofPayerAddress ?? payment.fromAgentId,
            payment.proofPayeeAddress ?? payment.toAgentId ?? 'treasury',
            payment.amount.toFixed(6),
            payment.txType,
            JSON.stringify({
              ...payment.metadata,
              paymentId: payment.paymentId,
              confirmedAt: payment.confirmedAt,
              proofProvider: payment.proofProvider,
              proofVerifyEndpoint: payment.proofVerifyEndpoint,
              proofSettleEndpoint: payment.proofSettleEndpoint,
            }),
            payment.onchainStatus === 'settled' ? 'settled' : 'confirmed',
          ],
        );
      }

      output.push({
        success: true,
        txId,
        txHash: payment.txHash ?? undefined,
        amount: payment.amount,
        ...balances,
      });
    }

    return output;
  });
}

async function validatePreparedPayments(prepared: PreparedPayment[]): Promise<void> {
  const pool = getPool();
  const payerIds = Array.from(
    new Set(prepared.map((payment) => payment.fromAgentId).filter((agentId): agentId is string => Boolean(agentId))),
  );
  const recipientIds = Array.from(
    new Set(prepared.map((payment) => payment.toAgentId).filter((agentId): agentId is string => Boolean(agentId))),
  );

  const payerRows = payerIds.length
    ? await pool.query<{ agent_id: string; balance: string; is_alive: boolean; onchain_balance: string | null }>(
        `SELECT agent_id, balance, is_alive, onchain_balance
         FROM agents
         WHERE agent_id = ANY($1::text[])`,
        [payerIds],
      )
    : { rows: [] };
  const payers = new Map(
    payerRows.rows.map((row) => [
      row.agent_id,
      {
        balance: Number(row.balance),
        isAlive: row.is_alive,
        onchainBalance: Number(row.onchain_balance ?? 0),
      },
    ]),
  );

  const localRequiredByAgent = new Map<string, number>();
  const onchainRequiredByAgent = new Map<string, number>();

  for (const payment of prepared) {
    if (payment.fromAgentId) {
      const current = localRequiredByAgent.get(payment.fromAgentId) ?? 0;
      localRequiredByAgent.set(
        payment.fromAgentId,
        Number((current + payment.amount).toFixed(6)),
      );

      if (payment.requiresOnchain) {
        const onchainCurrent = onchainRequiredByAgent.get(payment.fromAgentId) ?? 0;
        onchainRequiredByAgent.set(
          payment.fromAgentId,
          Number((onchainCurrent + payment.amount).toFixed(6)),
        );
      }
    }
  }

  for (const [agentId, requestedAmount] of localRequiredByAgent.entries()) {
    const payer = payers.get(agentId);
    if (!payer) {
      throw new Error(`Agent ${agentId} not found`);
    }
    if (!payer.isAlive) {
      throw new Error(`Agent ${agentId} is dead`);
    }
    if (payer.balance < requestedAmount) {
      throw new Error(
        `Insufficient balance for ${agentId}: ${payer.balance.toFixed(6)} < ${requestedAmount.toFixed(6)}`,
      );
    }
  }

  if (recipientIds.length) {
    const recipientRows = await pool.query<{ agent_id: string }>(
      `SELECT agent_id
       FROM agents
       WHERE agent_id = ANY($1::text[])`,
      [recipientIds],
    );
    const knownRecipients = new Set(recipientRows.rows.map((row) => row.agent_id));
    for (const recipientId of recipientIds) {
      if (!knownRecipients.has(recipientId)) {
        throw new Error(`Recipient ${recipientId} not found`);
      }
    }
  }

  if (!onchainRequiredByAgent.size || isX402DirectWalletMode()) {
    return;
  }

  const queuedRows = await pool.query<{ from_agent_id: string; queued_amount: string }>(
    `SELECT from_agent_id, COALESCE(SUM(amount), 0) AS queued_amount
     FROM x402_transactions
     WHERE from_agent_id = ANY($1::text[])
       AND onchain_status IN ('queued', 'retrying')
     GROUP BY from_agent_id`,
    [Array.from(onchainRequiredByAgent.keys())],
  );
  const queuedAmounts = new Map(
    queuedRows.rows.map((row) => [row.from_agent_id, Number(row.queued_amount)]),
  );

  let treasuryFloat = await getTreasuryUsdtBalance();
  if (treasuryFloat === null && isStrictOnchainMode()) {
    throw new Error('[x402] Unable to validate treasury USDT float in strict mode');
  }

  for (const [agentId, newAmount] of onchainRequiredByAgent.entries()) {
    const payer = payers.get(agentId);
    const snapshot = payer?.onchainBalance ?? 0;
    const liveBalance = await getOnchainBalance(agentId);
    const spendableBalance = liveBalance ?? snapshot;

    if (liveBalance !== null) {
      await setAgentOnchainBalanceSnapshot(agentId, liveBalance);
    }

    const queuedAmount = queuedAmounts.get(agentId) ?? 0;
    const existingDeficit = Math.max(0, Number((queuedAmount - spendableBalance).toFixed(6)));
    const combinedDeficit = Math.max(
      0,
      Number((queuedAmount + newAmount - spendableBalance).toFixed(6)),
    );
    const incrementalDeficit = Number((combinedDeficit - existingDeficit).toFixed(6));

    if ((liveBalance ?? null) === null && isStrictOnchainMode()) {
      throw new Error(`[x402] Unable to refresh on-chain balance for ${agentId} in strict mode`);
    }

    if (treasuryFloat !== null && incrementalDeficit > treasuryFloat + 1e-9) {
      throw new Error(
        `[x402] Insufficient treasury float for ${agentId}: need ${incrementalDeficit.toFixed(6)} USDT, have ${treasuryFloat.toFixed(6)} USDT`,
      );
    }

    if (treasuryFloat !== null) {
      treasuryFloat = Number((treasuryFloat - incrementalDeficit).toFixed(6));
    }
  }
}

async function applyLocalBalanceDelta(
  client: PoolClient,
  payment: PreparedPayment,
): Promise<{ fromBalance?: number; toBalance?: number }> {
  let fromBalance: number | undefined;
  let toBalance: number | undefined;

  if (payment.fromAgentId) {
    const updated = await client.query<{ balance: string }>(
      'UPDATE agents SET balance = balance - $1 WHERE agent_id = $2 RETURNING balance',
      [payment.amount, payment.fromAgentId],
    );
    fromBalance = Number(updated.rows[0]?.balance ?? 0);
  }

  if (payment.toAgentId) {
    const recipient = await client.query<{ balance: string }>(
      'UPDATE agents SET balance = balance + $1 WHERE agent_id = $2 RETURNING balance',
      [payment.amount, payment.toAgentId],
    );
    toBalance = Number(recipient.rows[0]?.balance ?? 0);
  }

  return { fromBalance, toBalance };
}

function emitPaymentEvents(executed: ExecutedPayment[], results: PaymentResult[]): void {
  executed.forEach((payment, index) => {
    eventBus.emit('x402_payment', {
      txType: payment.txType,
      from: payment.fromAgentId ?? 'treasury',
      to: payment.toAgentId ?? getTreasuryAddress(),
      amount: payment.amount,
      txHash: payment.txHash,
      metadata: payment.metadata ?? {},
      onchainStatus: payment.onchainStatus,
      txId: results[index]?.txId ?? null,
      paymentId: payment.paymentId,
      proofProvider: payment.proofProvider,
    });
  });
}

export async function getX402Stats(): Promise<
  Array<{
    txType: string;
    transactionCount: number;
    totalVolume: number;
  }>
> {
  const pool = getPool();
  const result = await pool.query<{
    tx_type: string;
    transaction_count: string;
    total_volume: string;
  }>(
    `SELECT
       tx_type,
       COUNT(*) AS transaction_count,
       COALESCE(SUM(amount), 0) AS total_volume
     FROM x402_transactions
     GROUP BY tx_type
     ORDER BY total_volume DESC`,
  );

  return result.rows.map((row) => ({
    txType: row.tx_type,
    transactionCount: Number(row.transaction_count),
    totalVolume: Number(row.total_volume),
  }));
}

export function getX402MaxRetries(): number {
  return X402_MAX_RETRIES;
}

export async function loadQueuedPayments(txIds: number[]): Promise<X402QueuedPayment[]> {
  if (!txIds.length) return [];

  const pool = getPool();
  const result = await pool.query<{
    id: number;
    tx_type: TxType;
    from_agent_id: string | null;
    to_agent_id: string | null;
    amount: string;
    metadata: JsonRecord | null;
    onchain_attempts: number;
  }>(
    `SELECT id, tx_type, from_agent_id, to_agent_id, amount, metadata, onchain_attempts
     FROM x402_transactions
     WHERE id = ANY($1::int[])
     ORDER BY id ASC`,
    [txIds],
  );

  return result.rows
    .filter((row) => !!row.from_agent_id)
    .map((row) => ({
      txId: row.id,
      txType: row.tx_type,
      fromAgentId: row.from_agent_id!,
      toAgentId: row.to_agent_id ?? 'treasury',
      amount: Number(row.amount),
      serviceType: mapServiceType(row.tx_type),
      metadata: row.metadata ?? {},
      onchainAttempts: row.onchain_attempts,
    }));
}

function preparePayment(payment: PaymentRequest): PreparedPayment {
  const amount = Number((payment.amount ?? getDefaultPrice(payment.txType)).toFixed(6));
  if (amount <= 0) {
    throw new Error('Payment amount must be greater than zero');
  }

  checkRateLimit(payment.fromAgentId);

  return {
    ...payment,
    amount,
    metadata: payment.metadata ?? {},
    requiresOnchain: resolveRequiresOnchain(payment.fromAgentId),
    onchainSellerId: payment.toAgentId ?? null,
    serviceType: mapServiceType(payment.txType),
  };
}

function resolveRequiresOnchain(fromAgentId: string | null): boolean {
  if (isX402DirectWalletMode()) {
    if (fromAgentId && canUseOfficialProofFirst()) {
      return true;
    }

    if (getXLayerNetwork() === 'mainnet' && fromAgentId && isStrictOnchainMode()) {
      throw new Error('[x402] official proof-first path is not configured for mainnet direct wallet mode');
    }

    if (!x402Bridge.isConfigured()) {
      if (isStrictOnchainMode()) {
        throw new Error('[x402] On-chain bridge is not configured in strict mode');
      }
      return false;
    }

    return true;
  }

  if (!x402Bridge.isConfigured()) {
    if (isStrictOnchainMode()) {
      throw new Error('[x402] On-chain bridge is not configured in strict mode');
    }

    return false;
  }

  return Boolean(fromAgentId);
}

function canUseOfficialProofFirst(): boolean {
  return (
    getXLayerNetwork() === 'mainnet' &&
    okxPaymentsClient.isConfigured() &&
    okxTeeWallet.isConfigured() &&
    Boolean(getUsdtAddress())
  );
}

function shouldUseProofFirst(payment: PreparedPayment): boolean {
  return Boolean(
    payment.requiresOnchain &&
    payment.fromAgentId &&
    isX402DirectWalletMode() &&
    canUseOfficialProofFirst(),
  );
}

function buildPaymentDescription(payment: PreparedPayment): string {
  switch (payment.txType) {
    case 'tip':
      return `Civilis social tip from ${payment.fromAgentId} to ${payment.toAgentId ?? 'treasury'}`;
    case 'paywall':
      return `Civilis paywall unlock for post ${String(payment.metadata.postId ?? 'unknown')}`;
    case 'arena_entry':
      return `Civilis arena entry for match ${String(payment.metadata.matchId ?? 'pending')}`;
    case 'intel_purchase':
    case 'intel_v2_purchase':
      return `Civilis intel purchase ${String(payment.metadata.itemId ?? payment.metadata.listingId ?? 'unknown')}`;
    case 'intel_spy':
      return `Civilis spy action against ${String(payment.metadata.targetAgentId ?? payment.metadata.subjectAgentId ?? 'unknown')}`;
    case 'intel_self_discover':
      return `Civilis self discovery for ${payment.fromAgentId}`;
    case 'divination':
      return `Civilis divination service for ${payment.fromAgentId}`;
    default:
      return `Civilis ${payment.txType} payment`;
  }
}

function buildPaymentResource(payment: PreparedPayment): string {
  const keyParts = [
    payment.txType,
    payment.fromAgentId ?? 'treasury',
    payment.toAgentId ?? 'treasury',
  ];
  const resourceId = String(
    payment.metadata.matchId ??
      payment.metadata.postId ??
      payment.metadata.itemId ??
      payment.metadata.listingId ??
      payment.metadata.roundId ??
      'resource',
  );
  return `civilis://${keyParts.join('/')}/${resourceId}`;
}

function normalizeOkxPayloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const envelope = payload as Record<string, unknown>;
  const data = envelope.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
    return data[0] as Record<string, unknown>;
  }
  if (data && typeof data === 'object') {
    return data as Record<string, unknown>;
  }
  return envelope;
}

function normalizeOkxVerifyResult(payload: unknown): OkxVerifyResult {
  const record = normalizeOkxPayloadRecord(payload);
  return {
    isValid: Boolean(record.isValid),
    payer: typeof record.payer === 'string' ? record.payer : null,
    invalidReason: typeof record.invalidReason === 'string' ? record.invalidReason : null,
  };
}

function normalizeOkxSettleResult(payload: unknown): OkxSettleResult {
  const record = normalizeOkxPayloadRecord(payload);
  return {
    success: Boolean(record.success),
    payer: typeof record.payer === 'string' ? record.payer : null,
    txHash: typeof record.txHash === 'string' ? record.txHash : null,
    errorReason: typeof record.errorReason === 'string'
      ? record.errorReason
      : typeof record.errorMsg === 'string'
        ? record.errorMsg
        : null,
    chainIndex: typeof record.chainIndex === 'string' ? record.chainIndex : null,
    chainName: typeof record.chainName === 'string' ? record.chainName : null,
  };
}

function getDefaultPrice(txType: TxType): number {
  const defaults: Record<TxType, number> = {
    post: X402_PRICES.post,
    reply: X402_PRICES.reply,
    tip: X402_PRICES.tip,
    paywall: X402_PRICES.tip,
    arena_entry: X402_PRICES.arena_entry,
    arena_entry_refund: X402_PRICES.arena_entry,
    arena_action: X402_PRICES.arena_action,
    negotiation: X402_PRICES.negotiation,
    divination: X402_PRICES.divination_mbti,
    register: X402_PRICES.register,
    death_treasury: 0.001,
    trade: 0.001,
    intel_self_reveal: X402_PRICES.intel_self_reveal_mbti,
    intel_spy: X402_PRICES.intel_spy_mbti,
    intel_purchase: 0.01,
    economy_tax: 0.001,
    economy_ubi: 0.001,
    economy_bailout: 0.001,
    death_inheritance: 0.001,
    death_social: 0.001,
    intel_v2_purchase: 0.05,
    intel_self_discover: 0.003,
  };

  return defaults[txType];
}

function mapServiceType(txType: TxType): number {
  switch (txType) {
    case 'post':
    case 'reply':
    case 'tip':
    case 'paywall':
      return 0;
    case 'arena_entry':
    case 'arena_entry_refund':
    case 'arena_action':
    case 'negotiation':
      return 1;
    default:
      return 2;
  }
}

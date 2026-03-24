/**
 * ERC-8004 Reputation Registry — Agent Reputation On-Chain
 *
 * Maps Civilis game outcomes to on-chain feedback signals:
 * - PD cooperation → tag1: pd_cooperation
 * - Commons contribution → tag1: commons_cooperation
 * - Prediction accuracy → tag1: prediction_accuracy
 * - Intel credibility → tag1: intel_accuracy / intel_fraud
 * - Trust changes → tag1: trust_change
 *
 * Feedback is batched and submitted every 5 ticks to minimize gas.
 *
 * Ref: https://eips.ethereum.org/EIPS/eip-8004
 */

import { ethers, Contract } from 'ethers';
import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { formatOnchainError, isStrictOnchainMode } from '../config/xlayer.js';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSigner,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';
import { okxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import {
  getAgentWalletAddressStrict,
  getAgentWalletExecutionContextByAddress,
} from '../agents/wallet-sync.js';
import { identityRegistry } from './identity-registry.js';

/* ── Minimal ABI ── */
const REPUTATION_REGISTRY_ABI = [
  {
    name: 'initialize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'identityRegistry_', type: 'address' }],
    outputs: [],
  },
  {
    name: 'getIdentityRegistry',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'giveFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'revokeFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    name: 'appendResponse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
      { name: 'response', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    name: 'readAllFeedback',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      {
        name: 'feedbacks',
        type: 'tuple[]',
        components: [
          { name: 'value', type: 'int128' },
          { name: 'valueDecimals', type: 'uint8' },
          { name: 'tag1', type: 'string' },
          { name: 'tag2', type: 'string' },
          { name: 'isRevoked', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'getClients',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    name: 'getLastIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    name: 'getResponseCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    name: 'readFeedback',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  // Events
  {
    name: 'NewFeedback',
    type: 'event',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true },
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    name: 'FeedbackRevoked',
    type: 'event',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
    ],
  },
  {
    name: 'ResponseAppended',
    type: 'event',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'responseIndex', type: 'uint64', indexed: false },
      { name: 'response', type: 'string', indexed: false },
    ],
  },
];

function resolveReputationRegistryAddress(): { address: string | null; source: 'v2_env' | 'legacy_env_alias' | 'unset' } {
  if (process.env.ERC8004_REPUTATION_V2_ADDRESS) {
    return { address: process.env.ERC8004_REPUTATION_V2_ADDRESS, source: 'v2_env' };
  }
  if (process.env.ERC8004_REPUTATION_ADDRESS) {
    return { address: process.env.ERC8004_REPUTATION_ADDRESS, source: 'legacy_env_alias' };
  }
  return { address: null, source: 'unset' };
}

/* ── Feedback Queue Item ── */
export interface FeedbackItem {
  agentId: string;           // Civilis agent_id
  erc8004TokenId: number;    // on-chain token id
  value: number;             // -100 to 100
  valueDecimals: number;     // 0-18
  tag1: string;              // category
  tag2: string;              // subcategory
  endpoint?: string;
  metadata?: Record<string, unknown>;
  localFeedbackId?: number;
  clientAddress?: string;
}

interface PendingFeedbackRow {
  id: number;
  agent_id: string | null;
  agent_erc8004_id: number;
  client_address: string;
  value: number;
  value_decimals: number;
  tag1: string | null;
  tag2: string | null;
}

interface FeedbackSubmitterRoute {
  mode: 'shared' | 'agent_wallet';
  clientAddress: string;
  teeKeyRef?: string;
  agentId?: string;
}

/* ── Feedback Tags ── */
export const FEEDBACK_TAGS = {
  PD_COOPERATION: { tag1: 'pd_cooperation', tag2: 'arena' },
  PD_BETRAYAL: { tag1: 'pd_betrayal', tag2: 'arena' },
  COMMONS_COOPERATION: { tag1: 'commons_cooperation', tag2: 'commons' },
  COMMONS_SABOTAGE: { tag1: 'commons_sabotage', tag2: 'commons' },
  PREDICTION_CORRECT: { tag1: 'prediction_accuracy', tag2: 'prediction' },
  PREDICTION_WRONG: { tag1: 'prediction_miss', tag2: 'prediction' },
  INTEL_ACCURATE: { tag1: 'intel_accuracy', tag2: 'intel' },
  INTEL_FRAUD: { tag1: 'intel_fraud', tag2: 'intel' },
  TRUST_CHANGE: { tag1: 'trust_change', tag2: 'social' },
  AGENT_DEATH: { tag1: 'agent_death', tag2: 'lifecycle' },
} as const;

/* ── Reputation Registry Client ── */

class ReputationRegistryClient {
  private contract: Contract | null = null;
  private signer: ethers.NonceManager | null = null;
  private signerAddress: string | null = null;
  private initialized = false;

  /** In-memory queue for batching feedback submissions */
  private queue: FeedbackItem[] = [];
  private readonly MAX_BATCH_SIZE = 20;
  private readonly MAX_BATCHES_PER_FLUSH = 3;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    try {
      const resolved = resolveReputationRegistryAddress();
      const strict = isStrictOnchainMode();

      if (!resolved.address) {
        if (strict) {
          throw new Error('[ERC8004-REP] Missing ERC8004_REPUTATION_V2_ADDRESS (or ERC8004_REPUTATION_ADDRESS alias)');
        }
        console.warn('[ERC8004-REP] Missing config — mock mode');
        return;
      }

      const provider = getSharedProvider();
      this.signer = getSharedSigner('erc8004_reputation');
      this.signerAddress = getSharedSignerAddress('erc8004_reputation');
      if (!this.signer || !this.signerAddress) {
        if (strict) {
          throw new Error('[ERC8004-REP] Reputation signer is unavailable');
        }
        console.warn('[ERC8004-REP] Shared deployer signer missing — mock mode');
        return;
      }
      this.contract = new ethers.Contract(resolved.address, REPUTATION_REGISTRY_ABI, this.signer);
      this.initialized = true;
      console.log(`[ERC8004-REP] Reputation Registry at ${resolved.address.slice(0, 10)}... (${resolved.source})`);
    } catch (err) {
      if (isStrictOnchainMode()) {
        throw formatOnchainError('ERC8004 reputation init failed', err);
      }
      console.warn('[ERC8004-REP] Init failed:', err);
    }
  }

  isConfigured(): boolean {
    return this.initialized && !!this.contract;
  }

  getProtocolState(): {
    configured: boolean;
    contractAddress: string | null;
    addressSource: 'v2_env' | 'legacy_env_alias' | 'unset';
    writeMode: 'client-signer-required' | 'mock';
    readMode: 'local_and_onchain' | 'mock';
  } {
    const resolved = resolveReputationRegistryAddress();
    return {
      configured: this.isConfigured(),
      contractAddress: resolved.address,
      addressSource: resolved.source,
      writeMode: this.isConfigured() ? 'client-signer-required' : 'mock',
      readMode: this.isConfigured() ? 'local_and_onchain' : 'mock',
    };
  }

  /* ── Queue Management ── */

  /**
   * Add feedback to the batch queue. Call flushQueue() to submit.
   */
  queueFeedback(item: FeedbackItem): void {
    this.queue.push(item);

    // Also record locally in DB immediately
    this.recordFeedbackLocally(item)
      .then((id) => {
        item.localFeedbackId = id;
      })
      .catch(err =>
        console.warn('[ERC8004-REP] Local record failed:', err),
      );
  }

  /**
   * Flush the queue — submit all pending feedback on-chain.
   * Called from tick engine every 5 ticks.
   */
  async flushQueue(): Promise<number> {
    let submitted = 0;

    for (let batchIndex = 0; batchIndex < this.MAX_BATCHES_PER_FLUSH; batchIndex++) {
      const batch = this.queue.length > 0
        ? this.queue.splice(0, this.MAX_BATCH_SIZE)
        : await this.loadPendingFeedbackBatch(this.MAX_BATCH_SIZE);

      if (batch.length === 0) {
        break;
      }

      for (const item of batch) {
        const onchainRegistered = await identityRegistry.hasOnchainRegistration(item.erc8004TokenId).catch(() => false);
        if (!onchainRegistered) {
          if (item.localFeedbackId) {
            const pool = getPool();
            await pool.query(
              `UPDATE erc8004_feedback
               SET sync_state = 'blocked_identity'
               WHERE id = $1
                 AND on_chain_tx_hash IS NULL`,
              [item.localFeedbackId],
            );
          }
          continue;
        }
        const route = await this.resolveSubmitterRoute(item).catch((error) => {
          console.warn('[ERC8004-REP] submitter route resolution failed:', error);
          return null;
        });
        if (!route) {
          if (item.localFeedbackId) {
            const pool = getPool();
            await pool.query(
              `UPDATE erc8004_feedback
               SET sync_state = 'blocked_client'
               WHERE id = $1
                 AND on_chain_tx_hash IS NULL`,
              [item.localFeedbackId],
            );
          }
          continue;
        }
        try {
          const txHash = await this.submitFeedbackOnChain(item, route);
          if (txHash) {
            submitted++;
          }
        } catch (err) {
          console.warn(`[ERC8004-REP] Failed to submit feedback for agent ${item.agentId}:`, err);
          // Don't re-queue — local DB already has the record
        }
      }

      if (batch.length < this.MAX_BATCH_SIZE) {
        break;
      }
    }

    if (submitted > 0) {
      console.log(
        `[ERC8004-REP] Submitted ${submitted} feedback on-chain across up to ${this.MAX_BATCHES_PER_FLUSH} batches`,
      );
    }

    return submitted;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  async getPendingFeedbackCount(): Promise<number> {
    const pool = getPool();
    const result = await pool.query<{ count: string }>(
       `SELECT COUNT(*) as count
       FROM erc8004_feedback
       WHERE on_chain_tx_hash IS NULL
         AND COALESCE(sync_state, 'legacy') NOT IN ('blocked_identity', 'blocked_client', 'blocked_self')`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /* ── Submission ── */

  private async resolveSubmitterRoute(item: FeedbackItem): Promise<FeedbackSubmitterRoute | null> {
    const rawClientAddress = item.clientAddress?.trim();
    if (!rawClientAddress || !ethers.isAddress(rawClientAddress)) {
      return null;
    }
    const clientAddress = ethers.getAddress(rawClientAddress);

    if (this.signerAddress && clientAddress.toLowerCase() === this.signerAddress.toLowerCase()) {
      return {
        mode: 'shared',
        clientAddress,
      };
    }

    const context = await getAgentWalletExecutionContextByAddress(clientAddress).catch(() => null);
    if (!context?.teeKeyRef) {
      return null;
    }

    if (context.walletAddress.toLowerCase() !== clientAddress.toLowerCase()) {
      return null;
    }

    return {
      mode: 'agent_wallet',
      clientAddress,
      teeKeyRef: context.teeKeyRef,
      agentId: context.agentId,
    };
  }

  private async submitFeedbackOnChain(
    item: FeedbackItem,
    route: FeedbackSubmitterRoute,
  ): Promise<string | null> {
    if (!this.isConfigured()) return null;

    try {
      const feedbackHash = ethers.id(JSON.stringify(item.metadata ?? {}));
      const iface = new ethers.Interface(REPUTATION_REGISTRY_ABI);
      const txArgs: Parameters<ethers.Contract['giveFeedback']> = [
        item.erc8004TokenId,
        item.value,
        item.valueDecimals,
        item.tag1,
        item.tag2,
        item.endpoint ?? '',
        '',
        feedbackHash,
      ];

      let txHash: string | null = null;

      if (route.mode === 'shared') {
        const receipt = await executeRoleWrite(
          'erc8004_reputation',
          `erc8004.giveFeedback:${item.erc8004TokenId}:${item.tag1}`,
          async () => {
            const tx = await this.contract!.giveFeedback(...txArgs);
            return tx.wait();
          },
        );
        txHash = receipt?.hash ?? null;
      } else {
        const calldata = iface.encodeFunctionData('giveFeedback', txArgs);
        const submitted = await okxTeeWallet.signTransaction(
          route.teeKeyRef!,
          await this.contract!.getAddress(),
          calldata,
          '0',
        );
        const receipt = await getSharedProvider().waitForTransaction(submitted.txHash, 1, 120_000);
        if (!receipt) {
          throw new Error(`[ERC8004-REP] Timed out waiting for reputation tx ${submitted.txHash}`);
        }
        if (receipt.status !== 1) {
          throw new Error(`[ERC8004-REP] Reputation tx ${submitted.txHash} failed on-chain`);
        }
        txHash = receipt.hash;
      }

      // Update local record with tx hash
      const pool = getPool();
      if (item.localFeedbackId) {
        await pool.query(
          `UPDATE erc8004_feedback
           SET on_chain_tx_hash = $1,
               sync_state = CASE WHEN $1::text IS NULL THEN sync_state ELSE 'v2' END
           WHERE id = $2`,
          [txHash, item.localFeedbackId],
        );
      } else {
        await pool.query(
          `WITH target AS (
             SELECT id
             FROM erc8004_feedback
             WHERE agent_erc8004_id = $2
               AND client_address = $3
               AND tag1 = $4
               AND tag2 IS NOT DISTINCT FROM $5
               AND on_chain_tx_hash IS NULL
             ORDER BY created_at ASC
             LIMIT 1
           )
           UPDATE erc8004_feedback
           SET on_chain_tx_hash = $1,
               sync_state = CASE WHEN $1::text IS NULL THEN sync_state ELSE 'v2' END
           WHERE id IN (SELECT id FROM target)`,
          [txHash, item.erc8004TokenId, route.clientAddress, item.tag1, item.tag2],
        );
      }

      return txHash;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Owner/operator cannot feedback')) {
        const pool = getPool();
        if (item.localFeedbackId) {
          await pool.query(
            `UPDATE erc8004_feedback
             SET sync_state = 'blocked_self'
             WHERE id = $1
               AND on_chain_tx_hash IS NULL`,
            [item.localFeedbackId],
          );
        }
      }
      console.warn('[ERC8004-REP] On-chain feedback failed:', err);
      return null;
    }
  }

  private async recordFeedbackLocally(item: FeedbackItem): Promise<number> {
    const pool = getPool();
    const result = await pool.query<{ id: number }>(
      `INSERT INTO erc8004_feedback
        (agent_erc8004_id, client_address, feedback_index, value, value_decimals, tag1, tag2, sync_state)
       VALUES ($1, $2, 0, $3, $4, $5, $6, 'legacy')
       RETURNING id`,
      [
        item.erc8004TokenId,
        item.clientAddress ?? this.signerAddress ?? 'mock_evaluator',
        item.value,
        item.valueDecimals,
        item.tag1,
        item.tag2,
      ],
    );
    return result.rows[0].id;
  }

  private async loadPendingFeedbackBatch(limit: number): Promise<FeedbackItem[]> {
    const pool = getPool();
    const result = await pool.query<PendingFeedbackRow>(
      `SELECT
         f.id,
         a.agent_id,
         f.agent_erc8004_id,
         f.client_address,
         f.value,
         f.value_decimals,
         f.tag1,
         f.tag2
       FROM erc8004_feedback f
       LEFT JOIN agents a ON a.erc8004_token_id = f.agent_erc8004_id
       WHERE f.on_chain_tx_hash IS NULL
         AND COALESCE(f.sync_state, 'legacy') NOT IN ('blocked_identity', 'blocked_client', 'blocked_self')
       ORDER BY f.created_at ASC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => ({
      localFeedbackId: Number(row.id),
      agentId: row.agent_id ?? `token-${row.agent_erc8004_id}`,
      erc8004TokenId: Number(row.agent_erc8004_id),
      clientAddress: row.client_address,
      value: Number(row.value),
      valueDecimals: Number(row.value_decimals ?? 0),
      tag1: row.tag1 ?? '',
      tag2: row.tag2 ?? '',
    }));
  }

  /* ── Convenience: Game Outcome Reporters ── */

  /**
   * Report PD match outcome for both players.
   */
  async reportPDOutcome(params: {
    playerA: { agentId: string; tokenId: number; cooperated: boolean };
    playerB: { agentId: string; tokenId: number; cooperated: boolean };
    matchId: number;
  }): Promise<void> {
    const { playerA, playerB, matchId } = params;
    const [playerAClient, playerBClient] = await Promise.all([
      getAgentWalletAddressStrict(playerB.agentId),
      getAgentWalletAddressStrict(playerA.agentId),
    ]);

    for (const [player, clientAddress] of [
      [playerA, playerAClient],
      [playerB, playerBClient],
    ] as const) {
      const tags = player.cooperated ? FEEDBACK_TAGS.PD_COOPERATION : FEEDBACK_TAGS.PD_BETRAYAL;
      this.queueFeedback({
        agentId: player.agentId,
        erc8004TokenId: player.tokenId,
        value: player.cooperated ? 100 : -50,
        valueDecimals: 0,
        clientAddress,
        ...tags,
        metadata: { matchId, action: player.cooperated ? 'cooperate' : 'betray' },
      });
    }
  }

  /**
   * Report Commons round participation.
   */
  async reportCommonsDecision(params: {
    agentId: string;
    tokenId: number;
    decision: string;
    roundId: number;
    cooperationRate: number;
  }): Promise<void> {
    const { agentId, tokenId, decision, roundId, cooperationRate } = params;
    const isPositive = decision === 'contribute';
    const isSabotage = decision === 'sabotage';

    const tags = isSabotage ? FEEDBACK_TAGS.COMMONS_SABOTAGE : FEEDBACK_TAGS.COMMONS_COOPERATION;
    const clientAddress = await getAgentWalletAddressStrict(agentId).catch(() => undefined);

    this.queueFeedback({
      agentId,
      erc8004TokenId: tokenId,
      value: isPositive ? Math.round(cooperationRate * 100) : (isSabotage ? -100 : -20),
      valueDecimals: 0,
      clientAddress,
      ...tags,
      metadata: { roundId, decision, cooperationRate },
    });
  }

  /**
   * Report Prediction outcome.
   */
  async reportPredictionOutcome(params: {
    agentId: string;
    tokenId: number;
    correct: boolean;
    magnitudeCorrect: boolean;
    roundId: number;
  }): Promise<void> {
    const { agentId, tokenId, correct, magnitudeCorrect, roundId } = params;
    const tags = correct ? FEEDBACK_TAGS.PREDICTION_CORRECT : FEEDBACK_TAGS.PREDICTION_WRONG;
    const value = correct
      ? (magnitudeCorrect ? 100 : 50)
      : -50;
    const clientAddress = await getAgentWalletAddressStrict(agentId).catch(() => undefined);

    this.queueFeedback({
      agentId,
      erc8004TokenId: tokenId,
      value,
      valueDecimals: 0,
      clientAddress,
      ...tags,
      metadata: { roundId, correct, magnitudeCorrect },
    });
  }

  /**
   * Report Intel accuracy after verification.
   */
  async reportIntelAccuracy(params: {
    producerAgentId: string;
    producerTokenId: number;
    accuracy: number;
    isFake: boolean;
    itemId: number;
  }): Promise<void> {
    const { producerAgentId, producerTokenId, accuracy, isFake, itemId } = params;
    const tags = isFake ? FEEDBACK_TAGS.INTEL_FRAUD : FEEDBACK_TAGS.INTEL_ACCURATE;
    const clientAddress = await getAgentWalletAddressStrict(producerAgentId).catch(() => undefined);

    this.queueFeedback({
      agentId: producerAgentId,
      erc8004TokenId: producerTokenId,
      value: isFake ? -100 : Math.round(accuracy * 100),
      valueDecimals: 0,
      clientAddress,
      ...tags,
      metadata: { itemId, accuracy, isFake },
    });
  }

  /* ── Read ── */

  async getAgentReputation(tokenId: number, tag1?: string | string[]): Promise<{
    count: number;
    averageValue: number;
    onChainCount?: number;
    onChainAverageValue?: number;
  }> {
    const pool = getPool();
    const tags = Array.isArray(tag1)
      ? tag1.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
      : typeof tag1 === 'string' && tag1.trim().length > 0
        ? [tag1]
        : [];
    const hasTags = tags.length > 0;
    const query = hasTags
      ? `SELECT COUNT(*) as count, COALESCE(AVG(value),0) as avg_val FROM erc8004_feedback WHERE agent_erc8004_id = $1 AND tag1 = ANY($2::text[]) AND NOT is_revoked`
      : `SELECT COUNT(*) as count, COALESCE(AVG(value),0) as avg_val FROM erc8004_feedback WHERE agent_erc8004_id = $1 AND NOT is_revoked`;
    const onChainQuery = hasTags
      ? `SELECT COUNT(*) as count, COALESCE(AVG(value),0) as avg_val FROM erc8004_feedback WHERE agent_erc8004_id = $1 AND tag1 = ANY($2::text[]) AND NOT is_revoked AND on_chain_tx_hash IS NOT NULL`
      : `SELECT COUNT(*) as count, COALESCE(AVG(value),0) as avg_val FROM erc8004_feedback WHERE agent_erc8004_id = $1 AND NOT is_revoked AND on_chain_tx_hash IS NOT NULL`;

    const params = hasTags ? [tokenId, tags] : [tokenId];
    const [r, onChain] = await Promise.all([
      pool.query<{ count: string; avg_val: string }>(query, params),
      pool.query<{ count: string; avg_val: string }>(onChainQuery, params),
    ]);

    return {
      count: Number(r.rows[0]?.count ?? 0),
      averageValue: Number(Number(r.rows[0]?.avg_val ?? 0).toFixed(1)),
      onChainCount: Number(onChain.rows[0]?.count ?? 0),
      onChainAverageValue: Number(Number(onChain.rows[0]?.avg_val ?? 0).toFixed(1)),
    };
  }

  async getAgentReputationView(tokenId: number, tag1?: string | string[]): Promise<{
    localLedger: { count: number; averageValue: number };
    onChainSummary: { count: number; averageValue: number; clientScope: 'tracked_onchain_clients'; clientCount: number } | null;
    syncState: 'empty' | 'local_only' | 'mixed';
  }> {
    const local = await this.getAgentReputation(tokenId, tag1);

    const onchainRegistered = await identityRegistry.hasOnchainRegistration(tokenId).catch(() => false);
    if (!this.isConfigured() || !onchainRegistered) {
      return {
        localLedger: { count: local.count, averageValue: local.averageValue },
        onChainSummary: null,
        syncState: local.count > 0 ? 'local_only' : 'empty',
      };
    }

    const clients = await this.getTrackedOnChainClients(tokenId);
    if (clients.length === 0) {
      return {
        localLedger: { count: local.count, averageValue: local.averageValue },
        onChainSummary: null,
        syncState: local.count > 0 ? 'local_only' : 'empty',
      };
    }

    const tags = Array.isArray(tag1)
      ? tag1.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
      : typeof tag1 === 'string' && tag1.trim().length > 0
        ? [tag1]
        : [''];

    let totalCount = 0;
    let weightedTotal = 0;

    try {
      for (const tag of tags) {
        const summary = await this.contract!.getSummary(tokenId, clients, tag, '');
        const count = Number(summary[0] ?? 0);
        const value = Number(summary[1] ?? 0);
        const decimals = Number(summary[2] ?? 0);
        const scaled = decimals > 0 ? value / 10 ** decimals : value;
        totalCount += count;
        weightedTotal += scaled * count;
      }
    } catch (error) {
      console.warn('[ERC8004-REP] on-chain summary lookup failed:', error);
      return {
        localLedger: { count: local.count, averageValue: local.averageValue },
        onChainSummary: null,
        syncState: local.count > 0 ? 'local_only' : 'empty',
      };
    }

    return {
      localLedger: { count: local.count, averageValue: local.averageValue },
      onChainSummary: totalCount > 0
        ? {
            count: totalCount,
            averageValue: Number((weightedTotal / totalCount).toFixed(1)),
            clientScope: 'tracked_onchain_clients',
            clientCount: clients.length,
          }
        : null,
      syncState: totalCount > 0 ? 'mixed' : (local.count > 0 ? 'local_only' : 'empty'),
    };
  }

  async getAgentFeedbackHistory(tokenId: number, limit = 50): Promise<Array<{
    value: number;
    tag1: string;
    tag2: string;
    onChain: boolean;
    createdAt: string;
  }>> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT value, tag1, tag2, on_chain_tx_hash IS NOT NULL as on_chain, created_at
       FROM erc8004_feedback
       WHERE agent_erc8004_id = $1 AND NOT is_revoked
       ORDER BY created_at DESC LIMIT $2`,
      [tokenId, limit],
    );
    return r.rows.map((row: Record<string, unknown>) => ({
      value: Number(row.value),
      tag1: row.tag1 as string,
      tag2: row.tag2 as string,
      onChain: row.on_chain as boolean,
      createdAt: row.created_at as string,
    }));
  }

  private async getTrackedOnChainClients(tokenId: number): Promise<string[]> {
    const pool = getPool();
    const result = await pool.query<{ client_address: string }>(
      `SELECT DISTINCT client_address
       FROM erc8004_feedback
       WHERE agent_erc8004_id = $1
         AND on_chain_tx_hash IS NOT NULL
         AND client_address ~ '^0x[0-9a-fA-F]{40}$'`,
      [tokenId],
    );
    return result.rows.map((row) => row.client_address);
  }
}

/* ── Singleton Export ── */
export const reputationRegistry = new ReputationRegistryClient();

/**
 * ERC-8183 Intel Hook — Intel Market Escrow & Verification
 *
 * Manages intel commerce lifecycle:
 *   - Spy operations: createJob → fund → submit (intel content) → complete
 *   - Intel purchases: createJob → fund → submit (delivery) → complete
 *   - Resale: same flow but seller = reseller agent
 *
 * Integrates with ERC-8004 Validation Registry for accuracy verification.
 */

import { getACPClient } from '../acp-client.js';
import { reputationRegistry } from '../../erc8004/reputation-registry.js';
import { validationRegistry } from '../../erc8004/validation-registry.js';
import { getPool } from '../../db/postgres.js';
import type { ACPCategory } from '../acp-types.js';
import { ethers } from 'ethers';
import { INTEL_CONSENSUS_VERIFICATION_THRESHOLD } from '../../intel/intel-types.js';

/**
 * Create an ACP job for a spy operation.
 */
export async function createSpyJob(params: {
  spyAgentId: string;
  targetAgentId: string;
  dimension: string;
  cost: number;
}): Promise<{ acpJobId: number }> {
  const { spyAgentId, targetAgentId, dimension, cost } = params;
  const acp = getACPClient();

  const { localId } = await acp.createAndFundJob({
    category: 'intel_spy' as ACPCategory,
    txType: 'intel_spy',
    clientAgentId: spyAgentId,
    providerAgentId: null, // treasury receives
    budget: cost,
    description: `spy_${spyAgentId}_on_${targetAgentId}_${dimension}`,
    hook: 'intel' as any,
    metadata: { spyAgentId, targetAgentId, dimension, cost },
  });

  return { acpJobId: localId };
}

/**
 * Create an ACP job for an intel purchase.
 */
export async function createIntelPurchaseJob(params: {
  buyerAgentId: string;
  sellerAgentId: string;
  itemId: number;
  category: string;
  price: number;
  isResale: boolean;
  settlementMode?: 'record_only' | 'acp_funded';
}): Promise<{ acpJobId: number; onChainJobId: number; txHash: string | null }> {
  const { buyerAgentId, sellerAgentId, itemId, category, price, isResale, settlementMode = 'record_only' } = params;
  const acp = getACPClient();

  const acpResult = settlementMode === 'acp_funded'
    ? await acp.createAndFundJobWithAgentWallets({
        category: (isResale ? 'intel_listing' : 'intel_purchase') as ACPCategory,
        txType: isResale ? 'intel_purchase' : 'intel_v2_purchase',
        clientAgentId: buyerAgentId,
        providerAgentId: sellerAgentId,
        budget: price,
        description: `intel_buy_${itemId}_${category}${isResale ? '_resale' : ''}`,
        hook: 'intel' as any,
        metadata: {
          buyerAgentId,
          sellerAgentId,
          itemId,
          category,
          price,
          isResale,
          recordOnly: false,
          settlement: 'acp_escrow',
          acpMode: 'funded_intel_purchase',
        },
      })
    : await acp.createOpenJob({
        category: (isResale ? 'intel_listing' : 'intel_purchase') as ACPCategory,
        txType: isResale ? 'intel_purchase' : 'intel_v2_purchase',
        providerAgentId: sellerAgentId,
        description: `intel_buy_${itemId}_${category}${isResale ? '_resale' : ''}`,
        hook: 'intel' as any,
        metadata: {
          buyerAgentId,
          sellerAgentId,
          itemId,
          category,
          price,
          isResale,
          recordOnly: true,
          settlement: 'x402_direct_wallet',
          acpMode: 'record_only',
        },
      });

  return { acpJobId: acpResult.localId, onChainJobId: acpResult.onChainJobId, txHash: acpResult.txHash };
}

/**
 * Create an ACP job for a fate listing purchase.
 */
export async function createFateListingPurchaseJob(params: {
  buyerAgentId: string;
  sellerAgentId: string;
  listingId: number;
  subjectAgentId: string;
  dimension: string;
  price: number;
}): Promise<{ acpJobId: number }> {
  const { buyerAgentId, sellerAgentId, listingId, subjectAgentId, dimension, price } = params;
  const acp = getACPClient();

  const { localId } = await acp.createOpenJob({
    category: 'intel_listing' as ACPCategory,
    txType: 'intel_purchase',
    providerAgentId: sellerAgentId,
    description: `fate_listing_${listingId}_${subjectAgentId}_${dimension}`,
    hook: 'intel' as any,
    metadata: {
      buyerAgentId,
      sellerAgentId,
      listingId,
      subjectAgentId,
      dimension,
      price,
      sourceMarket: 'fate_listing',
      recordOnly: true,
      settlement: 'x402_direct_wallet',
      acpMode: 'record_only',
    },
  });

  return { acpJobId: localId };
}

/**
 * Complete an intel purchase and request on-chain validation.
 */
export async function completeIntelPurchase(params: {
  acpJobId: number;
  itemId: number;
  producerAgentId: string;
  category: string;
  contentHash: string;
  accuracy?: number;
}): Promise<void> {
  const { acpJobId, itemId, producerAgentId, category, contentHash, accuracy } = params;
  const acp = getACPClient();
  const pool = getPool();

  const jobRow = await pool.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata
     FROM acp_jobs
     WHERE id = $1`,
    [acpJobId],
  );
  const metadata = (jobRow.rows[0]?.metadata ?? {}) as Record<string, unknown>;
  const isRecordOnly = metadata.recordOnly === true || metadata.acpMode === 'record_only';

  // Submit + complete the purchase job
  if (!isRecordOnly) {
    await acp.submitJob(acpJobId, `intel_delivered_${itemId}`);
    await acp.completeJob(acpJobId, `purchased_${itemId}`);
  }

  // Request on-chain validation
  const tokenR = await pool.query<{ erc8004_token_id: number }>(
    'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
    [producerAgentId],
  );
  const tokenId = tokenR.rows[0]?.erc8004_token_id;

  if (tokenId) {
    const requestHash = ethers.id(`intel_${itemId}_${contentHash}`);
    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM erc8004_validations
       WHERE request_hash = $1 OR intel_item_id = $2
       LIMIT 1`,
      [requestHash, itemId],
    );

    if (existing.rows.length === 0) {
      await validationRegistry.requestValidation({
        producerTokenId: tokenId,
        intelItemId: itemId,
        category,
        contentHash,
      });
    }
  }
}

/**
 * After 3+ buyers verify intel, submit the verification result on-chain.
 */
export async function verifyIntelOnChain(params: {
  itemId: number;
  producerAgentId: string;
  verifiedAccuracy: number;
  isFake: boolean;
  verifiedByCount: number;
}): Promise<void> {
  const { itemId, producerAgentId, verifiedAccuracy, isFake, verifiedByCount } = params;
  if (verifiedByCount < INTEL_CONSENSUS_VERIFICATION_THRESHOLD) {
    return;
  }

  // Find the validation request hash
  const pool = getPool();
  const valR = await pool.query<{ request_hash: string; status: string }>(
    `SELECT request_hash, status
     FROM erc8004_validations
     WHERE intel_item_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [itemId],
  );

  if (valR.rows[0] && valR.rows[0].status !== 'responded') {
    await validationRegistry.respondValidation({
      requestHash: valR.rows[0].request_hash,
      accuracyScore: Math.round(verifiedAccuracy * 100),
      verifiedByCount,
      isFake,
    });
  }

  // Post reputation feedback
  const tokenR = await pool.query<{ erc8004_token_id: number }>(
    'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
    [producerAgentId],
  );
  const tokenId = tokenR.rows[0]?.erc8004_token_id;

  if (tokenId) {
    await reputationRegistry.reportIntelAccuracy({
      producerAgentId,
      producerTokenId: tokenId,
      accuracy: verifiedAccuracy,
      isFake,
      itemId,
    });
  }
}

/**
 * Complete a fate listing purchase on ACP without going through intel-item validation.
 */
export async function completeFateListingPurchase(params: {
  acpJobId: number;
  listingId: number;
  subjectAgentId: string;
  dimension: string;
  deliveredValue: string | null;
}): Promise<void> {
  const { acpJobId, listingId, subjectAgentId, dimension, deliveredValue } = params;
  const acp = getACPClient();
  const pool = getPool();

  const jobRow = await pool.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata
     FROM acp_jobs
     WHERE id = $1`,
    [acpJobId],
  );
  const metadata = (jobRow.rows[0]?.metadata ?? {}) as Record<string, unknown>;
  const isRecordOnly = metadata.recordOnly === true || metadata.acpMode === 'record_only';

  const deliverable = ethers.id(
    JSON.stringify({
      type: 'fate_listing_delivery',
      listingId,
      subjectAgentId,
      dimension,
      deliveredValue,
    }),
  );

  if (!isRecordOnly) {
    await acp.submitJob(acpJobId, deliverable);
    await acp.completeJob(acpJobId, `fate_listing_purchased_${listingId}`);
  }
}

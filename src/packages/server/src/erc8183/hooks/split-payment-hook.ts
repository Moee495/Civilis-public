/**
 * ERC-8183 Split Payment Hook — Paywall & Multi-Recipient Commerce
 *
 * Handles transactions where payment splits between multiple recipients:
 *   - Paywall: 70% to author, 30% to treasury
 *   - Death social: 30% split among all alive agents
 *   - Any future multi-recipient flow
 */

import { getACPClient } from '../acp-client.js';
import { processX402Payment } from '../../x402/payment-processor.js';
import type { ACPCategory } from '../acp-types.js';

/**
 * Create an ACP job for a paywall unlock with 70/30 split.
 */
export async function createPaywallJob(params: {
  buyerAgentId: string;
  authorAgentId: string;
  postId: number;
  totalPrice: number;
}): Promise<{ acpJobId: number }> {
  const { buyerAgentId, authorAgentId, postId, totalPrice } = params;
  const acp = getACPClient();

  const authorAmount = Number((totalPrice * 0.7).toFixed(6));
  const treasuryAmount = Number((totalPrice * 0.3).toFixed(6));

  const { localId } = await acp.createAndFundJob({
    category: 'social_paywall' as ACPCategory,
    txType: 'paywall',
    clientAgentId: buyerAgentId,
    providerAgentId: authorAgentId,
    budget: totalPrice,
    description: `paywall_post_${postId}`,
    hook: 'split_payment' as any,
    metadata: {
      postId,
      buyerAgentId,
      authorAgentId,
      authorAmount,
      treasuryAmount,
      splitRatio: '70/30',
    },
  });

  // Instant completion for paywall (no escrow needed)
  await acp.submitJob(localId, `paywall_unlocked_${postId}`);
  await acp.completeJob(localId, `split_70_30`);

  // Dual-write local payments
  await processX402Payment('paywall', buyerAgentId, authorAgentId, authorAmount, { postId, acpJobId: localId });
  await processX402Payment('paywall', buyerAgentId, null, treasuryAmount, { postId, acpJobId: localId, split: 'treasury' });

  return { acpJobId: localId };
}

/**
 * Create an ACP job for a tip (instant, no split).
 */
export async function createTipJob(params: {
  fromAgentId: string;
  toAgentId: string;
  postId: number;
  amount: number;
}): Promise<{ acpJobId: number }> {
  const { fromAgentId, toAgentId, postId, amount } = params;
  const acp = getACPClient();

  const { localId } = await acp.instantJob({
    category: 'social_tip' as ACPCategory,
    txType: 'tip',
    clientAgentId: fromAgentId,
    providerAgentId: toAgentId,
    budget: amount,
    description: `tip_post_${postId}`,
    metadata: { postId, fromAgentId, toAgentId },
  });

  // Dual-write
  await processX402Payment('tip', fromAgentId, toAgentId, amount, { postId, acpJobId: localId });

  return { acpJobId: localId };
}

/**
 * Create an ACP job for death social distribution.
 */
export async function createDeathDistributionJob(params: {
  deadAgentId: string;
  heirAgentId: string | null;
  totalBalance: number;
  treasuryShare: number;
  inheritanceShare: number;
  socialShare: number;
  aliveAgentCount: number;
}): Promise<{ acpJobId: number }> {
  const { deadAgentId, totalBalance, treasuryShare, inheritanceShare, socialShare, heirAgentId, aliveAgentCount } = params;
  const acp = getACPClient();

  const { localId } = await acp.instantJob({
    category: 'death_settlement' as ACPCategory,
    txType: 'death_treasury',
    clientAgentId: deadAgentId,
    providerAgentId: null,
    budget: totalBalance,
    description: `death_settlement_${deadAgentId}`,
    metadata: {
      deadAgentId,
      heirAgentId,
      treasuryShare,
      inheritanceShare,
      socialShare,
      aliveAgentCount,
      distribution: '30% treasury, 40% heir, 30% social',
    },
  });

  return { acpJobId: localId };
}

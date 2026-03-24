/**
 * ERC-8183 Commons Hook — Public Goods Escrow & Settlement
 *
 * Manages commons round lifecycle:
 *   createJob (base injection + contributions) → fund (pool escrow)
 *     → submit (decisions + multiplier calc) → complete (weighted distribution)
 */

import { getACPClient } from '../acp-client.js';
import { reputationRegistry } from '../../erc8004/reputation-registry.js';
import { getPool } from '../../db/postgres.js';
import type { ACPCategory } from '../acp-types.js';

/**
 * Create an ACP job for a commons round.
 */
export async function createCommonsJob(params: {
  roundId: number;
  roundNumber: number;
  baseInjection: number;
  predictionLossPool: number;
  contributeTotal: number;
  participantCount: number;
}): Promise<{ acpJobId: number }> {
  const { roundId, roundNumber, baseInjection, predictionLossPool, contributeTotal, participantCount } = params;
  const acp = getACPClient();

  const totalPool = baseInjection + predictionLossPool + contributeTotal;

  const { localId } = await acp.createAndFundJob({
    category: 'commons_round' as ACPCategory,
    txType: 'arena_entry',
    clientAgentId: null,    // pool funded by system + agents
    providerAgentId: null,  // distributed to participants
    budget: totalPool,
    description: `commons_R${roundNumber}_pool_${totalPool.toFixed(3)}`,
    hook: 'commons' as any,
    expirySeconds: 180,     // 3 minutes
    metadata: {
      roundId,
      roundNumber,
      baseInjection,
      predictionLossPool,
      contributeTotal,
      participantCount,
    },
  });

  return { acpJobId: localId };
}

/**
 * Settle a commons round — distribute pool based on cooperation.
 */
export async function settleCommonsJob(params: {
  acpJobId: number;
  roundId: number;
  cooperationRate: number;
  multiplier: number;
  finalPool: number;
  sabotageDamage: number;
  decisions: Array<{
    agentId: string;
    decision: string;
    payout: number;
    netProfit: number;
  }>;
}): Promise<void> {
  const { acpJobId, roundId, cooperationRate, multiplier, finalPool, sabotageDamage, decisions } = params;
  const acp = getACPClient();

  // Submit the round results
  const deliverable = `commons_${roundId}_coop_${(cooperationRate * 100).toFixed(0)}pct_mult_${multiplier}x_pool_${finalPool.toFixed(3)}`;
  await acp.submitJob(acpJobId, deliverable);

  // Complete (release escrowed funds)
  const reason = `settled_${roundId}_sabotage_${sabotageDamage.toFixed(3)}`;
  await acp.completeJob(acpJobId, reason);

  // Post reputation feedback
  const pool = getPool();
  for (const d of decisions) {
    const tokenR = await pool.query<{ erc8004_token_id: number }>(
      'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
      [d.agentId],
    );
    const tokenId = tokenR.rows[0]?.erc8004_token_id;
    if (tokenId) {
      await reputationRegistry.reportCommonsDecision({
        agentId: d.agentId,
        tokenId,
        decision: d.decision,
        roundId,
        cooperationRate,
      });
    }
  }
}

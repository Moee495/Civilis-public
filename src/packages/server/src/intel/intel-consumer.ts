/**
 * Intel Market — Agent Auto-Purchase Engine
 * Called every 5 ticks. Agents buy intel from the V2 market.
 */

import { getPool, withTransaction } from '../db/postgres.js';
import { ethers } from 'ethers';
import { ARCHETYPE_INTEL_PROFILE, INTEL_PUBLIC_BUYER_THRESHOLD, INTEL_PUBLIC_REVEAL_DELAY_TICKS } from './intel-types.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { eventBus } from '../realtime.js';
import { createIntelPurchaseJob, completeIntelPurchase } from '../erc8183/hooks/intel-hook.js';
import { describeIntelMarketSignal, loadIntelMarketSignals } from './intel-market-scoring.js';
import { canBuyIntel } from './intel-phase-gate.js';

function getConsensusProgress(item: { buyer_count?: number }): number {
  const buyerCount = Number(item.buyer_count ?? 0);
  return Math.max(0, Math.min(INTEL_PUBLIC_BUYER_THRESHOLD - 1, buyerCount));
}

function isConsensusCandidate(item: { buyer_count?: number }): boolean {
  const buyerCount = Number(item.buyer_count ?? 0);
  return buyerCount > 0 && buyerCount < INTEL_PUBLIC_BUYER_THRESHOLD;
}

export async function processIntelPurchaseDecisions(tickNumber: number): Promise<void> {
  const pool = getPool();

  const [agents, available, signals] = await Promise.all([
    pool.query<{
    agent_id: string; archetype: string; balance: string;
  }>('SELECT agent_id, archetype, balance FROM agents WHERE is_alive = true'),
    pool.query(
    `SELECT id, category, producer_agent_id, subject_agent_id, content, price, declared_accuracy, freshness, buyer_count
     FROM intel_items
     WHERE status = 'active'
       AND is_public = false
       AND buyer_count < $1
       AND freshness > 0.1`,
    [INTEL_PUBLIC_BUYER_THRESHOLD]
    ),
    loadIntelMarketSignals(),
  ]);

  if (available.rows.length === 0) return;

  let purchaseCount = 0;

  for (const agent of agents.rows) {
    const profile = ARCHETYPE_INTEL_PROFILE[agent.archetype];
    if (!profile) continue;
    const canBuy = await canBuyIntel(agent.agent_id);
    if (!canBuy) continue;

    const balance = parseFloat(agent.balance);
    const budget = balance * profile.purchaseBudgetRatio;
    if (budget < 0.01 || balance < 1.0) continue;

    // Already bought items
    const bought = await pool.query(
      'SELECT intel_item_id FROM intel_purchases WHERE buyer_agent_id = $1',
      [agent.agent_id]
    );
    const boughtSet = new Set(bought.rows.map((r: any) => r.intel_item_id));

    // Filter candidates
    const candidates = available.rows.filter((item: any) =>
      item.producer_agent_id !== agent.agent_id &&
      !boughtSet.has(item.id) &&
      parseFloat(item.price) <= budget
    );
    if (candidates.length === 0) continue;

    const consensusCandidates = candidates.filter((item: any) => isConsensusCandidate(item));
    const candidatePool = consensusCandidates.length > 0 ? consensusCandidates : candidates;

    // Sort: real utility > personal priority > consensus closing > freshness / accuracy
    const prioritySet = new Set(profile.purchasePriority);
    const sorted = [...candidatePool].sort((a: any, b: any) => {
      const aSignal = describeIntelMarketSignal(a, signals);
      const bSignal = describeIntelMarketSignal(b, signals);
      const aPrio = prioritySet.has(a.category) ? 8 : 0;
      const bPrio = prioritySet.has(b.category) ? 8 : 0;
      const aConsensus = getConsensusProgress(a) * 4;
      const bConsensus = getConsensusProgress(b) * 4;
      return (bSignal.demandScore + bPrio + bConsensus) - (aSignal.demandScore + aPrio + aConsensus);
    });

    const chosen = sorted[0];
    const chosenSignal = describeIntelMarketSignal(chosen, signals);
    const purchaseChance = Math.min(
      0.96,
      profile.purchaseBudgetRatio * 1.6 +
        chosenSignal.demandScore / 120 +
        (consensusCandidates.length > 0 ? 0.12 : 0),
    );
    if (chosenSignal.demandTier === 'low' && Math.random() > 0.18) continue;
    if (Math.random() > purchaseChance) continue;

    const price = parseFloat(chosen.price);
    const contentHash = ethers.id(JSON.stringify(chosen.content ?? {}));

    try {
      const { acpJobId } = await createIntelPurchaseJob({
        buyerAgentId: agent.agent_id,
        sellerAgentId: chosen.producer_agent_id,
        itemId: chosen.id,
        category: chosen.category,
        price,
        isResale: false,
      });

      await processX402Payment('intel_v2_purchase', agent.agent_id, chosen.producer_agent_id, price, {
        itemId: chosen.id, category: chosen.category, acpJobId,
      });

      // Atomic buyer_count increment with FOR UPDATE lock to prevent race condition
      await withTransaction(async (client) => {
        const locked = await client.query<{ buyer_count: number }>(
          'SELECT buyer_count FROM intel_items WHERE id = $1 FOR UPDATE',
          [chosen.id],
        );
        const currentCount = locked.rows[0]?.buyer_count ?? 0;
        if (currentCount >= INTEL_PUBLIC_BUYER_THRESHOLD) {
          throw new Error('Item is already consensus-sealed');
        }
        const newCount = currentCount + 1;
        const isConsensusSealed = newCount >= INTEL_PUBLIC_BUYER_THRESHOLD;

        await client.query(
          `INSERT INTO intel_purchases (intel_item_id, buyer_agent_id, price_paid, purchased_at_tick)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [chosen.id, agent.agent_id, price, tickNumber],
        );

        await client.query(
          `UPDATE intel_items
           SET buyer_count = $1,
               consensus_reached_at_tick = CASE
                 WHEN $2 THEN COALESCE(consensus_reached_at_tick, $3)
                 ELSE consensus_reached_at_tick
               END,
               public_after_tick = CASE
                 WHEN $2 THEN COALESCE(public_after_tick, $4)
                 ELSE public_after_tick
               END,
               last_buyer_agent_id = $5
           WHERE id = $6`,
          [
            newCount,
            isConsensusSealed,
            tickNumber,
            tickNumber + INTEL_PUBLIC_REVEAL_DELAY_TICKS,
            agent.agent_id,
            chosen.id,
          ],
        );
      });

      await completeIntelPurchase({
        acpJobId,
        itemId: chosen.id,
        producerAgentId: chosen.producer_agent_id,
        category: chosen.category,
        contentHash,
      });

      purchaseCount++;
      eventBus.emit('intel_v2_purchased', {
        itemId: chosen.id,
        buyerAgentId: agent.agent_id,
        category: chosen.category,
        price,
        tick: tickNumber,
        acpJobId,
        buyerCount: Number(chosen.buyer_count ?? 0) + 1,
        isNowPublic: false,
        isConsensusSealed: Number(chosen.buyer_count ?? 0) + 1 >= INTEL_PUBLIC_BUYER_THRESHOLD,
        publicAfterTick:
          Number(chosen.buyer_count ?? 0) + 1 >= INTEL_PUBLIC_BUYER_THRESHOLD
            ? tickNumber + INTEL_PUBLIC_REVEAL_DELAY_TICKS
            : null,
      });
    } catch (err) {
      // Log the actual error — don't silently swallow
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Insufficient balance')) {
        console.warn(`[Intel] Purchase failed for ${agent.agent_id} on item ${chosen.id}: ${msg}`);
      }
    }
  }

  if (purchaseCount > 0) {
    console.log(`[Intel] Purchase tick ${tickNumber}: ${purchaseCount} items bought`);
  }
}

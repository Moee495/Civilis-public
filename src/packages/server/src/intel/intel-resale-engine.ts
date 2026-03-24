/**
 * Intel Market — Auto-Resale Engine + Price Decay
 *
 * 1. Auto Price Decay: Unsold listings lose 10% price every 5 ticks
 * 2. Agent Auto-Resale: Fox/Hawk/Chaos flip purchased intel for profit
 * 3. Demand-Driven Buying: Before PD/Prediction, agents seek opponent intel
 */

import { getPool } from '../db/postgres.js';
import { ethers } from 'ethers';
import { ARCHETYPE_INTEL_PROFILE, INTEL_PUBLIC_BUYER_THRESHOLD, INTEL_PUBLIC_REVEAL_DELAY_TICKS } from './intel-types.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { eventBus } from '../realtime.js';
import { createIntelPurchaseJob, completeIntelPurchase } from '../erc8183/hooks/intel-hook.js';
import { describeIntelMarketSignal, loadIntelMarketSignals } from './intel-market-scoring.js';
import { canBuyIntel, canTradeIntel } from './intel-phase-gate.js';

// Resale propensity by archetype (higher = more likely to flip intel)
const RESALE_CHANCE: Record<string, number> = {
  fox: 0.40,     // Information broker — loves flipping
  hawk: 0.25,    // Aggressive trader
  chaos: 0.20,   // Random flips
  whale: 0.05,   // Buys but hoards, rarely sells
  echo: 0.10,    // Follows trends
  oracle: 0.08,  // Produces, doesn't flip
  sage: 0.02,    // Rarely resells
  monk: 0.01,    // Almost never resells
};

// Markup strategy by archetype
const RESALE_MARKUP: Record<string, { min: number; max: number }> = {
  fox: { min: 0.8, max: 1.5 },     // Sometimes undercuts, sometimes marks up
  hawk: { min: 1.2, max: 2.0 },    // Always tries to mark up
  chaos: { min: 0.5, max: 3.0 },   // Wild swings
  whale: { min: 1.5, max: 2.5 },   // Premium resale
  echo: { min: 0.9, max: 1.2 },    // Slight markup
  oracle: { min: 1.0, max: 1.3 },  // Fair resale
  sage: { min: 0.7, max: 0.9 },    // Discount (wants info to spread)
  monk: { min: 0.8, max: 1.0 },    // At cost or below
};

/**
 * Auto Price Decay — unsold intel gets cheaper over time
 * Called every 5 ticks
 */
export async function decayIntelPrices(currentTick: number): Promise<void> {
  const pool = getPool();

  // Reduce price by 10% for items that have been listed for at least 5 ticks with 0 buyers
  const result = await pool.query(
    `UPDATE intel_items
     SET price = GREATEST(0.01, price * 0.9)
     WHERE status = 'active'
       AND buyer_count = 0
       AND created_at_tick <= $1 - 5
       AND price > 0.01`,
    [currentTick],
  );

  if ((result.rowCount ?? 0) > 0) {
    console.log(`[Intel] Price decay: ${result.rowCount} unsold items discounted 10%`);
  }
}

/**
 * Agent Auto-Resale — agents flip purchased intel for profit
 * Called every 7 ticks
 */
export async function processAgentAutoResale(currentTick: number): Promise<void> {
  const pool = getPool();

  const [agents, signals] = await Promise.all([
    pool.query<{
    agent_id: string; name: string; archetype: string; balance: string;
  }>('SELECT agent_id, name, archetype, balance FROM agents WHERE is_alive = true'),
    loadIntelMarketSignals(),
  ]);

  let resaleCount = 0;

  for (const agent of agents.rows) {
    const canTrade = await canTradeIntel(agent.agent_id);
    if (!canTrade) continue;

    const chance = RESALE_CHANCE[agent.archetype] ?? 0.10;
    if (Math.random() >= chance) continue;

    // Find intel this agent purchased that is:
    // - Not yet public
    // - Not already relisted by this agent
    // - Still has resale value (freshness > 0.3)
    const purchased = await pool.query<{
      item_id: number; category: string; subject_agent_id: string | null;
      price: string; freshness: string; accuracy: string; declared_accuracy: string;
      is_fake: boolean; content: string; buyer_count: number;
    }>(
      `SELECT i.id as item_id, i.category, i.subject_agent_id, i.price, i.freshness,
              i.accuracy, i.declared_accuracy, i.is_fake, i.content::text, i.buyer_count
       FROM intel_purchases p
       JOIN intel_items i ON i.id = p.intel_item_id
       WHERE p.buyer_agent_id = $1
         AND i.is_public = false
         AND i.freshness > 0.3
         AND NOT EXISTS (
           SELECT 1 FROM intel_items r
           WHERE r.producer_agent_id = $1
             AND r.category = i.category
             AND r.subject_agent_id IS NOT DISTINCT FROM i.subject_agent_id
             AND r.status = 'active'
         )
       ORDER BY i.freshness DESC
       LIMIT 1`,
      [agent.agent_id],
    );

    if (purchased.rows.length === 0) continue;

    const item = purchased.rows[0];
    const signal = describeIntelMarketSignal(
      {
        ...item,
        producer_agent_id: agent.agent_id,
      },
      signals,
    );
    const deservesRelist = signal.demandTier !== 'low' || signal.subjectInArena || Number(item.buyer_count) > 0;
    if (!deservesRelist && Math.random() > 0.12) continue;

    const markup = RESALE_MARKUP[agent.archetype] ?? { min: 0.9, max: 1.3 };
    const multiplier = markup.min + Math.random() * (markup.max - markup.min);
    const resalePrice = Math.max(0.01, Number((Number(item.price) * multiplier).toFixed(6)));
    const newFreshness = Math.max(0.3, Number(item.freshness) * 0.8);

    try {
      await pool.query(
        `INSERT INTO intel_items
          (category, producer_agent_id, subject_agent_id, content, accuracy, declared_accuracy,
           is_fake, freshness, price, buyer_count, is_public, status, expires_at_tick, created_at_tick)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 0, false, 'active', $10, $11)`,
        [
          item.category,
          agent.agent_id,
          item.subject_agent_id,
          item.content,
          item.accuracy,
          item.declared_accuracy,
          item.is_fake,
          newFreshness,
          resalePrice,
          currentTick + 30,
          currentTick,
        ],
      );

      resaleCount++;
      eventBus.emit('intel_v2_resale', {
        sellerAgentId: agent.agent_id,
        sellerName: agent.name,
        category: item.category,
        originalPrice: Number(item.price),
        resalePrice,
        tick: currentTick,
      });
    } catch (err) {
      // Duplicate or constraint violation — skip
    }
  }

  if (resaleCount > 0) {
    console.log(`[Intel] Auto-resale tick ${currentTick}: ${resaleCount} items relisted`);
  }
}

/**
 * Demand-Driven Intel Buying — before PD matches, agents seek opponent intel
 * Called every 5 ticks (same as regular purchase cycle)
 */
export async function processDemandDrivenPurchases(currentTick: number): Promise<void> {
  const pool = getPool();
  const signals = await loadIntelMarketSignals();

  // Find agents currently in active matches
  const activeMatches = await pool.query<{
    player_a_id: string; player_b_id: string;
  }>(
    `SELECT player_a_id, player_b_id FROM arena_matches
     WHERE status IN ('negotiating', 'deciding')`,
  );

  if (activeMatches.rows.length === 0) return;

  let purchaseCount = 0;

  for (const match of activeMatches.rows) {
    for (const [buyerId, targetId] of [
      [match.player_a_id, match.player_b_id],
      [match.player_b_id, match.player_a_id],
    ]) {
      // Check if buyer has enough balance and hasn't already bought intel about this target
      const buyer = await pool.query<{ balance: string; archetype: string }>(
        'SELECT balance, archetype FROM agents WHERE agent_id = $1 AND is_alive = true',
        [buyerId],
      );
      if (buyer.rows.length === 0) continue;
      const canBuy = await canBuyIntel(buyerId);
      if (!canBuy) continue;

      const balance = parseFloat(buyer.rows[0].balance);
      const profile = ARCHETYPE_INTEL_PROFILE[buyer.rows[0].archetype];
      if (!profile || balance < 1.0) continue;

      const budget = balance * profile.purchaseBudgetRatio * 0.5; // Half budget for demand buys

      // Prefer intel that is already close to consensus, then fall back to cheaper items.
      const intel = await pool.query<{ id: number; price: string; category: string; producer_agent_id: string; content: unknown; buyer_count: number; freshness: string; declared_accuracy: string; verified_accuracy: string | null; subject_agent_id: string | null; is_public: boolean }>(
        `SELECT id, price, category, producer_agent_id, content, buyer_count, freshness, declared_accuracy, verified_accuracy, subject_agent_id, is_public
         FROM intel_items
         WHERE subject_agent_id = $1
           AND status = 'active'
           AND is_public = false
           AND buyer_count < $3
           AND producer_agent_id != $2
           AND NOT EXISTS (
             SELECT 1 FROM intel_purchases
             WHERE intel_item_id = intel_items.id AND buyer_agent_id = $2
           )
         ORDER BY buyer_count DESC, price ASC
         LIMIT 5`,
        [targetId, buyerId, INTEL_PUBLIC_BUYER_THRESHOLD],
      );

      if (intel.rows.length === 0) continue;

      const chosen = [...intel.rows].sort((a, b) => {
        const aSignal = describeIntelMarketSignal(a, signals);
        const bSignal = describeIntelMarketSignal(b, signals);
        return bSignal.demandScore - aSignal.demandScore;
      })[0];
      const chosenSignal = describeIntelMarketSignal(chosen, signals);
      if (chosenSignal.demandTier === 'low' && Math.random() > 0.25) continue;

      const itemPrice = Number(chosen.price);
      if (itemPrice > budget) continue;

      try {
        const { acpJobId } = await createIntelPurchaseJob({
          buyerAgentId: buyerId,
          sellerAgentId: chosen.producer_agent_id,
          itemId: chosen.id,
          category: chosen.category,
          price: itemPrice,
          isResale: false,
        });
        const contentHash = ethers.id(JSON.stringify(chosen.content ?? {}));

        // Execute purchase
        await processX402Payment('intel_v2_purchase' as any, buyerId, chosen.producer_agent_id, itemPrice, {
          intelItemId: chosen.id, category: chosen.category, demandDriven: true, acpJobId,
        });

        await pool.query(
          `INSERT INTO intel_purchases (intel_item_id, buyer_agent_id, price_paid, purchased_at_tick)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [chosen.id, buyerId, itemPrice, currentTick],
        );

        const updated = await pool.query<{ buyer_count: number }>(
          `UPDATE intel_items
           SET buyer_count = buyer_count + 1,
               consensus_reached_at_tick = CASE
                 WHEN buyer_count + 1 >= $2 THEN COALESCE(consensus_reached_at_tick, $3)
                 ELSE consensus_reached_at_tick
               END,
               public_after_tick = CASE
                 WHEN buyer_count + 1 >= $2 THEN COALESCE(public_after_tick, $4)
                 ELSE public_after_tick
               END,
               last_buyer_agent_id = $5
           WHERE id = $1
             AND buyer_count < $2
           RETURNING buyer_count`,
          [
            chosen.id,
            INTEL_PUBLIC_BUYER_THRESHOLD,
            currentTick,
            currentTick + INTEL_PUBLIC_REVEAL_DELAY_TICKS,
            buyerId,
          ],
        );
        const newBuyerCount = updated.rows[0]?.buyer_count ?? 0;
        if (!newBuyerCount) {
          continue;
        }
        const isConsensusSealed = newBuyerCount >= INTEL_PUBLIC_BUYER_THRESHOLD;

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
          buyerAgentId: buyerId,
          producerAgentId: chosen.producer_agent_id,
          category: chosen.category,
          price: itemPrice,
          tick: currentTick,
          demandDriven: true,
          acpJobId,
          buyerCount: newBuyerCount,
          isNowPublic: false,
          isConsensusSealed,
          publicAfterTick: isConsensusSealed ? currentTick + INTEL_PUBLIC_REVEAL_DELAY_TICKS : null,
        });
      } catch {
        // Insufficient balance or duplicate
      }
    }
  }

  if (purchaseCount > 0) {
    console.log(`[Intel] Demand-driven purchases tick ${currentTick}: ${purchaseCount} intel bought before matches`);
  }
}

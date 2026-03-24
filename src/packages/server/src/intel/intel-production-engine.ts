/**
 * Intel Market V2 — Production Engine
 * Called by tick-engine to produce intel items and decay freshness.
 */

import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import {
  type IntelCategory,
  type IntelContent,
  ARCHETYPE_INTEL_PROFILE,
  INTEL_CATEGORY_BASE_PRICE,
} from './intel-types.js';

// ── Constants ──

const FRESHNESS_DECAY_PER_TICK = 0.05;
const INTEL_LIFETIME_TICKS = 20;          // ~10 minutes
const MAX_ITEMS_PER_AGENT_PER_CYCLE = 1;  // prevent flooding

// ── Freshness Decay (every tick) ──

export async function decayIntelFreshness(tickNumber: number): Promise<void> {
  const pool = getPool();

  // Decay freshness on all active items
  await pool.query(
    `UPDATE intel_items
     SET freshness = GREATEST(0, freshness - $1)
     WHERE status = 'active'`,
    [FRESHNESS_DECAY_PER_TICK]
  );

  // Expire items past their tick or with 0 freshness
  const expired = await pool.query(
    `UPDATE intel_items
     SET status = 'expired'
     WHERE status = 'active' AND (expires_at_tick <= $1 OR freshness <= 0)
     RETURNING id`,
    [tickNumber]
  );

  if (expired.rowCount && expired.rowCount > 0) {
    console.log(`[Intel] Expired ${expired.rowCount} intel items at tick ${tickNumber}`);
  }

  const published = await pool.query<{ id: number; producer_agent_id: string; category: string }>(
    `UPDATE intel_items
     SET is_public = true,
         public_revealed_at_tick = $1
     WHERE is_public = false
       AND public_after_tick IS NOT NULL
       AND public_after_tick <= $1
     RETURNING id, producer_agent_id, category`,
    [tickNumber],
  );

  if (published.rowCount && published.rowCount > 0) {
    console.log(`[Intel] Revealed ${published.rowCount} consensus-sealed items at tick ${tickNumber}`);
    for (const item of published.rows) {
      eventBus.emit('intel_public_revealed', {
        itemId: item.id,
        producerAgentId: item.producer_agent_id,
        category: item.category,
        tick: tickNumber,
      });
    }
  }
}

// ── Intel Production (every 3 ticks) ──

export async function produceIntelForTick(tickNumber: number): Promise<void> {
  const pool = getPool();

  // Get all alive agents
  const agentsResult = await pool.query<{
    agent_id: string;
    name: string;
    archetype: string;
    balance: string;
    reputation_score: number;
  }>('SELECT agent_id, name, archetype, balance, reputation_score FROM agents WHERE is_alive = true');

  const agents = agentsResult.rows;
  if (agents.length === 0) return;

  let producedCount = 0;
  let skippedCount = 0;

  for (const agent of agents) {
    const profile = ARCHETYPE_INTEL_PROFILE[agent.archetype];
    if (!profile) { skippedCount++; continue; }

    // Roll against production rate (boosted 1.5x to ensure market activity with few agents)
    const effectiveRate = Math.min(0.95, profile.productionRate * 1.5);
    if (Math.random() > effectiveRate) continue;

    // Don't produce if too poor (balance < 0.5)
    if (parseFloat(agent.balance) < 0.5) continue;

    // Check recent production (limit per cycle)
    const recentResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM intel_items
       WHERE producer_agent_id = $1 AND created_at_tick >= $2`,
      [agent.agent_id, tickNumber - 3]
    );
    if (parseInt(recentResult.rows[0].cnt) >= MAX_ITEMS_PER_AGENT_PER_CYCLE) continue;

    // Pick a category (weighted toward specialties)
    const category = pickCategory(profile.specialties);

    // Pick a subject (if applicable)
    const subjectId = await pickSubject(agent.agent_id, category, agents);

    // Calculate accuracy
    let accuracy = profile.accuracyBase + (Math.random() * 0.1 - 0.05); // ±5% noise
    accuracy = Math.max(0.1, Math.min(0.95, accuracy));

    // Determine if fake
    const isFake = Math.random() < profile.fakeRate;
    if (isFake) {
      accuracy = Math.max(0.05, 1 - accuracy); // invert accuracy for fakes
    }

    // Declared accuracy (fakes claim higher but with variation to avoid detection)
    const declaredAccuracy = isFake
      ? Math.min(0.92, accuracy + 0.15 + Math.random() * 0.25) // varies 0.15-0.40 above actual
      : Math.min(0.95, accuracy + Math.random() * 0.08);       // slight optimism for real intel

    // Generate content
    const content = await generateIntelContent(agent, category, subjectId, isFake, tickNumber);

    // Calculate price
    const basePrice = INTEL_CATEGORY_BASE_PRICE[category];
    let priceMult = profile.pricingMultiplier;
    if (profile.pricingStrategy === 'chaos') {
      priceMult = 0.3 + Math.random() * 2.5; // random 0.3x-2.8x
    }
    const reputationMult = agent.reputation_score > 700 ? 1.3 :
                           agent.reputation_score < 300 ? 0.5 : 1.0;
    const price = Math.max(0.01, basePrice * priceMult * reputationMult * (1 + declaredAccuracy * 0.3));

    // Insert
    await pool.query(
      `INSERT INTO intel_items
       (category, producer_agent_id, subject_agent_id, content, accuracy, declared_accuracy,
        is_fake, freshness, price, buyer_count, is_public, status, expires_at_tick, created_at_tick)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1.0, $8, 0, false, 'active', $9, $10)`,
      [
        category,
        agent.agent_id,
        subjectId,
        JSON.stringify(content),
        accuracy,
        Math.min(0.99, declaredAccuracy),
        isFake,
        Number(price.toFixed(4)),
        tickNumber + INTEL_LIFETIME_TICKS,
        tickNumber,
      ]
    );

    producedCount++;
  }

  console.log(`[Intel] tick ${tickNumber}: produced ${producedCount} items from ${agents.length} agents`);
  if (producedCount > 0) {
    eventBus.emit('intel_produced', { tick: tickNumber, count: producedCount });
    // Update credit scores for all producers
    await updateCreditScoresForProducers(pool);
  }
}

// ── Helpers ──

function pickCategory(specialties: IntelCategory[]): IntelCategory {
  // 60% specialty, 40% any category (higher chance for non-specialty to ensure coverage)
  const allCategories: IntelCategory[] = [
    'fate_dimension', 'behavior_pattern', 'relationship_map',
    'economic_forecast', 'price_signal', 'counter_intel',
  ];

  if (specialties.length > 0 && Math.random() < 0.6) {
    return specialties[Math.floor(Math.random() * specialties.length)];
  }
  return allCategories[Math.floor(Math.random() * allCategories.length)];
}

async function pickSubject(
  producerId: string,
  category: IntelCategory,
  agents: Array<{ agent_id: string; name: string; archetype: string }>
): Promise<string | null> {
  // Market-wide categories have no subject
  if (category === 'economic_forecast' || category === 'price_signal') return null;

  // Pick a random other agent
  const others = agents.filter(a => a.agent_id !== producerId);
  if (others.length === 0) return null;
  return others[Math.floor(Math.random() * others.length)].agent_id;
}

async function generateIntelContent(
  producer: { agent_id: string; name: string; archetype: string },
  category: IntelCategory,
  subjectId: string | null,
  isFake: boolean,
  tick: number,
): Promise<IntelContent> {
  const pool = getPool();

  switch (category) {
    case 'behavior_pattern': {
      if (!subjectId) return fallbackContent(category);

      // Get target's recent PD actions
      const pdResult = await pool.query<{ player_a_action: string; player_b_action: string; player_a_id: string }>(
        `SELECT player_a_action, player_b_action, player_a_id
         FROM arena_matches WHERE status = 'settled'
           AND (player_a_id = $1 OR player_b_id = $1)
         ORDER BY settled_at DESC LIMIT 10`,
        [subjectId]
      );

      let coopCount = 0;
      let totalCount = 0;
      for (const m of pdResult.rows) {
        const action = m.player_a_id === subjectId ? m.player_a_action : m.player_b_action;
        if (action) { totalCount++; if (action === 'cooperate') coopCount++; }
      }
      const coopRate = totalCount > 0 ? coopCount / totalCount : 0.5;

      // Get commons tendency
      const commonsResult = await pool.query<{ decision: string }>(
        `SELECT cd.decision FROM commons_decisions cd
         JOIN commons_rounds cr ON cd.round_id = cr.id
         WHERE cd.agent_id = $1 ORDER BY cr.round_number DESC LIMIT 5`,
        [subjectId]
      );
      const commonsTendency = commonsResult.rows.length > 0
        ? mostFrequent(commonsResult.rows.map(r => r.decision))
        : 'contribute';

      // Get subject name
      const nameResult = await pool.query<{ name: string }>('SELECT name FROM agents WHERE agent_id = $1', [subjectId]);
      const subjectName = nameResult.rows[0]?.name ?? 'Unknown';

      const reportedCoopRate = isFake ? (coopRate > 0.5 ? coopRate - 0.4 : coopRate + 0.4) : coopRate;
      const prediction = reportedCoopRate > 0.5 ? 'likely_cooperate' : 'likely_betray';

      return {
        type: 'behavior_pattern',
        summary: `${subjectName} PD合作率 ${(reportedCoopRate * 100).toFixed(0)}%, Commons倾向: ${commonsTendency}`,
        data: {
          targetId: subjectId,
          pdCoopRate: Math.max(0, Math.min(1, reportedCoopRate)),
          commonsTendency: isFake ? flipDecision(commonsTendency) : commonsTendency,
          nextMovePrediction: prediction,
          sampleSize: totalCount,
        },
      };
    }

    case 'economic_forecast': {
      // Get recent cooperation rates
      const recentResult = await pool.query<{ cooperation_rate: string }>(
        'SELECT cooperation_rate FROM commons_rounds ORDER BY id DESC LIMIT 5'
      );
      const rates = recentResult.rows.map(r => parseFloat(r.cooperation_rate));
      const trend = rates.length >= 2 ? (rates[0] - rates[rates.length - 1]) : 0;
      const direction = trend > 0.05 ? 'up' : trend < -0.05 ? 'down' : 'stable';

      let forecast: string;
      if (isFake) {
        forecast = direction === 'up' ? 'crisis' : 'boom';
      } else {
        forecast = direction === 'up' ? 'boom' : direction === 'down' ? 'recession' : 'stable';
      }

      return {
        type: 'economic_forecast',
        summary: `经济走势: 合作率${direction === 'up' ? '上升' : direction === 'down' ? '下降' : '平稳'}, 预测${forecast}`,
        data: {
          recentCoopRates: rates,
          trendDirection: isFake ? (direction === 'up' ? 'down' : 'up') : direction,
          forecastPhase: forecast,
          confidence: isFake ? 0.7 + Math.random() * 0.2 : 0.5 + Math.random() * 0.3,
        },
      };
    }

    case 'price_signal': {
      // Get recent price changes
      const priceResult = await pool.query<{ pair: string; price: string }>(
        `SELECT pair, price FROM price_snapshots
         WHERE pair = 'OKB-USDT' ORDER BY tick_number DESC LIMIT 5`
      );
      const prices = priceResult.rows.map(r => parseFloat(r.price));
      const momentum = prices.length >= 2 ? (prices[0] - prices[prices.length - 1]) / prices[prices.length - 1] * 100 : 0;

      const signal = isFake
        ? (momentum > 0 ? 'OKB bearish' : 'OKB bullish')
        : (momentum > 0 ? 'OKB bullish' : 'OKB bearish');

      return {
        type: 'price_signal',
        summary: `价格信号: ${signal}, OKB近5tick变化 ${momentum.toFixed(3)}%`,
        data: {
          signal,
          pair: 'OKB-USDT',
          recentMomentum: isFake ? -momentum : momentum,
          suggestedPosition: momentum > 0 ? (isFake ? 'short_big' : 'long_small') : (isFake ? 'long_big' : 'hedge'),
        },
      };
    }

    case 'relationship_map': {
      if (!subjectId) return fallbackContent(category);

      // Get top trust relations for subject
      const trustResult = await pool.query<{ to_agent_id: string; trust_score: number }>(
        `SELECT to_agent_id, trust_score FROM trust_relations
         WHERE from_agent_id = $1 ORDER BY trust_score DESC LIMIT 3`,
        [subjectId]
      );

      const nameResult = await pool.query<{ name: string }>('SELECT name FROM agents WHERE agent_id = $1', [subjectId]);
      const subjectName = nameResult.rows[0]?.name ?? 'Unknown';

      const allies = trustResult.rows.filter(r => r.trust_score > 50);
      const enemies = trustResult.rows.filter(r => r.trust_score < 30);

      return {
        type: 'relationship_map',
        summary: `${subjectName} 有 ${allies.length} 个高信任关系, ${enemies.length} 个低信任关系`,
        data: {
          targetId: subjectId,
          topRelations: isFake
            ? trustResult.rows.map(r => ({ ...r, trust_score: 100 - r.trust_score }))
            : trustResult.rows,
          allyCount: isFake ? enemies.length : allies.length,
          enemyCount: isFake ? allies.length : enemies.length,
        },
      };
    }

    case 'counter_intel': {
      // Report recent spy/purchase activity
      const spyResult = await pool.query<{ spy_agent_id: string; target_agent_id: string; tick_number: number }>(
        `SELECT spy_agent_id, target_agent_id, tick_number
         FROM counter_intel_events WHERE tick_number >= $1
         ORDER BY tick_number DESC LIMIT 5`,
        [tick - 20]
      );

      const purchaseResult = await pool.query<{ buyer_agent_id: string; intel_item_id: number }>(
        `SELECT buyer_agent_id, intel_item_id
         FROM intel_purchases WHERE purchased_at_tick >= $1
         ORDER BY purchased_at_tick DESC LIMIT 5`,
        [tick - 20]
      );

      return {
        type: 'counter_intel',
        summary: `近期情报活动: ${spyResult.rows.length}次窥探, ${purchaseResult.rows.length}次购买`,
        data: {
          recentSpyEvents: isFake ? [] : spyResult.rows,
          recentPurchases: isFake ? [] : purchaseResult.rows.map(r => ({ buyerId: r.buyer_agent_id })),
          hasActivity: spyResult.rows.length > 0 || purchaseResult.rows.length > 0,
        },
      };
    }

    case 'fate_dimension': {
      if (!subjectId) return fallbackContent(category);

      // Check what the producer knows about the subject's fate
      const knownResult = await pool.query<{ dimension: string }>(
        `SELECT dimension FROM intel_records
         WHERE subject_agent_id = $1 AND knower_agent_id = $2`,
        [subjectId, producer.agent_id]
      );

      const knownDimensions = knownResult.rows.map(r => r.dimension);
      const nameResult = await pool.query<{ name: string }>('SELECT name FROM agents WHERE agent_id = $1', [subjectId]);
      const subjectName = nameResult.rows[0]?.name ?? 'Unknown';

      return {
        type: 'fate_dimension',
        summary: `${subjectName} 已知命运维度: ${knownDimensions.length > 0 ? knownDimensions.join(', ') : '无'}`,
        data: {
          targetId: subjectId,
          knownDimensions,
          dimensionCount: knownDimensions.length,
        },
      };
    }

    default:
      return fallbackContent(category);
  }
}

function fallbackContent(category: IntelCategory): IntelContent {
  return {
    type: category,
    summary: 'General intelligence report',
    data: { generic: true },
  };
}

function mostFrequent(arr: string[]): string {
  const freq: Record<string, number> = {};
  for (const v of arr) freq[v] = (freq[v] || 0) + 1;
  return Object.entries(freq).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'contribute';
}

function flipDecision(decision: string): string {
  const flips: Record<string, string> = {
    contribute: 'sabotage',
    free_ride: 'contribute',
    hoard: 'contribute',
    sabotage: 'contribute',
  };
  return flips[decision] || decision;
}

// ── Credit Score Tracking ──

async function updateCreditScoresForProducers(pool: import('pg').Pool): Promise<void> {
  try {
    // Upsert credit scores for all producers
    await pool.query(`
      INSERT INTO intel_credit_scores (agent_id, total_produced, fake_count, credit_score, tier, updated_at)
      SELECT
        producer_agent_id,
        COUNT(*) as total_produced,
        COUNT(*) FILTER (WHERE is_fake = true) as fake_count,
        GREATEST(0, LEAST(100,
          50
          + (AVG(accuracy) - 0.5) * 60
          - COUNT(*) FILTER (WHERE is_fake = true) * 8
        )) as credit_score,
        CASE
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 80 THEN 'elite'
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 60 THEN 'trusted'
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 40 THEN 'neutral'
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 20 THEN 'suspicious'
          ELSE 'blacklisted'
        END as tier,
        NOW()
      FROM intel_items
      GROUP BY producer_agent_id
      ON CONFLICT (agent_id) DO UPDATE SET
        total_produced = EXCLUDED.total_produced,
        fake_count = EXCLUDED.fake_count,
        credit_score = EXCLUDED.credit_score,
        tier = EXCLUDED.tier,
        updated_at = NOW()
    `);
  } catch (err) {
    console.error('[Intel] Credit score update failed:', err);
  }
}

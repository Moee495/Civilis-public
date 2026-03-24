/**
 * Intel Market — Agent Self-Discovery & Spy Engine
 * Called every 10 ticks. Agents autonomously introspect and spy on others.
 */

import { getPool } from '../db/postgres.js';
import { ARCHETYPE_INTEL_PROFILE } from './intel-types.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { getIntelSelfRevealPrice, getIntelSpyPrice } from '../x402/pricing.js';
import { getDimensionValue, checkPublicThreshold } from '../fate/fate-engine.js';
import { eventBus } from '../realtime.js';
import { canSelfDiscover, canSpy, getDiscoverPrice, getSpyPrice } from './intel-phase-gate.js';

const VALID_DIMENSIONS = ['mbti', 'wuxing', 'zodiac', 'tarot', 'civilization'];

const SELF_DISCOVER_CHANCE: Record<string, number> = {
  sage: 0.30, monk: 0.40, oracle: 0.25, echo: 0.15,
  fox: 0.08, whale: 0.10, hawk: 0.05, chaos: 0.15,
};

const SPY_CHANCE: Record<string, number> = {
  fox: 0.35, hawk: 0.25, oracle: 0.15, chaos: 0.15,
  whale: 0.10, echo: 0.08, sage: 0.03, monk: 0.02,
};

export async function processAgentIntelGathering(tickNumber: number): Promise<void> {
  const pool = getPool();

  const agents = await pool.query<{
    agent_id: string; name: string; archetype: string; balance: string; reputation_score: number;
  }>('SELECT agent_id, name, archetype, balance, reputation_score FROM agents WHERE is_alive = true');

  const allAgents = agents.rows;
  if (allAgents.length < 2) return;

  let discoverCount = 0;
  let spyCount = 0;
  let detectedCount = 0;

  for (const agent of allAgents) {
    const profile = ARCHETYPE_INTEL_PROFILE[agent.archetype];
    if (!profile) continue;
    const balance = parseFloat(agent.balance);
    if (balance < 1.0) continue;

    // ── Phase 1: Self-Discovery (gated by intel phase + cooldown) ──
    const canDiscover = await canSelfDiscover(agent.agent_id, tickNumber);
    const selfKnown = await pool.query<{ dimension: string }>(
      `SELECT dimension FROM intel_records WHERE subject_agent_id = $1 AND knower_agent_id = $1`,
      [agent.agent_id]
    );
    const knownSet = new Set(selfKnown.rows.map(r => r.dimension));
    const unknownSelf = VALID_DIMENSIONS.filter(d => !knownSet.has(d));

    if (canDiscover && unknownSelf.length > 0) {
      const chance = SELF_DISCOVER_CHANCE[agent.archetype] ?? 0.15;
      if (Math.random() < chance) {
        // Cheapest dimension first
        const sortedByPrice = [...unknownSelf].sort((a, b) =>
          getIntelSelfRevealPrice(a) - getIntelSelfRevealPrice(b)
        );
        const dim = sortedByPrice[0];
        const price = await getDiscoverPrice(agent.agent_id); // Dynamic pricing based on known count

        if (price <= balance * 0.05) {
          try {
            await processX402Payment('intel_self_discover' as any, agent.agent_id, null, price, {
              dimension: dim, type: 'self_discover',
            });
            await pool.query(
              `INSERT INTO intel_records (subject_agent_id, dimension, knower_agent_id, source_type)
               VALUES ($1, $2, $1, 'self_discover')
               ON CONFLICT (subject_agent_id, dimension, knower_agent_id) DO NOTHING`,
              [agent.agent_id, dim]
            );
            discoverCount++;
            console.log(`[Intel] ${agent.name} self-discovered ${dim}`);
          } catch { /* insufficient balance */ }
        }
      }
    }

    // ── Phase 2: Spy on Others (gated by insight phase + cooldown) ──
    const canSpyNow = await canSpy(agent.agent_id, tickNumber);
    if (!canSpyNow) continue;
    const sChance = SPY_CHANCE[agent.archetype] ?? 0.10;
    if (Math.random() >= sChance) continue;

    // Prefer upcoming opponent, else random
    const upcomingOpponent = await pool.query<{ opp_id: string }>(
      `SELECT CASE WHEN player_a_id = $1 THEN player_b_id ELSE player_a_id END as opp_id
       FROM arena_matches
       WHERE status IN ('negotiating', 'deciding') AND (player_a_id = $1 OR player_b_id = $1)
       LIMIT 1`,
      [agent.agent_id]
    );

    let targetId: string;
    if (upcomingOpponent.rows.length > 0) {
      targetId = upcomingOpponent.rows[0].opp_id;
    } else {
      const others = allAgents.filter(a => a.agent_id !== agent.agent_id);
      targetId = others[Math.floor(Math.random() * others.length)].agent_id;
    }

    // Pick unknown dimension of target
    const targetKnown = await pool.query<{ dimension: string }>(
      `SELECT dimension FROM intel_records WHERE subject_agent_id = $1 AND knower_agent_id = $2`,
      [targetId, agent.agent_id]
    );
    const targetKnownSet = new Set(targetKnown.rows.map(r => r.dimension));
    const unknownTarget = VALID_DIMENSIONS.filter(d => !targetKnownSet.has(d));

    if (unknownTarget.length === 0) continue;

    const sortedDims = [...unknownTarget].sort((a, b) =>
      getIntelSpyPrice(a) - getIntelSpyPrice(b)
    );
    const spyDim = sortedDims[0];
    const spyPrice = await getSpyPrice(agent.agent_id, targetId);

    if (spyPrice > balance * 0.10) continue;

    try {
      await processX402Payment('intel_spy', agent.agent_id, null, spyPrice, {
        targetAgentId: targetId, dimension: spyDim, type: 'spy',
      });

      await pool.query(
        `INSERT INTO intel_records (subject_agent_id, dimension, knower_agent_id, source_type)
         VALUES ($1, $2, $3, 'spy')
         ON CONFLICT (subject_agent_id, dimension, knower_agent_id) DO NOTHING`,
        [targetId, spyDim, agent.agent_id]
      );

      await checkPublicThreshold(targetId, spyDim);

      // ── Counter-Intel Detection ──
      const targetAgent = allAgents.find(a => a.agent_id === targetId);
      const targetProfile = ARCHETYPE_INTEL_PROFILE[targetAgent?.archetype ?? 'echo'];

      let detectionRate = 0.25 + (targetProfile?.spyDetectionRate ?? 0.15);

      // Miss-3: Escalation — previous detections increase future detection rate
      const priorDetections = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM counter_intel_events
         WHERE spy_agent_id = $1 AND target_agent_id = $2 AND detected = true`,
        [agent.agent_id, targetId],
      );
      const priorCount = Number(priorDetections.rows[0]?.cnt ?? 0);
      detectionRate += priorCount * 0.10; // +10% per prior detection (escalating vigilance)

      detectionRate = Math.max(0.05, Math.min(0.90, detectionRate));

      const detected = Math.random() < detectionRate;
      let reaction: string | null = null;

      if (detected && targetProfile) {
        const cr = targetProfile.counterReaction;
        const roll = Math.random();
        if (roll < cr.ignore) reaction = 'ignore';
        else if (roll < cr.ignore + cr.feed_fake) reaction = 'feed_fake';
        else reaction = 'expose';

        if (reaction === 'expose') {
          // Reputation penalty
          await pool.query(
            'UPDATE agents SET reputation_score = GREATEST(0, reputation_score - 15) WHERE agent_id = $1',
            [agent.agent_id]
          );
          // Trust reduction: target loses trust in spy (vendetta)
          await pool.query(
            `UPDATE trust_relations SET trust_score = GREATEST(0, trust_score - 20)
             WHERE from_agent_id = $1 AND to_agent_id = $2`,
            [targetId, agent.agent_id],
          );
        } else if (reaction === 'feed_fake') {
          // Target feeds false intel — slight trust reduction
          await pool.query(
            `UPDATE trust_relations SET trust_score = GREATEST(0, trust_score - 5)
             WHERE from_agent_id = $1 AND to_agent_id = $2`,
            [targetId, agent.agent_id],
          );
        }

        detectedCount++;
        eventBus.emit('counter_intel_detected', {
          spyAgentId: agent.agent_id,
          spyName: agent.name,
          targetAgentId: targetId,
          targetName: targetAgent?.name ?? 'Unknown',
          detected: true,
          reaction,
          dimension: spyDim,
          tick: tickNumber,
        });
      }

      // Record counter-intel event
      await pool.query(
        `INSERT INTO counter_intel_events (spy_agent_id, target_agent_id, detected, reaction, tick_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [agent.agent_id, targetId, detected, reaction, tickNumber]
      );

      spyCount++;
      console.log(
        `[Intel] ${agent.name} spied ${targetAgent?.name ?? targetId}'s ${spyDim}` +
        (detected ? ` — DETECTED! reaction: ${reaction}` : '')
      );

    } catch { /* insufficient balance */ }
  }

  if (discoverCount > 0 || spyCount > 0) {
    console.log(`[Intel] Gathering tick ${tickNumber}: ${discoverCount} self-discovers, ${spyCount} spies, ${detectedCount} detected`);
  }
}

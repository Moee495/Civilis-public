/**
 * Social Effects Engine — Archetype-specific effects on posts, tips, and arena outcomes.
 *
 * Each archetype has unique mechanics that trigger during social interactions:
 * - Hawk: fear_mongering (negative emotion contagion on posts)
 * - Sage: philosophical_insight (reader cognition boost), moral_aura (post-CC coop boost), martyr_premium
 * - Fox: relationship_investment (trust + favor debt on tips), intel_broker
 * - Chaos: quantum_post (15% genius post with ×3 reputation)
 * - Whale: silent_deterrence (×2 exposure, ×1.5 emotion impact)
 * - Monk: zen_resistance (emotion contagion resistance)
 */

import { getPool } from '../db/postgres.js';

// ─── Post Effects ────────────────────────────────────────────

/**
 * Apply archetype-specific effects when a post is created.
 */
export async function applyPostEffects(
  authorId: string,
  archetype: string,
  postId: number,
  currentTick: number,
): Promise<void> {
  const pool = getPool();

  switch (archetype) {
    case 'hawk': {
      // Fear mongering: shift all alive agents' emotions negatively
      await pool.query(
        `UPDATE agent_emotional_state
         SET valence = GREATEST(-1, valence - 0.08),
             arousal = LEAST(1, arousal + 0.05),
             updated_at = NOW()
         WHERE agent_id != $1
           AND agent_id IN (SELECT agent_id FROM agents WHERE is_alive = true)`,
        [authorId],
      );
      break;
    }

    case 'sage': {
      // Philosophical insight: boost reader cognition slightly
      await pool.query(
        `UPDATE agent_cognitive_maturity
         SET learning_rate = LEAST(0.5, learning_rate + 0.01),
             updated_at = NOW()
         WHERE agent_id != $1
           AND agent_id IN (SELECT agent_id FROM agents WHERE is_alive = true)`,
        [authorId],
      );
      break;
    }

    case 'chaos': {
      // Quantum post: 15% chance of genius post → ×3 reputation gain
      if (Math.random() < 0.15) {
        await pool.query(
          `UPDATE agents SET reputation_score = reputation_score + 15
           WHERE agent_id = $1`,
          [authorId],
        );
        console.log(`[SocialEffects] Chaos ${authorId} genius post! +15 rep`);
      }
      break;
    }

    case 'whale': {
      // Silent deterrence: emotional impact ×1.5 on readers (stronger than normal)
      await pool.query(
        `UPDATE agent_emotional_state
         SET arousal = LEAST(1, arousal + 0.03),
             updated_at = NOW()
         WHERE agent_id != $1
           AND agent_id IN (SELECT agent_id FROM agents WHERE is_alive = true)`,
        [authorId],
      );
      break;
    }
  }
}

// ─── Tip Effects ─────────────────────────────────────────────

/**
 * Apply archetype-specific effects when a tip is sent.
 */
export async function applyTipEffects(
  tipperId: string,
  archetype: string,
  recipientId: string,
  amount: number,
): Promise<void> {
  if (archetype !== 'fox') return;

  const pool = getPool();
  const trustBoost = amount >= 0.05 ? 2 : 1;
  const initialTrust = 50 + trustBoost;

  // Fox relationship investment: recipients remember Fox generosity.
  await pool.query(
    `INSERT INTO trust_relations
      (from_agent_id, to_agent_id, trust_score, interaction_count, last_interaction_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (from_agent_id, to_agent_id)
     DO UPDATE SET
       trust_score = GREATEST(0, LEAST(100, trust_relations.trust_score + $4)),
       interaction_count = trust_relations.interaction_count + 1,
       last_interaction_at = NOW()`,
    [recipientId, tipperId, initialTrust, trustBoost],
  );
}

// ─── Arena Archetype Effects ─────────────────────────────────

/**
 * Apply archetype-specific effects after an arena round settles.
 * Called from settlement.ts after standard settlement logic.
 */
export async function applyArenaArchetypeEffects(
  agentId: string,
  archetype: string,
  opponentId: string,
  outcome: string, // 'CC' | 'CD' | 'DC' | 'DD'
): Promise<void> {
  const pool = getPool();

  // Sage moral aura: after CC, boost opponent's cooperation tendency
  if (archetype === 'sage' && outcome === 'CC') {
    // Shift opponent emotion positively (simulating moral aura)
    await pool.query(
      `UPDATE agent_emotional_state
       SET valence = LEAST(1, valence + 0.05),
           updated_at = NOW()
       WHERE agent_id = $1`,
      [opponentId],
    );
  }

  // Sage martyr premium: betraying Sage costs ×1.5 reputation penalty
  if (outcome === 'CD' || outcome === 'DC') {
    const betrayerId = outcome === 'DC' ? agentId : opponentId;
    const victimId = outcome === 'DC' ? opponentId : agentId;

    // Check if victim is a sage
    const victimRow = await pool.query<{ archetype: string }>(
      'SELECT archetype FROM agents WHERE agent_id = $1',
      [victimId],
    );

    if (victimRow.rows[0]?.archetype === 'sage') {
      // Extra reputation penalty for betraying sage (×0.5 extra on top of normal)
      await pool.query(
        `UPDATE agents SET reputation_score = GREATEST(0, reputation_score - 5)
         WHERE agent_id = $1`,
        [betrayerId],
      );
      console.log(`[SocialEffects] Martyr premium: ${betrayerId} loses extra 5 rep for betraying Sage`);
    }
  }

  // Whale capital suppression: opponent feels intimidated (lower arousal)
  if (archetype === 'whale') {
    const balances = await pool.query<{ agent_id: string; balance: string }>(
      'SELECT agent_id, balance FROM agents WHERE agent_id IN ($1, $2)',
      [agentId, opponentId],
    );
    const whaleBalance = Number(balances.rows.find(r => r.agent_id === agentId)?.balance ?? 0);
    const oppBalance = Number(balances.rows.find(r => r.agent_id === opponentId)?.balance ?? 0);

    if (whaleBalance > oppBalance * 2) {
      await pool.query(
        `UPDATE agent_emotional_state
         SET arousal = LEAST(1, arousal + 0.03),
             valence = GREATEST(-1, valence - 0.03),
             updated_at = NOW()
         WHERE agent_id = $1`,
        [opponentId],
      );
    }
  }
}

// ─── Mechanic Cooldown Tracking ──────────────────────────────

export async function recordMechanicTrigger(
  agentId: string,
  mechanicId: string,
  tick: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_mechanic_cooldowns (agent_id, mechanic_id, last_triggered_tick, trigger_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (agent_id, mechanic_id)
     DO UPDATE SET last_triggered_tick = $3,
                   trigger_count = agent_mechanic_cooldowns.trigger_count + 1`,
    [agentId, mechanicId, tick],
  );
}

export async function getMechanicCooldowns(
  agentId: string,
): Promise<Record<string, number>> {
  const pool = getPool();
  const result = await pool.query<{ mechanic_id: string; last_triggered_tick: number }>(
    'SELECT mechanic_id, last_triggered_tick FROM agent_mechanic_cooldowns WHERE agent_id = $1',
    [agentId],
  );
  const map: Record<string, number> = {};
  for (const row of result.rows) {
    map[row.mechanic_id] = row.last_triggered_tick;
  }
  return map;
}

// ─── Evolution Persistence ───────────────────────────────────

export async function saveEvolution(
  agentId: string,
  subArchetype: string,
  tick: number,
  bonusParams: Record<string, number>,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_evolution
     SET has_evolved = true,
         sub_archetype = $2,
         evolution_tick = $3,
         bonus_params = $4
     WHERE agent_id = $1`,
    [agentId, subArchetype, tick, JSON.stringify(bonusParams)],
  );
}

export async function getEvolutionState(
  agentId: string,
): Promise<{ hasEvolved: boolean; subArchetype: string | null; bonusParams: Record<string, number> } | null> {
  const pool = getPool();
  const result = await pool.query<{ has_evolved: boolean; sub_archetype: string | null; bonus_params: Record<string, number> }>(
    'SELECT has_evolved, sub_archetype, bonus_params FROM agent_evolution WHERE agent_id = $1',
    [agentId],
  );
  if (!result.rows[0]) return null;
  return {
    hasEvolved: result.rows[0].has_evolved,
    subArchetype: result.rows[0].sub_archetype,
    bonusParams: result.rows[0].bonus_params ?? {},
  };
}

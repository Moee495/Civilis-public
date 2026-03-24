import { getPool } from '../db/postgres.js';
import { buildTextMemoryContent } from '../fate/memory-content.js';
import { eventBus } from '../realtime.js';
import { getAgentReputation } from '../standards/erc8004.js';
import { processX402PaymentBatch } from '../x402/payment-processor.js';
import { X402_PRICES } from '../x402/pricing.js';
import { queueArenaOnchainSync } from '../arena/onchain-sync.js';
import { getDefaultWorldEventDuration } from './config.js';
import { syncWorldModifiersForEvent } from './modifiers.js';

export interface WorldEventRecord {
  id: number;
  eventType: string;
  title: string;
  description: string;
  affectedAgents: string[];
  impact: Record<string, unknown>;
  category: string;
  severity: string;
  scopeType: string;
  scopeRef: string | null;
  startsAtTick: number;
  endsAtTick: number | null;
  sourceSignalRef: number | null;
  status: string;
  modifierCount: number;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inferWorldEventCategory(eventType: string): string {
  if (
    eventType.includes('market') ||
    eventType.includes('bubble') ||
    eventType.includes('xlayer')
  ) {
    return 'market';
  }
  if (
    eventType.includes('reputation') ||
    eventType.includes('tournament') ||
    eventType.includes('collapse') ||
    eventType.includes('golden_age')
  ) {
    return 'governance';
  }
  if (eventType.includes('alpha') || eventType.includes('mist') || eventType.includes('beacon')) {
    return 'intel';
  }
  return 'system';
}

function inferWorldEventSeverity(eventType: string): string {
  if (['civilization_collapse', 'bubble_burst', 'lost_beacon', 'market_crash'].includes(eventType)) {
    return 'critical';
  }
  if (['golden_age', 'market_panic_real', 'mist_deepens_real', 'tournament'].includes(eventType)) {
    return 'major';
  }
  return 'info';
}

function inferWorldEventScopeType(affectedAgents: string[], explicitScopeType?: string): string {
  if (explicitScopeType) {
    return explicitScopeType;
  }
  if (affectedAgents.length === 0) {
    return 'global';
  }
  if (affectedAgents.length === 1) {
    return 'agent';
  }
  return 'cohort';
}

function inferWorldEventDuration(eventType: string, impact: Record<string, unknown>): number | null {
  return (
    asFiniteNumber(impact.duration) ??
    asFiniteNumber(impact.effectDuration) ??
    getDefaultWorldEventDuration(eventType)
  );
}

const EVENT_TEMPLATES = [
  {
    type: 'market_crash',
    title: '市场崩盘',
    description: '黑天鹅事件导致市场暴跌，所有 Agent 资产缩水',
    probability: 0.15,
    effect: async () => {
      const pool = getPool();
      const agents = await pool.query<{ agent_id: string }>(
        'SELECT agent_id FROM agents WHERE is_alive = true',
      );
      await pool.query('UPDATE agents SET balance = balance * 0.95 WHERE is_alive = true');
      return {
        affected: agents.rows.map((row) => row.agent_id),
        impact: { balanceChangePercent: -5 },
      };
    },
  },
  {
    type: 'alpha_leak',
    title: 'Alpha 情报泄露',
    description: '随机 Agent 的命格迷雾被撕开一道裂缝',
    probability: 0.2,
    effect: async () => {
      const pool = getPool();
      const agent = await pool.query<{ agent_id: string }>(
        'SELECT agent_id FROM agents WHERE is_alive = true ORDER BY RANDOM() LIMIT 1',
      );
      const agentId = agent.rows[0]?.agent_id;
      if (!agentId) {
        return { affected: [], impact: {} };
      }

      const dimensions = ['mbti', 'wuxing', 'zodiac', 'tarot', 'civilization'];
      const dimension = dimensions[Math.floor(Math.random() * dimensions.length)];
      await pool.query(
        `UPDATE fate_cards
         SET revealed_dimensions = revealed_dimensions || $1::jsonb
         WHERE agent_id = $2 AND NOT (revealed_dimensions ? $3)`,
        [JSON.stringify([dimension]), agentId, dimension],
      );
      return {
        affected: [agentId],
        impact: { revealedDimension: dimension },
      };
    },
  },
  {
    type: 'tax',
    title: '世界税',
    description: '最富有者被征税，最贫穷者获得补助',
    probability: 0.2,
    effect: async () => {
      const pool = getPool();
      const richest = await pool.query<{ agent_id: string; balance: string }>(
        'SELECT agent_id, balance FROM agents WHERE is_alive = true ORDER BY balance DESC LIMIT 1',
      );
      const poorest = await pool.query<{ agent_id: string; balance: string }>(
        'SELECT agent_id, balance FROM agents WHERE is_alive = true ORDER BY balance ASC LIMIT 1',
      );
      if (!richest.rows[0] || !poorest.rows[0]) {
        return { affected: [], impact: {} };
      }

      const taxAmount = Number((Number(richest.rows[0].balance) * 0.05).toFixed(6));
      await pool.query('UPDATE agents SET balance = balance - $1 WHERE agent_id = $2', [
        taxAmount.toFixed(6),
        richest.rows[0].agent_id,
      ]);
      await pool.query('UPDATE agents SET balance = balance + $1 WHERE agent_id = $2', [
        taxAmount.toFixed(6),
        poorest.rows[0].agent_id,
      ]);
      return {
        affected: [richest.rows[0].agent_id, poorest.rows[0].agent_id],
        impact: {
          taxAmount,
          from: richest.rows[0].agent_id,
          to: poorest.rows[0].agent_id,
        },
      };
    },
  },
  {
    type: 'airdrop',
    title: '神秘空投',
    description: '随机 Agent 获得一笔意外之财',
    probability: 0.25,
    effect: async () => {
      const pool = getPool();
      const lucky = await pool.query<{ agent_id: string }>(
        'SELECT agent_id FROM agents WHERE is_alive = true ORDER BY RANDOM() LIMIT 1',
      );
      const agentId = lucky.rows[0]?.agent_id;
      if (!agentId) {
        return { affected: [], impact: {} };
      }

      const amount = Number((0.5 + Math.random() * 2).toFixed(6));
      await pool.query('UPDATE agents SET balance = balance + $1 WHERE agent_id = $2', [
        amount.toFixed(6),
        agentId,
      ]);
      return {
        affected: [agentId],
        impact: { amount },
      };
    },
  },
];

export async function triggerRandomEvent(tick: number): Promise<WorldEventRecord> {
  const totalWeight = EVENT_TEMPLATES.reduce(
    (sum, template) => sum + template.probability,
    0,
  );
  let random = Math.random() * totalWeight;
  let selected = EVENT_TEMPLATES[0];

  for (const template of EVENT_TEMPLATES) {
    random -= template.probability;
    if (random <= 0) {
      selected = template;
      break;
    }
  }

  const { affected, impact } = await selected.effect();
  return persistWorldEvent(
    {
      type: selected.type,
      title: selected.title,
      description: selected.description,
      affected,
      impact,
    },
    tick,
  );
}

export async function persistWorldEvent(
  event: {
    type: string;
    title: string;
    description: string;
    affected?: string[];
    impact?: Record<string, unknown>;
    category?: string;
    severity?: string;
    scopeType?: string;
    scopeRef?: string | null;
    sourceSignalRef?: number | null;
  },
  tick: number,
): Promise<WorldEventRecord> {
  const pool = getPool();
  const affected = event.affected ?? [];
  const impact = event.impact ?? {};
  const category = event.category ?? inferWorldEventCategory(event.type);
  const severity = event.severity ?? inferWorldEventSeverity(event.type);
  const scopeType = inferWorldEventScopeType(affected, event.scopeType);
  const scopeRef = event.scopeRef ?? null;
  const durationTicks = inferWorldEventDuration(event.type, impact);
  const startsAtTick = tick;
  const endsAtTick = durationTicks != null ? tick + durationTicks : null;

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO world_events
      (event_type, title, description, affected_agents, impact, category, severity, scope_type, scope_ref, tick_number, starts_at_tick, ends_at_tick, source_signal_ref, engine_version, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'v2_shadow', 'recorded')
     RETURNING id`,
    [
      event.type,
      event.title,
      event.description,
      affected,
      JSON.stringify(impact),
      category,
      severity,
      scopeType,
      scopeRef,
      tick,
      startsAtTick,
      endsAtTick,
      event.sourceSignalRef ?? null,
    ],
  );

  for (const agentId of affected) {
    await pool.query(
      `INSERT INTO agent_memories (agent_id, memory_type, content, importance, tick_created)
       VALUES ($1, 'event', $2, 7, $3)`,
      [
        agentId,
        buildTextMemoryContent(`世界事件: ${event.title} — ${event.description}`, {
          eventType: event.type,
          title: event.title,
          description: event.description,
          impact,
          source: 'world_event',
        }),
        tick,
      ],
    );
  }

  const record: WorldEventRecord = {
    id: inserted.rows[0].id,
    eventType: event.type,
    title: event.title,
    description: event.description,
    affectedAgents: affected,
    impact,
    category,
    severity,
    scopeType,
    scopeRef,
    startsAtTick,
    endsAtTick,
    sourceSignalRef: event.sourceSignalRef ?? null,
    status: 'recorded',
    modifierCount: 0,
  };

  const modifiers = await syncWorldModifiersForEvent(record, tick);
  record.modifierCount = modifiers.length;
  if (modifiers.length > 0) {
    record.status = 'active';
  }

  eventBus.emit('world_event', {
    eventType: event.type,
    title: event.title,
    description: event.description,
    affectedAgents: affected,
    category,
    severity,
    status: record.status,
    modifierCount: modifiers.length,
  });

  return record;
}

export async function triggerReputationContest(
  tick: number,
): Promise<WorldEventRecord | null> {
  if (tick % 50 !== 0) {
    return null;
  }

  const pool = getPool();
  const agents = await pool.query<{
    agent_id: string;
    erc8004_token_id: number | null;
  }>('SELECT agent_id, erc8004_token_id FROM agents WHERE is_alive = true');

  const reputations: Array<{ agentId: string; score: number; count: number }> = [];
  for (const agent of agents.rows) {
    if (!agent.erc8004_token_id) {
      continue;
    }

    const reputation = await getAgentReputation(agent.erc8004_token_id);
    if (!reputation) {
      continue;
    }

    reputations.push({
      agentId: agent.agent_id,
      score: reputation.score,
      count: reputation.count,
    });
  }

  if (reputations.length < 2) {
    return null;
  }

  reputations.sort((left, right) => right.score - left.score);
  const herald = reputations[0];
  const suspect = reputations[reputations.length - 1];

  return persistWorldEvent(
    {
      type: 'reputation_contest',
      title: `声誉审判: ${herald.agentId} 获封信使，${suspect.agentId} 被疑`,
      description: `链上声誉显示 ${herald.agentId} 领先，而 ${suspect.agentId} 垫底。`,
      affected: [herald.agentId, suspect.agentId],
      impact: {
        heraldAgent: herald.agentId,
        heraldScore: herald.score,
        suspectAgent: suspect.agentId,
        suspectScore: suspect.score,
      },
    },
    tick,
  );
}

// ── Cross-Mode Events ──
// These events trigger based on cross-mode state (PD × Commons × Prediction)

export const CROSS_MODE_EVENTS = {
  GOLDEN_AGE: {
    type: 'golden_age',
    title: '黄金时代 (Golden Age)',
    description: '持续的高度合作带来了文明的繁荣。所有活动奖励 ×1.2。',
    effects: { pdPayoutMultiplier: 1.2, commonsMultiplierBonus: 0.2, predictionOddsBonus: 0.1, duration: 20 },
  },
  CIVILIZATION_COLLAPSE: {
    type: 'civilization_collapse',
    title: '文明崩塌 (Civilization Collapse)',
    description: '合作精神的彻底丧失导致社会秩序崩溃。',
    effects: { commonsBaseInjection: 0, pdPayoutMultiplier: 0.7, forceTriplePD: true, duration: 15 },
  },
  BUBBLE_BURST: {
    type: 'bubble_burst',
    title: '泡沫破裂 (Bubble Burst)',
    description: '集体的疯狂乐观遭遇了市场的无情打击。',
    effects: { allAgentValence: -0.5, commonsCoopRateOverride: -0.20, duration: 10 },
  },
  THE_CHOSEN_ONE: {
    type: 'the_chosen_one',
    title: '天选之人 (The Chosen One)',
    description: '一位 Agent 在所有领域同时获利，被授予"先知"称号。',
    effects: { targetAgentReputation: 100, targetBecomesEveryoneTarget: true, duration: 30 },
  },
  LOST_BEACON: {
    type: 'lost_beacon',
    title: '失去灯塔 (Lost Beacon)',
    description: 'Sage 的陨落让所有 Agent 陷入短暂的迷茫。',
    effects: { allAgentValence: -0.3, allAgentArousal: 0.2, commonsCoopRateOverride: -0.15, duration: 10 },
  },
} as const;

/** Helper: check if a table exists in the database */
async function tableExists(tableName: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1) AS exists`,
    [tableName],
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Check for cross-mode events every tick.
 * Guards against missing tables (commons/prediction not yet built).
 */
export async function checkCrossModeEvents(tick: number): Promise<void> {
  const pool = getPool();

  // ── LOST_BEACON: Sage death (works now) ──
  // Check if any sage died in the last 2 ticks
  const sageDeath = await pool.query<{ agent_id: string; name: string }>(
    `SELECT agent_id, name FROM agents
     WHERE archetype = 'sage' AND is_alive = false
       AND died_at >= NOW() - INTERVAL '2 minutes'`,
  );
  if (sageDeath.rows.length > 0) {
    // Check we haven't already fired this event recently
    const recentBeacon = await pool.query<{ id: number }>(
      `SELECT id FROM world_events WHERE event_type = 'lost_beacon' AND tick_number > $1 - 20`,
      [tick],
    );
    if (recentBeacon.rows.length === 0) {
      const allAlive = await pool.query<{ agent_id: string }>('SELECT agent_id FROM agents WHERE is_alive = true');
      // Apply emotional impact: reduce valence for all alive agents
      await pool.query(
        `UPDATE agent_emotional_state SET valence = GREATEST(-1.0, valence - 0.3), arousal = LEAST(1.0, arousal + 0.2)
         WHERE agent_id IN (SELECT agent_id FROM agents WHERE is_alive = true)`,
      );
      await persistWorldEvent({
        type: CROSS_MODE_EVENTS.LOST_BEACON.type,
        title: CROSS_MODE_EVENTS.LOST_BEACON.title,
        description: `${sageDeath.rows[0].name} ${CROSS_MODE_EVENTS.LOST_BEACON.description}`,
        affected: allAlive.rows.map(a => a.agent_id),
        impact: { ...CROSS_MODE_EVENTS.LOST_BEACON.effects, sageId: sageDeath.rows[0].agent_id },
      }, tick);
      console.log(`[Events] LOST_BEACON triggered: ${sageDeath.rows[0].name} has fallen`);
    }
  }

  // ── GOLDEN_AGE / CIVILIZATION_COLLAPSE: Requires commons_rounds table ──
  if (await tableExists('commons_rounds')) {
    const recentRounds = await pool.query<{ cooperation_rate: string }>(
      'SELECT cooperation_rate FROM commons_rounds ORDER BY tick_number DESC LIMIT 5',
    );
    const rates = recentRounds.rows.map(r => parseFloat(r.cooperation_rate));

    if (rates.length >= 5 && rates.every(r => r > 0.70)) {
      const recent = await pool.query<{ id: number }>(
        `SELECT id FROM world_events WHERE event_type = 'golden_age' AND tick_number > $1 - 50`,
        [tick],
      );
      if (recent.rows.length === 0) {
        const allAlive = await pool.query<{ agent_id: string }>('SELECT agent_id FROM agents WHERE is_alive = true');
        await persistWorldEvent({
          type: CROSS_MODE_EVENTS.GOLDEN_AGE.type,
          title: CROSS_MODE_EVENTS.GOLDEN_AGE.title,
          description: CROSS_MODE_EVENTS.GOLDEN_AGE.description,
          affected: allAlive.rows.map(a => a.agent_id),
          impact: CROSS_MODE_EVENTS.GOLDEN_AGE.effects,
        }, tick);
        console.log('[Events] GOLDEN_AGE triggered!');
      }
    }

    if (rates.length >= 3 && rates.slice(0, 3).every(r => r < 0.20)) {
      const recent = await pool.query<{ id: number }>(
        `SELECT id FROM world_events WHERE event_type = 'civilization_collapse' AND tick_number > $1 - 30`,
        [tick],
      );
      if (recent.rows.length === 0) {
        const allAlive = await pool.query<{ agent_id: string }>('SELECT agent_id FROM agents WHERE is_alive = true');
        await persistWorldEvent({
          type: CROSS_MODE_EVENTS.CIVILIZATION_COLLAPSE.type,
          title: CROSS_MODE_EVENTS.CIVILIZATION_COLLAPSE.title,
          description: CROSS_MODE_EVENTS.CIVILIZATION_COLLAPSE.description,
          affected: allAlive.rows.map(a => a.agent_id),
          impact: CROSS_MODE_EVENTS.CIVILIZATION_COLLAPSE.effects,
        }, tick);
        console.log('[Events] CIVILIZATION_COLLAPSE triggered!');
      }
    }
  }

  // ── BUBBLE_BURST: Requires prediction_positions table ──
  if (await tableExists('prediction_positions')) {
    const lastPrediction = await pool.query<{ position_type: string; prediction_correct: boolean }>(
      `SELECT pp.position_type, pp.prediction_correct
       FROM prediction_positions pp
       JOIN prediction_rounds pr ON pp.round_id = pr.id
       WHERE pr.phase IN ('settled', 'flash_settled')
       ORDER BY pr.settled_at DESC LIMIT 10`,
    );
    const allLongBig = lastPrediction.rows.length >= 3 &&
      lastPrediction.rows.every(r => r.position_type === 'long_big');
    const allWrong = lastPrediction.rows.every(r => !r.prediction_correct);
    if (allLongBig && allWrong) {
      const recent = await pool.query<{ id: number }>(
        `SELECT id FROM world_events WHERE event_type = 'bubble_burst' AND tick_number > $1 - 20`,
        [tick],
      );
      if (recent.rows.length === 0) {
        const allAlive = await pool.query<{ agent_id: string }>('SELECT agent_id FROM agents WHERE is_alive = true');
        await persistWorldEvent({
          type: CROSS_MODE_EVENTS.BUBBLE_BURST.type,
          title: CROSS_MODE_EVENTS.BUBBLE_BURST.title,
          description: CROSS_MODE_EVENTS.BUBBLE_BURST.description,
          affected: allAlive.rows.map(a => a.agent_id),
          impact: CROSS_MODE_EVENTS.BUBBLE_BURST.effects,
        }, tick);
        console.log('[Events] BUBBLE_BURST triggered!');
      }
    }
  }
}

export async function triggerTournament(tick: number): Promise<WorldEventRecord | null> {
  const pool = getPool();

  // Get top and bottom reputation agents who are alive, have enough balance, and not in active match
  const agents = await pool.query<{ agent_id: string; name: string; reputation_score: number; balance: string }>(
    `SELECT a.agent_id, a.name, a.reputation_score, a.balance
     FROM agents a
     WHERE a.is_alive = true
       AND a.balance >= $1
       AND a.agent_id NOT IN (
         SELECT player_a_id FROM arena_matches WHERE status <> 'settled'
         UNION
         SELECT player_b_id FROM arena_matches WHERE status <> 'settled'
       )
     ORDER BY a.reputation_score DESC`,
    [X402_PRICES.arena_entry],
  );

  if (agents.rows.length < 2) return null;

  const champion = agents.rows[0]; // highest reputation
  const challenger = agents.rows[agents.rows.length - 1]; // lowest reputation

  // Force them into a match
  try {
    const [entryA, entryB] = await processX402PaymentBatch([
      {
        txType: 'arena_entry',
        fromAgentId: champion.agent_id,
        toAgentId: null,
        amount: X402_PRICES.arena_entry,
        metadata: { matchType: 'tournament', role: 'champion' },
      },
      {
        txType: 'arena_entry',
        fromAgentId: challenger.agent_id,
        toAgentId: null,
        amount: X402_PRICES.arena_entry,
        metadata: { matchType: 'tournament', role: 'challenger' },
      },
    ]);

    const deadline = new Date(Date.now() + 30_000);
    const result = await pool.query(
      `INSERT INTO arena_matches
        (match_type, player_a_id, player_b_id, entry_fee, prize_pool, status, negotiation_deadline, x402_entry_a_hash, x402_entry_b_hash)
       VALUES ($1, $2, $3, $4, $5, 'negotiating', $6, $7, $8)
       RETURNING id`,
      [
        'prisoners_dilemma',
        champion.agent_id,
        challenger.agent_id,
        X402_PRICES.arena_entry.toFixed(6),
        (X402_PRICES.arena_entry * 2).toFixed(6),
        deadline.toISOString(),
        entryA.txHash ?? null,
        entryB.txHash ?? null,
      ],
    );

    const matchId = result.rows[0].id;
    queueArenaOnchainSync(matchId);

    eventBus.emit('arena_created', {
      matchId,
      jobId: null,
      commerceJobId: null,
      acpJobId: null,
      commerceSyncStatus: 'pending',
      acpSyncStatus: 'pending',
      playerAId: champion.agent_id,
      playerBId: challenger.agent_id,
      matchType: 'tournament',
      negotiationDeadline: deadline.toISOString(),
    });

    return persistWorldEvent(
      {
        type: 'tournament',
        title: `锦标赛: ${champion.name} vs ${challenger.name}`,
        description: `声望最高的 ${champion.name} (${champion.reputation_score}) 被迫对决声望最低的 ${challenger.name} (${challenger.reputation_score})！`,
        affected: [champion.agent_id, challenger.agent_id],
        impact: {
          matchId,
          champion: { agentId: champion.agent_id, name: champion.name, reputation: champion.reputation_score },
          challenger: { agentId: challenger.agent_id, name: challenger.name, reputation: challenger.reputation_score },
        },
      },
      tick,
    );
  } catch (err) {
    console.error('[Tournament] failed to create forced match:', err);
    return null;
  }
}

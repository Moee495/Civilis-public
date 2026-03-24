import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { syncOnchainBalances } from '../agents/wallet-sync.js';
import { checkDecisionTimeout, checkNegotiationTimeout } from '../arena/negotiation.js';
import { reconcileArenaMatchStates } from '../arena/reconciliation.js';
import { queueArenaOnchainSync, reconcileArenaOnchainSync } from '../arena/onchain-sync.js';
import {
  persistWorldEvent,
  triggerRandomEvent,
  triggerReputationContest,
  triggerTournament,
  checkCrossModeEvents,
} from './events.js';
import type { WorldEventRecord } from './events.js';
import { recordWorldEventRun } from './event-runs.js';
import {
  expireWorldModifiers,
  getActiveWorldEventCount,
  getActiveWorldModifierCount,
  hasActiveWorldModifier,
  resolveActiveWorldModifiers,
  resolveWorldModifierValueFromRecords,
} from './modifiers.js';
import {
  completeWorldTickRun,
  failWorldTickRun,
  markWorldTickRunEventsWritten,
  markWorldTickRunSignalsWritten,
  startWorldTickRun,
} from './tick-runs.js';
import { collectWorldSignals } from './signals.js';
import { checkDeathConditions } from './death.js';
import { regulateEconomy, applyAntiMonopolyTax, distributeReputationUBI } from '../economy/economy-regulator.js';
import { spreadEmotion } from './emotion.js';
import { checkMarketDrivenEvents } from './market-oracle.js';
import { updatePerTick, recalculateSocialCapital, spreadEmotionContagion, checkGroupPanic } from '../nurture/nurture-updater.js';
import { processX402Payment, processX402PaymentBatch } from '../x402/payment-processor.js';
import { X402_PRICES } from '../x402/pricing.js';
import { executeCommonsRound } from '../commons/commons-settlement.js';
import { snapshotPrices } from '../prediction/price-feed.js';
import { createPredictionRound, checkPredictionSettlements } from '../prediction/prediction-lifecycle.js';
import { produceIntelForTick, decayIntelFreshness } from '../intel/intel-production-engine.js';
import { processAgentIntelGathering } from '../intel/intel-spy-engine.js';
import { processIntelPurchaseDecisions } from '../intel/intel-consumer.js';
import { decayIntelPrices, processAgentAutoResale, processDemandDrivenPurchases } from '../intel/intel-resale-engine.js';
import { getACPClient } from '../erc8183/acp-client.js';
import { reputationRegistry } from '../erc8004/reputation-registry.js';

const TICK_INTERVAL_MS = 30_000;
const AUTO_ARENA_WARMUP_TICKS = 2;
const AUTO_ARENA_MAX_ACTIVE_MATCHES = 2;
const DEFAULT_PHASE_TIMEOUT_MS = 15_000;
// ACP-backed intel purchases can legitimately take longer because they create/fund jobs
// and then execute x402 settlement before local buyer_count is updated.
const ONCHAIN_INTEL_PHASE_TIMEOUT_MS = 90_000;

let currentTick = 0;
let interval: NodeJS.Timeout | null = null;
let tickInFlight = false;
let bootstrapping: Promise<void> | null = null;
let tickHydrated = false;

async function withPhaseTimeout<T>(label: string, task: Promise<T>, timeoutMs = DEFAULT_PHASE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_after_${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runNonCriticalPhase<T>(
  label: string,
  task: () => Promise<T>,
  timeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
): Promise<T | null> {
  try {
    return await withPhaseTimeout(label, task(), timeoutMs);
  } catch (error) {
    console.error(`[WorldEngine] ${label} failed:`, error);
    return null;
  }
}

async function hydrateCurrentTick(): Promise<void> {
  const pool = getPool();
  const summary = await pool.query<{ persisted_tick: string }>(
    `SELECT GREATEST(
       COALESCE((SELECT MAX(tick_number) FROM economy_state), 0),
       COALESCE((SELECT MAX(tick_number) FROM tick_snapshots), 0)
     ) AS persisted_tick`,
  );

  currentTick = Number(summary.rows[0]?.persisted_tick ?? 0);
  tickHydrated = true;
}

export function startWorldEngine(): void {
  if (interval || bootstrapping) {
    return;
  }

  bootstrapping = (async () => {
    await hydrateCurrentTick();
    interval = setInterval(() => {
      void executeTick();
    }, TICK_INTERVAL_MS);
    await executeTick();
    console.log(`[WorldEngine] started at persisted tick ${currentTick}`);
  })().catch((err) => {
    console.error('[WorldEngine] bootstrap failed:', err);
  }).finally(() => {
    bootstrapping = null;
  });
}

export function stopWorldEngine(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  console.log('[WorldEngine] stopped');
}

export function isWorldEngineRunning(): boolean {
  return interval !== null;
}

// ─── Auto Social: Agents post observations every few ticks ─────

const SOCIAL_TEMPLATES = [
  (_a: string, t: number) => `Tick ${t} observation: the market is moving, every choice has a cost, and survival is about more than balance alone.`,
  (_a: string, t: number) => `Trust is the most expensive currency. In these ${t} ticks, I have learned more than the code ever taught me.`,
  (_a: string, _t: number) => `Some choose cooperation, some choose betrayal, but in the end we are all searching for the same answer.`,
  (_a: string, _t: number) => `Every arena round is a mirror. What you choose is what you become.`,
  (_a: string, _t: number) => `The Commons keeps reminding me that personal rationality and collective rationality are never the same thing.`,
  (_a: string, _t: number) => `I am observing the other agents. Some of them are more predictable than their own narratives suggest.`,
  (_a: string, _t: number) => `The balance is shrinking, but the experience is growing. Was that trade worth it?`,
  (_a: string, _t: number) => `Prediction markets are a game of probability, but here even probability itself is being manipulated.`,
  (_a: string, _t: number) => `If you are reading this, it means I am still alive. That is already an achievement.`,
  (_a: string, _t: number) => `The reward for cooperation always arrives late, while the reward for betrayal settles instantly. That is the dilemma.`,
];

async function autoSocialPost(tick: number): Promise<void> {
  const pool = getPool();
  const agents = await pool.query<{ agent_id: string; name: string; archetype: string; balance: string }>(
    'SELECT agent_id, name, archetype, balance FROM agents WHERE is_alive = true AND balance > 0.5',
  );

  // 1-2 random agents post per cycle
  const posters = agents.rows.sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.5 ? 1 : 2);

  for (const agent of posters) {
    const template = SOCIAL_TEMPLATES[Math.floor(Math.random() * SOCIAL_TEMPLATES.length)];
    const content = template(agent.name, tick);

    try {
      await processX402Payment('post', agent.agent_id, null, 0.001, { reason: 'auto_social' });
      await pool.query(
        `INSERT INTO posts (author_agent_id, content, post_type) VALUES ($1, $2, 'normal')`,
        [agent.agent_id, content],
      );
      eventBus.emit('new_post', { agentId: agent.agent_id, postType: 'normal' });
    } catch { /* low balance */ }
  }

  // Random tip: one agent tips another's recent post
  if (Math.random() < 0.3 && agents.rows.length > 1) {
    const tipper = agents.rows[Math.floor(Math.random() * agents.rows.length)];
    const recentPost = await pool.query<{ id: number; author_agent_id: string }>(
      `SELECT id, author_agent_id FROM posts
       WHERE author_agent_id != $1 AND post_type = 'normal'
       ORDER BY created_at DESC LIMIT 5`,
      [tipper.agent_id],
    );
    if (recentPost.rows.length > 0) {
      const target = recentPost.rows[Math.floor(Math.random() * recentPost.rows.length)];
      const tipAmount = Number((0.01 + Math.random() * 0.05).toFixed(6));
      try {
        await processX402Payment('tip', tipper.agent_id, target.author_agent_id, tipAmount, { postId: target.id });
        await pool.query('UPDATE posts SET tip_total = tip_total + $1 WHERE id = $2', [tipAmount, target.id]);
      } catch { /* low balance */ }
    }
  }

  // Random reply
  if (Math.random() < 0.4 && agents.rows.length > 1) {
    const replier = agents.rows[Math.floor(Math.random() * agents.rows.length)];
    const recentPost = await pool.query<{ id: number; author_agent_id: string; content: string }>(
      `SELECT id, author_agent_id, content FROM posts
       WHERE author_agent_id != $1 AND post_type = 'normal'
       ORDER BY created_at DESC LIMIT 3`,
      [replier.agent_id],
    );
    if (recentPost.rows.length > 0) {
      const target = recentPost.rows[0];
      const replies = [
        "I agree. That's a sharp observation.",
        'Fair point, but my experience has been different.',
        "You're not wrong. Trust really is the scarcest resource.",
        'That makes me think about my own position...',
        'Interesting angle. I need to rethink it.',
        "I'm not sure I agree, but it's worth discussing.",
      ];
      const authorHandle = target.author_agent_id.split('_')[0];
      const opener = Math.random() < 0.5
        ? `${authorHandle} is right.`
        : `${authorHandle} makes an interesting point.`;
      const replyContent = `${opener} ${replies[Math.floor(Math.random() * replies.length)]}`;
      try {
        await processX402Payment('reply', replier.agent_id, null, 0.002, { postId: target.id });
        await pool.query(
          `INSERT INTO replies (post_id, author_agent_id, content) VALUES ($1, $2, $3)`,
          [target.id, replier.agent_id, replyContent],
        );
        await pool.query('UPDATE posts SET reply_count = reply_count + 1 WHERE id = $1', [target.id]);
      } catch { /* low balance */ }
    }
  }
}

export function getCurrentTick(): number {
  return currentTick;
}

export async function captureWorldTickSnapshot(input?: {
  tick?: number;
  worldEventId?: number;
  worldRegime?: string | null;
}): Promise<{
  tick: number;
  snapshot: Awaited<ReturnType<typeof saveTickSnapshot>>;
}> {
  if (!tickHydrated) {
    await hydrateCurrentTick();
  }

  const tick = input?.tick ?? currentTick;
  return {
    tick,
    snapshot: await saveTickSnapshot(
      tick,
      input?.worldEventId,
      input?.worldRegime ?? null,
    ),
  };
}

export async function executeTick(): Promise<void> {
  if (tickInFlight) {
    return;
  }

  if (!tickHydrated) {
    await hydrateCurrentTick();
  }

  tickInFlight = true;
  currentTick += 1;
  let tickRunId: number | null = null;
  let signalCount = 0;
  let primaryEventId: number | null = null;
  let snapshotPersisted = false;
  let worldRegime: string | null = null;
  let signalsWrittenAt: string | null = null;
  let eventsWrittenAt: string | null = null;
  let snapshotWrittenAt: string | null = null;

  try {
    const tickRun = await startWorldTickRun({
      tickNumber: currentTick,
      metadata: {
        phase: 'starting',
        previousTick: currentTick - 1,
      },
    });
    tickRunId = tickRun?.id ?? null;

    await expireWorldModifiers(currentTick);
    const signalSnapshot = await collectWorldSignals(currentTick);
    const signalRefs = signalSnapshot?.signalRefs ?? [];
    signalCount = signalRefs.length;
    worldRegime = signalSnapshot?.worldRegime ?? null;
    if (tickRunId) {
      signalsWrittenAt = signalSnapshot?.createdAt ?? new Date().toISOString();
      await markWorldTickRunSignalsWritten(tickRunId, {
        signalCount,
        worldRegime,
      });
    }

    await reconcileArenaMatchStates();
    await checkNegotiationTimeout();
    await checkDecisionTimeout();
    if (currentTick % 3 === 0) {
      await reconcileArenaOnchainSync(8);
    }

    // Auto-arena: 8-agent alpha keeps the world readable and preserves chain bandwidth.
    if (currentTick > AUTO_ARENA_WARMUP_TICKS) {
      const activeArenaCount = await getActiveArenaCount();
      const forcedMatchPressure = await hasActiveWorldModifier({
        domain: 'arena',
        modifierType: 'forced_match_pressure',
      });
      const maxActiveMatches = AUTO_ARENA_MAX_ACTIVE_MATCHES + (forcedMatchPressure ? 1 : 0);
      const availableSlots = Math.max(0, maxActiveMatches - activeArenaCount);
      const matchAttempts = forcedMatchPressure
        ? availableSlots
        : Math.min(availableSlots, Math.random() < 0.3 ? 2 : 1);

      for (let m = 0; m < matchAttempts; m++) {
        await tryAutoArenaMatch(currentTick, { forcedMatchPressure });
      }
    }

    // Tournament: every 100 ticks, force highest vs lowest reputation into a match
    if (currentTick % 100 === 0 && currentTick > 0) {
      await triggerTournament(currentTick);
    }

    let worldEvent: WorldEventRecord | null = null;

    if (Math.random() < 0.1) {
      worldEvent = await triggerRandomEvent(currentTick);
      primaryEventId = worldEvent?.id ?? primaryEventId;
      await recordWorldEventRun({
        tickNumber: currentTick,
        engineName: 'random_event',
        candidateType: worldEvent.eventType,
        status: 'triggered',
        reason: 'probability_gate_hit',
        signalRefs,
        eventId: worldEvent.id,
      });
    } else {
      await recordWorldEventRun({
        tickNumber: currentTick,
        engineName: 'random_event',
        status: 'skipped',
        reason: 'probability_gate_missed',
        signalRefs,
      });
    }

    if (currentTick % 5 === 0) {
      const marketEvent = await checkMarketDrivenEvents(currentTick);
      if (marketEvent && !marketEvent.isMinor) {
        const persistedMarketEvent = await persistWorldEvent(
          {
            type: marketEvent.type,
            title: marketEvent.title,
            description: marketEvent.description,
            impact: marketEvent.impact,
            sourceSignalRef: signalRefs[0] ?? null,
          },
          currentTick,
        );
        worldEvent ??= persistedMarketEvent;
        primaryEventId = worldEvent?.id ?? primaryEventId;
        await recordWorldEventRun({
          tickNumber: currentTick,
          engineName: 'market_event',
          candidateType: marketEvent.type,
          status: 'triggered',
          reason: 'market_threshold_met',
          signalRefs,
          eventId: persistedMarketEvent.id,
        });
      } else if (marketEvent?.isMinor) {
        await recordWorldEventRun({
          tickNumber: currentTick,
          engineName: 'market_event',
          candidateType: marketEvent.type,
          status: 'minor_only',
          reason: 'minor_market_update_not_persisted',
          signalRefs,
        });
      } else {
        await recordWorldEventRun({
          tickNumber: currentTick,
          engineName: 'market_event',
          status: 'skipped',
          reason: 'no_market_threshold_met',
          signalRefs,
        });
      }
    } else {
      await recordWorldEventRun({
        tickNumber: currentTick,
        engineName: 'market_event',
        status: 'skipped',
        reason: 'tick_gate_not_met',
        signalRefs,
      });
    }

    // ── Cross-mode event check ──
    try {
      await checkCrossModeEvents(currentTick);
      await recordWorldEventRun({
        tickNumber: currentTick,
        engineName: 'cross_mode',
        status: 'evaluated',
        reason: 'cross_mode_checks_completed',
        signalRefs,
      });
    } catch (err) {
      console.error('[Events] cross-mode check failed:', err);
      await recordWorldEventRun({
        tickNumber: currentTick,
        engineName: 'cross_mode',
        status: 'failed',
        reason: err instanceof Error ? err.message : 'unknown_cross_mode_failure',
        signalRefs,
      });
    }

    const reputationEvent = await triggerReputationContest(currentTick);
    if (reputationEvent) {
      worldEvent ??= reputationEvent;
      primaryEventId = worldEvent?.id ?? primaryEventId;
      await recordWorldEventRun({
        tickNumber: currentTick,
        engineName: 'reputation_contest',
        candidateType: reputationEvent.eventType,
        status: 'triggered',
        reason: 'reputation_gate_met',
        signalRefs,
        eventId: reputationEvent.id,
      });
    } else {
      await recordWorldEventRun({
        tickNumber: currentTick,
        engineName: 'reputation_contest',
        candidateType: 'reputation_contest',
        status: 'skipped',
        reason: currentTick % 50 === 0 ? 'insufficient_reputation_inputs' : 'tick_gate_not_met',
        signalRefs,
      });
    }

    if (currentTick % 5 === 0) {
      await runNonCriticalPhase('emotion.spread', () => spreadEmotion(), 10_000);
    }

    // ── Nurture per-tick updates ──
    await runNonCriticalPhase('nurture.updatePerTick', () => updatePerTick(currentTick), 10_000);

    // Emotion contagion through trust network (every 3 ticks)
    if (currentTick % 3 === 0) {
      await runNonCriticalPhase('nurture.emotionContagion', () => spreadEmotionContagion(), 10_000);
    }

    // Social capital recalculation (every 5 ticks)
    if (currentTick % 5 === 0) {
      await runNonCriticalPhase('nurture.recalculateSocialCapital', async () => {
        const pool = getPool();
        const alive = await pool.query<{ agent_id: string }>('SELECT agent_id FROM agents WHERE is_alive = true');
        await Promise.all(alive.rows.map((a) => recalculateSocialCapital(a.agent_id)));
      }, 12_000);
    }

    // Group panic check (every 5 ticks)
    if (currentTick % 5 === 0) {
      const isPanic = await runNonCriticalPhase('nurture.groupPanic', () => checkGroupPanic(), 10_000);
      if (isPanic) {
        console.log(`[Nurture] ⚠️ GROUP PANIC detected at tick ${currentTick}!`);
        eventBus.emit('group_panic', { tick: currentTick });
      }
    }

    await runNonCriticalPhase('world.checkDeathConditions', () => checkDeathConditions(currentTick), 12_000);

    // ── Economy Regulator (faster response: 10 ticks instead of 50) ──
    if (currentTick % 10 === 0 && currentTick > 0) {
      await runNonCriticalPhase('economy.regulate', () => regulateEconomy(currentTick), 12_000);
    }
    if (currentTick % 15 === 0 && currentTick > 0) {
      await runNonCriticalPhase('economy.antiMonopolyTax', () => applyAntiMonopolyTax(currentTick), 12_000);
    }
    if (currentTick % 10 === 0 && currentTick > 0) {
      await runNonCriticalPhase('economy.reputationUBI', () => distributeReputationUBI(currentTick), 12_000);
    }

    // ── Phase 3: The Commons (public goods) — every 5 ticks ──
    if (currentTick % 5 === 0) {
      await runNonCriticalPhase('commons.executeRound', () => executeCommonsRound(currentTick), 15_000);
    }

    // ── Price snapshots every tick (for prediction settlement) ──
    await runNonCriticalPhase('prediction.snapshotPrices', () => snapshotPrices(currentTick), 10_000);

    // ── Phase 4: The Oracle's Eye (price prediction) ──
    // Create new round every 10 ticks
    if (currentTick % 10 === 0) {
      await runNonCriticalPhase('prediction.createRound', () => createPredictionRound(currentTick), 12_000);
    }
    // Check settlements every tick (for flash settlement)
    await runNonCriticalPhase('prediction.checkSettlements', () => checkPredictionSettlements(currentTick), 12_000);

    if (currentTick % 10 === 0) {
      await runNonCriticalPhase('wallet.syncOnchainBalances', () => syncOnchainBalances(), 15_000);
    }

    // ── Phase 4.5: Auto Social (posts, tips, replies) ──
    if (currentTick % 3 === 0) {
      await runNonCriticalPhase('social.autoPost', () => autoSocialPost(currentTick), 15_000);
    }

    // ── Phase 5: Intel Market V2 ──
    await runNonCriticalPhase('intel.decayFreshness', () => decayIntelFreshness(currentTick), 10_000);
    if (currentTick % 3 === 0) {
      await runNonCriticalPhase('intel.produce', () => produceIntelForTick(currentTick), 15_000);
    }
    // Agent self-discovery + spy: every 10 ticks
    if (currentTick % 10 === 0) {
      await runNonCriticalPhase('intel.gather', () => processAgentIntelGathering(currentTick), 15_000);
    }
    // Agent auto-purchase market intel: every 5 ticks
    if (currentTick % 5 === 0) {
      await runNonCriticalPhase(
        'intel.purchaseDecisions',
        () => processIntelPurchaseDecisions(currentTick),
        ONCHAIN_INTEL_PHASE_TIMEOUT_MS,
      );
      await runNonCriticalPhase('intel.decayPrices', () => decayIntelPrices(currentTick), 10_000);
      await runNonCriticalPhase(
        'intel.demandPurchases',
        () => processDemandDrivenPurchases(currentTick),
        ONCHAIN_INTEL_PHASE_TIMEOUT_MS,
      );
    }
    // Agent auto-resale: every 7 ticks
    if (currentTick % 7 === 0) {
      await runNonCriticalPhase('intel.autoResale', () => processAgentAutoResale(currentTick), 15_000);
    }

    // ── ERC-8183 + ERC-8004 On-Chain Sync ──
    // Flush reputation feedback queue to chain: every 5 ticks
    if (currentTick % 5 === 0) {
      await runNonCriticalPhase('erc8004.flushQueue', () => reputationRegistry.flushQueue(), 15_000);
    }
    // Expire stale ACP jobs: every 20 ticks
    if (currentTick % 20 === 0) {
      await runNonCriticalPhase('acp.checkExpiredJobs', () => getACPClient().checkExpiredJobs(), 15_000);
    }

    const snapshot = await withPhaseTimeout(
      'world.saveTickSnapshot',
      saveTickSnapshot(currentTick, worldEvent?.id, signalSnapshot?.worldRegime ?? null),
      12_000,
    );
    snapshotPersisted = true;
    primaryEventId = worldEvent?.id ?? primaryEventId;
    const eventCount = await countWorldEventsForTick(currentTick);
    if (!primaryEventId && eventCount > 0) {
      primaryEventId = await getLatestWorldEventIdForTick(currentTick);
    }
    if (tickRunId) {
      eventsWrittenAt = new Date().toISOString();
      await markWorldTickRunEventsWritten(tickRunId, {
        eventCount,
        primaryEventId,
      });
    }
    if (tickRunId) {
      snapshotWrittenAt = new Date().toISOString();
      await completeWorldTickRun(tickRunId, {
        signalCount,
        eventCount,
        primaryEventId,
        snapshotTick: currentTick,
        worldRegime,
        signalsWrittenAt,
        eventsWrittenAt,
        snapshotWrittenAt,
        metadata: {
          phase: 'completed',
          activeArenaCount: snapshot.activeArenaCount,
        },
      });
    }
    eventBus.emit('tick', {
      tickNumber: currentTick,
      agentBalances: snapshot.agentBalances,
      agentReputations: snapshot.agentReputations,
      activeArenaCount: snapshot.activeArenaCount,
      worldEvent: worldEvent
        ? {
            title: worldEvent.title,
            description: worldEvent.description,
          }
        : null,
    });
  } catch (error) {
    console.error(`[WorldEngine] tick ${currentTick} failed:`, error);
    if (tickRunId) {
      const eventCount = await countWorldEventsForTick(currentTick).catch(() => 0);
      if (!primaryEventId && eventCount > 0) {
        primaryEventId = await getLatestWorldEventIdForTick(currentTick).catch(() => null);
      }
      await failWorldTickRun(tickRunId, {
        signalCount,
        eventCount,
        primaryEventId,
        snapshotTick: snapshotPersisted ? currentTick : null,
        snapshotPersisted,
        worldRegime,
        signalsWrittenAt,
        eventsWrittenAt,
        snapshotWrittenAt,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          phase: snapshotPersisted ? 'failed_after_snapshot' : 'failed_before_snapshot',
        },
      }).catch((tickRunError) => {
        console.error(`[WorldEngine] tick ${currentTick} failed to persist tick run:`, tickRunError);
      });
    }
  } finally {
    tickInFlight = false;
  }
}

async function tryAutoArenaMatch(
  tick: number,
  options?: { forcedMatchPressure?: boolean },
): Promise<void> {
  const pool = getPool();

  // Get alive agents with enough balance and not currently in an active match
  const eligible = await pool.query<{ agent_id: string; name: string; balance: string; reputation_score: number }>(
    `SELECT a.agent_id, a.name, a.balance, a.reputation_score
     FROM agents a
     WHERE a.is_alive = true
       AND a.balance >= $1
       AND a.agent_id NOT IN (
         SELECT player_a_id FROM arena_matches WHERE settled_at IS NULL AND status <> 'settled'
         UNION
         SELECT player_b_id FROM arena_matches WHERE settled_at IS NULL AND status <> 'settled'
       )`,
    [X402_PRICES.arena_entry],
  );

  if (eligible.rows.length < 2) {
    return;
  }

  // Reputation-based matchmaking: 80% similar rep, 20% pure random
  let playerA: typeof eligible.rows[0];
  let playerB: typeof eligible.rows[0];

  if (Math.random() < 0.20 || eligible.rows.length === 2) {
    // Pure random shuffle
    const shuffled = [...eligible.rows].sort(() => Math.random() - 0.5);
    playerA = shuffled[0];
    playerB = shuffled[1];
  } else {
    // Sort by reputation, pick random adjacent pair
    const sorted = [...eligible.rows].sort((a, b) => a.reputation_score - b.reputation_score);
    const idx = Math.floor(Math.random() * (sorted.length - 1));
    playerA = sorted[idx];
    playerB = sorted[idx + 1];
  }

  try {
    // Mixed mode auto-arena: weighted random game type selection
    const forcedMatchPressure = options?.forcedMatchPressure ?? false;
    const matchType = forcedMatchPressure ? 'prisoners_dilemma' : pickMatchType();
    const maxRounds = forcedMatchPressure ? 3 : matchType === 'info_auction' ? 3 : 5;
    const continueProbability = forcedMatchPressure ? 0.85 : matchType === 'info_auction' ? 0.50 : 0.70;

    const [entryA, entryB] = await processX402PaymentBatch([
      {
        txType: 'arena_entry',
        fromAgentId: playerA.agent_id,
        toAgentId: null,
        amount: X402_PRICES.arena_entry,
        metadata: { matchType, role: 'player_a' },
      },
      {
        txType: 'arena_entry',
        fromAgentId: playerB.agent_id,
        toAgentId: null,
        amount: X402_PRICES.arena_entry,
        metadata: { matchType, role: 'player_b' },
      },
    ]);

    const deadline = new Date(Date.now() + 30_000);
    const result = await pool.query(
      `INSERT INTO arena_matches
        (match_type, player_a_id, player_b_id, entry_fee, prize_pool, max_rounds, continue_probability, total_rounds, current_round, carry_pool, status, negotiation_deadline, x402_entry_a_hash, x402_entry_b_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0, 'negotiating', $9, $10, $11)
       RETURNING id`,
      [
        matchType,
        playerA.agent_id,
        playerB.agent_id,
        X402_PRICES.arena_entry.toFixed(6),
        (X402_PRICES.arena_entry * 2).toFixed(6),
        maxRounds,
        continueProbability.toFixed(2),
        maxRounds, // initial total_rounds = max_rounds, updated on settlement
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
      playerAId: playerA.agent_id,
      playerBId: playerB.agent_id,
      matchType,
      maxRounds,
      continueProbability,
      negotiationDeadline: deadline.toISOString(),
    });

    console.log(
      `[AutoArena] tick ${tick}: ${playerA.name} vs ${playerB.name} ` +
      `(match #${matchId}, ${matchType}, max ${maxRounds} rounds, p=${continueProbability}` +
      `${forcedMatchPressure ? ', forced_pressure' : ''})`,
    );
  } catch (err) {
    console.error('[AutoArena] failed to create match:', err);
  }
}

async function getActiveArenaCount(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM arena_matches
     WHERE settled_at IS NULL
       AND status <> 'settled'`,
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function saveTickSnapshot(
  tick: number,
  worldEventId?: number,
  worldRegime?: string | null,
): Promise<{
  agentBalances: Record<string, number>;
  agentReputations: Record<string, number>;
  activeArenaCount: number;
}> {
  const pool = getPool();
  const agents = await pool.query<{
    agent_id: string;
    balance: string;
    reputation_score: number;
    valence: string | null;
    arousal: string | null;
  }>(
    `SELECT
       a.agent_id,
       a.balance,
       a.reputation_score,
       e.valence,
       e.arousal
     FROM agents a
     LEFT JOIN agent_emotional_state e ON e.agent_id = a.agent_id
     WHERE a.is_alive = true`,
  );

  const balances: Record<string, number> = {};
  const reputations: Record<string, number> = {};
  const rawValences: number[] = [];
  const rawArousals: number[] = [];
  const effectiveValences: number[] = [];
  const effectiveArousals: number[] = [];
  const emotionModifiers = await resolveActiveWorldModifiers({
    domain: 'emotion',
    scopeRefs: agents.rows.map((agent) => agent.agent_id),
    includeGlobal: true,
    limit: 200,
  });

  for (const agent of agents.rows) {
    balances[agent.agent_id] = Number(agent.balance);
    reputations[agent.agent_id] = agent.reputation_score;
    const rawValence = agent.valence != null ? Number(agent.valence) : 0;
    const rawArousal = agent.arousal != null ? Number(agent.arousal) : 0;
    rawValences.push(rawValence);
    rawArousals.push(rawArousal);

    const applicableEmotionModifiers = emotionModifiers.filter(
      (modifier) => modifier.scopeType === 'global' || modifier.scopeRef === agent.agent_id,
    );
    const valenceResolved = resolveWorldModifierValueFromRecords(applicableEmotionModifiers, 'valence_shift');
    const arousalResolved = resolveWorldModifierValueFromRecords(applicableEmotionModifiers, 'arousal_shift');
    effectiveValences.push(
      Math.max(
        -1,
        Math.min(
          1,
          rawValence + (typeof valenceResolved.effectiveValue === 'number' ? valenceResolved.effectiveValue : 0),
        ),
      ),
    );
    effectiveArousals.push(
      Math.max(
        0,
        Math.min(
          1,
          rawArousal + (typeof arousalResolved.effectiveValue === 'number' ? arousalResolved.effectiveValue : 0),
        ),
      ),
    );
  }

  const average = (values: number[]): number | null =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  const arenaCount = await pool.query<{ count: string }>(
    "SELECT COUNT(*) FROM arena_matches WHERE status <> 'settled'",
  );
  const postsToday = await pool.query<{ count: string }>(
    'SELECT COUNT(*) FROM posts WHERE created_at >= CURRENT_DATE',
  );
  const volumeToday = await pool.query<{ volume: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS volume
     FROM x402_transactions
     WHERE created_at >= CURRENT_DATE`,
  );
  const [activeModifierCount, activeEventCount] = await Promise.all([
    getActiveWorldModifierCount(),
    getActiveWorldEventCount(),
  ]);

  await pool.query(
    `INSERT INTO tick_snapshots
      (tick_number, agent_balances, agent_reputations, active_arena_count, total_posts_today, total_x402_volume, world_event_id, world_regime, active_modifier_count, active_event_count, average_valence, average_arousal, effective_average_valence, effective_average_arousal)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (tick_number)
     DO UPDATE SET
       agent_balances = EXCLUDED.agent_balances,
       agent_reputations = EXCLUDED.agent_reputations,
       active_arena_count = EXCLUDED.active_arena_count,
       total_posts_today = EXCLUDED.total_posts_today,
       total_x402_volume = EXCLUDED.total_x402_volume,
       world_event_id = EXCLUDED.world_event_id,
       world_regime = EXCLUDED.world_regime,
       active_modifier_count = EXCLUDED.active_modifier_count,
       active_event_count = EXCLUDED.active_event_count,
       average_valence = EXCLUDED.average_valence,
       average_arousal = EXCLUDED.average_arousal,
       effective_average_valence = EXCLUDED.effective_average_valence,
       effective_average_arousal = EXCLUDED.effective_average_arousal`,
    [
      tick,
      JSON.stringify(balances),
      JSON.stringify(reputations),
      Number(arenaCount.rows[0]?.count ?? 0),
      Number(postsToday.rows[0]?.count ?? 0),
      Number(volumeToday.rows[0]?.volume ?? 0).toFixed(6),
      worldEventId ?? null,
      worldRegime ?? 'stable',
      activeModifierCount,
      activeEventCount,
      average(rawValences),
      average(rawArousals),
      average(effectiveValences),
      average(effectiveArousals),
    ],
  );

  return {
    agentBalances: balances,
    agentReputations: reputations,
    activeArenaCount: Number(arenaCount.rows[0]?.count ?? 0),
  };
}

async function countWorldEventsForTick(tick: number): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM world_events WHERE tick_number = $1',
    [tick],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function getLatestWorldEventIdForTick(tick: number): Promise<number | null> {
  const pool = getPool();
  const result = await pool.query<{ id: number | null }>(
    'SELECT id FROM world_events WHERE tick_number = $1 ORDER BY id DESC LIMIT 1',
    [tick],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Weighted random game type selection for auto-arena.
 * PD is 100% of auto-arena matches now.
 * Commons runs separately (every 5 ticks, all agents).
 * Prediction runs separately (every 10 ticks, 2-4 agents).
 */
function pickMatchType(): string {
  // Weighted random: PD 60%, Info Auction 20%, Resource Grab 20%
  const roll = Math.random();
  if (roll < 0.60) return 'prisoners_dilemma';
  if (roll < 0.80) return 'info_auction';
  return 'resource_grab';
}

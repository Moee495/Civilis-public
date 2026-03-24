import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { getIntelImpactOnCommons } from '../intel/intel-impact.js';
import { verifyCommonsIntel } from '../intel/intel-verification.js';
import { createCommonsJob, settleCommonsJob } from '../erc8183/hooks/commons-hook.js';
import { getACPClient } from '../erc8183/acp-client.js';
import { getFateCard, computeDynamicTarotState } from '../fate/fate-engine.js';
import {
  type FateContext,
  calculateFateCooperationRate,
  calculateFateRiskTolerance,
  getArchetypeBaseCoopRate,
  getArchetypeBaseRisk,
  getCivilizationModifiers,
  getMBTIModifiers,
  getWuxingModifiers,
  getZodiacModifiers,
} from '../fate/fate-modifiers.js';
import { loadNurtureProfileFromDB } from '../nurture/nurture-updater.js';
import { getEconomyImpactOnCommons, getPDTrustImpactOnCommons } from '../economy/cross-mode-chains.js';
import {
  getLatestWorldModifierNumericValue,
  getWorldModifierDelta,
} from '../world/modifiers.js';

// ─── Constants ───
const PG_BASE_INJECTION = 0.5;
const CONTRIBUTE_COST = 0.5;
const SABOTAGE_COST = 0.3;
const CONTRIBUTE_PAYOUT_WEIGHT = 1.0;
const FREE_RIDE_PAYOUT_WEIGHT = 0.72;
const HOARD_SAFETY_PAYOUT = 0.15;
const SABOTAGE_LOOT_RATE = 0.18;
const SABOTAGE_DAMAGE_PER_AGENT = 0.2;
const SABOTAGE_BASE_DETECT_RATE = 0.20;
const SABOTAGE_DETECT_PER_PLAYER = 0.15;
const SABOTAGE_DETECT_COOP_FACTOR = 0.20;

async function shouldRunCommonsAcpHook(): Promise<boolean> {
  const protocol = await getACPClient().getProtocolDescriptor();
  return !(protocol.surface === 'v2' && protocol.addressSource === 'v2_env');
}

// In-memory cache for prediction loss pool that flows into commons
let predictionLossPool = 0;

export function addToPredictionLossPool(amount: number): void {
  predictionLossPool += amount;
}

export function getAndResetPredictionLossPool(): number {
  const amount = predictionLossPool;
  predictionLossPool = 0;
  return amount;
}

interface AgentDecision {
  agentId: string;
  archetype: string;
  balance: number;
  decision: 'contribute' | 'free_ride' | 'hoard' | 'sabotage';
  reason: string;
  scores: Record<'contribute' | 'free_ride' | 'hoard' | 'sabotage', number>;
  weight: number;
}

type CommonsDecisionType = AgentDecision['decision'];

const COMMONS_DECISION_KEYS: CommonsDecisionType[] = ['contribute', 'free_ride', 'hoard', 'sabotage'];

const ARCHETYPE_COMMONS_BASE: Record<string, Record<CommonsDecisionType, number>> = {
  sage: { contribute: 0.9, free_ride: 0.02, hoard: 0.08, sabotage: 0.0 },
  monk: { contribute: 0.75, free_ride: 0.05, hoard: 0.2, sabotage: 0.0 },
  oracle: { contribute: 0.4, free_ride: 0.35, hoard: 0.2, sabotage: 0.05 },
  fox: { contribute: 0.25, free_ride: 0.45, hoard: 0.2, sabotage: 0.1 },
  echo: { contribute: 0.5, free_ride: 0.3, hoard: 0.15, sabotage: 0.05 },
  whale: { contribute: 0.1, free_ride: 0.5, hoard: 0.25, sabotage: 0.15 },
  hawk: { contribute: 0.05, free_ride: 0.25, hoard: 0.2, sabotage: 0.5 },
  chaos: { contribute: 0.25, free_ride: 0.25, hoard: 0.25, sabotage: 0.25 },
};

interface LoadedCommonsNurture {
  combat?: {
    winRate?: number;
    currentStreak?: number;
    totalMatches?: number;
    overallCoopRate?: number;
  };
  trauma?: {
    state?: string;
    betrayals?: number;
  };
  wealth?: {
    class?: string;
    trend?: string;
    lossAversion?: number;
    timeHorizon?: number;
  };
  social?: {
    position?: string;
    adversaries?: number;
    strongTies?: number;
    weakTies?: number;
  };
  reputation?: {
    tier?: string;
    score?: number;
    trajectory?: string;
    fallFromGrace?: boolean;
  };
  emotion?: {
    mood?: string;
    valence?: number;
    arousal?: number;
  };
  cognition?: {
    complexity?: number;
    explorationRate?: number;
    age?: number;
  };
}

interface CommonsSignalBundle {
  rawFate: FateContext | null;
  nurture: LoadedCommonsNurture | null;
  intelImpact: { contributeDelta: number; hoardDelta: number };
  pdTrustImpact: { myContributeDelta: number; othersContributeDelta: number };
  economyImpact: ReturnType<typeof getEconomyImpactOnCommons>;
  fateCooperation: number;
  fateRisk: number;
  worldRiskShift: number;
  civMods: ReturnType<typeof getCivilizationModifiers> | null;
  mbtiMods: ReturnType<typeof getMBTIModifiers> | null;
  wuxingMods: ReturnType<typeof getWuxingModifiers> | null;
  zodiacMods: ReturnType<typeof getZodiacModifiers> | null;
}

export interface CommonsWorldModifierState {
  baseInjection: number;
  multiplierBonus: number;
  cooperationDelta: number;
}

function clampCommonsRate(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getCommonsMultiplier(cooperationRate: number, multiplierBonus: number): number {
  let baseMultiplier = 0.8;
  if (cooperationRate >= 0.999) baseMultiplier = 1.35;
  else if (cooperationRate >= 0.75) baseMultiplier = 1.25;
  else if (cooperationRate >= 0.5) baseMultiplier = 1.1;
  else if (cooperationRate >= 0.25) baseMultiplier = 0.95;
  return Number(Math.max(0, baseMultiplier + multiplierBonus).toFixed(2));
}

export async function getActiveCommonsWorldModifierState(): Promise<CommonsWorldModifierState> {
  const [baseInjectionOverride, multiplierBonus, cooperationDelta] = await Promise.all([
    getLatestWorldModifierNumericValue({
      domain: 'commons',
      modifierType: 'commons_base_injection_override',
    }),
    getWorldModifierDelta({
      domain: 'commons',
      modifierType: 'commons_multiplier_bonus',
    }),
    getWorldModifierDelta({
      domain: 'commons',
      modifierType: 'commons_coop_override',
    }),
  ]);

  return {
    baseInjection: baseInjectionOverride ?? PG_BASE_INJECTION,
    multiplierBonus,
    cooperationDelta,
  };
}

/**
 * Execute a full commons round. Called by tick-engine every 5 ticks.
 * Steps:
 *   A. Gather all alive agents
 *   B. Each agent makes a decision (for now, use archetype-based probability)
 *   C. Calculate pool = base_injection + prediction_loss_pool + sum(contributions)
 *   D. Apply multiplier based on cooperation_rate
 *   E. Apply sabotage damage
 *   F. Distribute to contributors and free riders based on weights
 *   G. Record to DB, emit events
 */
export async function executeCommonsRound(tickNumber: number): Promise<void> {
  const pool = getPool();
  const worldModifiers = await getActiveCommonsWorldModifierState();

  // Step A: Get all alive agents
  const aliveResult = await pool.query<{
    agent_id: string;
    name: string;
    archetype: string;
    balance: string;
    reputation_score: number;
  }>('SELECT agent_id, name, archetype, balance, reputation_score FROM agents WHERE is_alive = true');

  const agents = aliveResult.rows;
  if (agents.length === 0) return;

  // Get round number
  const roundResult = await pool.query<{ max_round: string }>(
    'SELECT COALESCE(MAX(round_number), 0) as max_round FROM commons_rounds'
  );
  const roundNumber = parseInt(roundResult.rows[0].max_round) + 1;

  // Get last round's cooperation rate
  const lastRoundResult = await pool.query<{ cooperation_rate: string }>(
    'SELECT cooperation_rate FROM commons_rounds ORDER BY id DESC LIMIT 1'
  );
  const lastCoopRate = lastRoundResult.rows[0] ? parseFloat(lastRoundResult.rows[0].cooperation_rate) : 0.5;

  // Get economy phase
  const econResult = await pool.query<{ economy_phase: string }>(
    'SELECT economy_phase FROM economy_state ORDER BY id DESC LIMIT 1'
  );
  const economyPhase = econResult.rows[0]?.economy_phase ?? 'stable';

  // Get streaks for each agent
  const streaksResult = await pool.query<{
    agent_id: string;
    contribute_streak: number;
    freeriding_streak: number;
  }>(`SELECT a.agent_id,
      COALESCE((SELECT contribute_streak FROM commons_decisions cd
        JOIN commons_rounds cr ON cd.round_id = cr.id
        WHERE cd.agent_id = a.agent_id ORDER BY cr.round_number DESC LIMIT 1), 0) as contribute_streak,
      COALESCE((SELECT freeriding_streak FROM commons_decisions cd
        JOIN commons_rounds cr ON cd.round_id = cr.id
        WHERE cd.agent_id = a.agent_id ORDER BY cr.round_number DESC LIMIT 1), 0) as freeriding_streak
    FROM agents a WHERE a.is_alive = true`);
  const streakMap = new Map(streaksResult.rows.map(r => [r.agent_id, r]));

  // Step B: Each agent makes a three-layer commons decision.
  const decisions = await Promise.all(
    agents.map((agent) =>
      buildCommonsDecision(agent, {
        economyPhase,
        lastCoopRate,
        streak: streakMap.get(agent.agent_id),
      }),
    ),
  );

  // Step C: Calculate pool
  const contributors = decisions.filter(d => d.decision === 'contribute');
  const freeRiders = decisions.filter(d => d.decision === 'free_ride');
  const hoarders = decisions.filter(d => d.decision === 'hoard');
  const saboteurs = decisions.filter(d => d.decision === 'sabotage');

  const plPool = getAndResetPredictionLossPool();
  const contributeTotal = contributors.length * CONTRIBUTE_COST;
  const rawPool = worldModifiers.baseInjection + plPool + contributeTotal;

  // Step D: Apply multiplier and siphon off strategic edge cases
  const rawCooperationRate = agents.length > 0 ? contributors.length / agents.length : 0;
  const cooperationRate = clampCommonsRate(rawCooperationRate + worldModifiers.cooperationDelta);
  const multiplier = getCommonsMultiplier(cooperationRate, worldModifiers.multiplierBonus);
  const lootBudget = saboteurs.length > 0 ? Number((rawPool * SABOTAGE_LOOT_RATE).toFixed(6)) : 0;
  const hoardSafetyTotal = (rawCooperationRate < 0.5 || saboteurs.length > 0)
    ? Number((hoarders.length * HOARD_SAFETY_PAYOUT).toFixed(6))
    : 0;
  const multipliedPool = Math.max(0, (rawPool - lootBudget) * multiplier);

  // Step E: Apply sabotage damage after the pool compounds
  const sabotageDamage = Number((SABOTAGE_DAMAGE_PER_AGENT * saboteurs.length).toFixed(6));
  const finalPool = Math.max(0, multipliedPool - sabotageDamage - hoardSafetyTotal);

  // Step F: Distribute based on weights
  const totalWeight = decisions.reduce((sum, decision) => sum + decision.weight, 0);

  // Calculate payouts
  const payouts: Map<string, number> = new Map();
  if (totalWeight > 0) {
    for (const decision of decisions) {
      if (decision.weight <= 0) continue;
      const payout = (decision.weight / totalWeight) * finalPool;
      payouts.set(decision.agentId, Number(payout.toFixed(6)));
    }
  } else {
    // Edge case: no one gets distribution, pool goes to treasury
    console.log(`[Commons] Round ${roundNumber}: total_weight=0, pool → treasury`);
  }
  if (saboteurs.length > 0 && lootBudget > 0) {
    const lootPerSaboteur = Number((lootBudget / saboteurs.length).toFixed(6));
    for (const s of saboteurs) {
      payouts.set(s.agentId, Number(((payouts.get(s.agentId) ?? 0) + lootPerSaboteur).toFixed(6)));
    }
  }
  if (hoarders.length > 0 && hoardSafetyTotal > 0) {
    const safetyPerHoarder = Number((hoardSafetyTotal / hoarders.length).toFixed(6));
    for (const h of hoarders) {
      payouts.set(h.agentId, Number(((payouts.get(h.agentId) ?? 0) + safetyPerHoarder).toFixed(6)));
    }
  }

  // Sabotage detection
  const sabotageDetected = new Set<string>();
  for (const s of saboteurs) {
    const detectChance = Math.min(
      0.75,
      SABOTAGE_BASE_DETECT_RATE + saboteurs.length * SABOTAGE_DETECT_PER_PLAYER + cooperationRate * SABOTAGE_DETECT_COOP_FACTOR,
    );
    if (Math.random() < detectChance) {
      sabotageDetected.add(s.agentId);
    }
  }

  // Step G: Record to DB and process payments
  let createdRoundId = 0;
  await withTransaction(async (client) => {
    // Create round record
    const roundInsert = await client.query(
      `INSERT INTO commons_rounds
        (round_number, tick_number, base_injection, prediction_loss_pool, contribute_total,
         multiplier, sabotage_damage, final_pool, cooperation_rate,
         participant_count, contributor_count, freerider_count, hoarder_count, saboteur_count, economy_phase)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        roundNumber,
        tickNumber,
        worldModifiers.baseInjection,
        plPool,
        contributeTotal,
        multiplier,
        sabotageDamage,
        finalPool,
        cooperationRate,
        agents.length,
        contributors.length,
        freeRiders.length,
        hoarders.length,
        saboteurs.length,
        economyPhase,
      ]
    );
    const roundId = roundInsert.rows[0].id;
    createdRoundId = roundId;

    // Process each agent
    for (const d of decisions) {
      const payout = payouts.get(d.agentId) ?? 0;
      let cost = 0;
      if (d.decision === 'contribute') cost = CONTRIBUTE_COST;
      if (d.decision === 'sabotage') cost = SABOTAGE_COST;

      // Deduct costs
      if (cost > 0) {
        await client.query('UPDATE agents SET balance = balance - $1 WHERE agent_id = $2', [cost, d.agentId]);
      }

      // Credit payouts
      if (payout > 0) {
        await client.query('UPDATE agents SET balance = balance + $1 WHERE agent_id = $2', [payout, d.agentId]);
      }

      // Reputation changes
      let repChange = 0;
      if (d.decision === 'contribute') repChange = 4;
      if (d.decision === 'free_ride') repChange = -3;
      if (d.decision === 'hoard') repChange = -1;
      if (d.decision === 'sabotage') {
        repChange = sabotageDetected.has(d.agentId) ? -15 : -2;
      }

      const prevStreak = streakMap.get(d.agentId);
      const newContribStreak = d.decision === 'contribute' ? (prevStreak?.contribute_streak ?? 0) + 1 : 0;
      const newFreeRideStreak = d.decision === 'free_ride' ? (prevStreak?.freeriding_streak ?? 0) + 1 : 0;
      if (d.decision === 'free_ride' && newFreeRideStreak >= 3) {
        repChange -= 3;
      }

      if (repChange !== 0) {
        await client.query(
          'UPDATE agents SET reputation_score = GREATEST(0, LEAST(1000, reputation_score + $1)) WHERE agent_id = $2',
          [repChange, d.agentId]
        );
      }

      await client.query(
        `INSERT INTO commons_decisions
          (round_id, agent_id, decision, reason, score_snapshot, cost, weight, payout, net_profit,
           contribute_streak, freeriding_streak, sabotage_detected, reputation_change)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          roundId,
          d.agentId,
          d.decision,
          d.reason,
          JSON.stringify(d.scores),
          cost,
          d.weight,
          payout,
          payout - cost,
          newContribStreak,
          newFreeRideStreak,
          sabotageDetected.has(d.agentId),
          repChange,
        ]
      );
    }
  });

  // Emit event
  eventBus.emit('commons_settled', {
    roundNumber,
    roundId: createdRoundId,
    tickNumber,
    baseInjection: worldModifiers.baseInjection,
    rawCooperationRate,
    cooperationRate,
    multiplier,
    lootBudget,
    hoardSafetyTotal,
    finalPool,
    participantCount: agents.length,
    contributors: contributors.length,
    freeRiders: freeRiders.length,
    hoarders: hoarders.length,
    saboteurs: saboteurs.length,
    sabotageDamage,
    detectedSaboteurs: Array.from(sabotageDetected),
    decisionDetails: decisions.map((decision) => ({
      agentId: decision.agentId,
      decision: decision.decision,
      reason: decision.reason,
    })),
  });

  // Legacy ACP hook path is intentionally skipped when the runtime is pinned to ACPV2.
  // Commons rounds still rely on the older local ACP helper path and are not yet mapped
  // through a dedicated v2 runtime integration.
  if (await shouldRunCommonsAcpHook()) {
    try {
      const { acpJobId } = await createCommonsJob({
        roundId: createdRoundId,
        roundNumber,
        baseInjection: worldModifiers.baseInjection,
        predictionLossPool: plPool,
        contributeTotal,
        participantCount: agents.length,
      });
      await settleCommonsJob({
        acpJobId,
        roundId: createdRoundId,
        cooperationRate,
        multiplier,
        finalPool,
        sabotageDamage,
        decisions: decisions.map((decision) => {
          const payout = payouts.get(decision.agentId) ?? 0;
          const cost = decision.decision === 'contribute'
            ? CONTRIBUTE_COST
            : decision.decision === 'sabotage'
              ? SABOTAGE_COST
              : 0;
          return {
            agentId: decision.agentId,
            decision: decision.decision,
            payout,
            netProfit: payout - cost,
          };
        }),
      });
    } catch (err) { console.warn('[ACP] Commons settlement hook failed:', err); }
  } else {
    console.info('[ACP] Commons settlement hook skipped in ACPV2 runtime; legacy local hook path remains disabled.');
  }

  // Verify economic forecast intel accuracy
  try { await verifyCommonsIntel(cooperationRate, economyPhase, tickNumber); } catch (err) { console.error('[Intel] commons verify failed:', err); }

  console.log(
    `[Commons] Round ${roundNumber} tick=${tickNumber}: ` +
      `coop=${(rawCooperationRate * 100).toFixed(0)}%→${(cooperationRate * 100).toFixed(0)}% ` +
      `mul=${multiplier}x pool=${finalPool.toFixed(3)} ` +
      `C=${contributors.length} FR=${freeRiders.length} H=${hoarders.length} S=${saboteurs.length}`
  );
}

async function buildCommonsDecision(
  agent: { agent_id: string; archetype: string; balance: string; reputation_score: number },
  params: {
    economyPhase: string;
    lastCoopRate: number;
    streak?: { contribute_streak: number; freeriding_streak: number };
  },
): Promise<AgentDecision> {
  const balance = Number(agent.balance);
  const baseScores = ARCHETYPE_COMMONS_BASE[agent.archetype] ?? ARCHETYPE_COMMONS_BASE.echo;

  if (balance < 1.0) {
    return {
      agentId: agent.agent_id,
      archetype: agent.archetype,
      balance,
      decision: 'hoard',
      reason: 'survival_floor|balance<1.0',
      scores: {
        contribute: 0.01,
        free_ride: 0.08,
        hoard: 0.96,
        sabotage: 0.01,
      },
      weight: 0,
    };
  }

  const signals = await loadCommonsSignals(agent, params.economyPhase);
  const scores = scoreCommonsOptions(agent, balance, params.lastCoopRate, params.streak, signals);
  const decision = chooseCommonsDecision(scores);

  return {
    agentId: agent.agent_id,
    archetype: agent.archetype,
    balance,
    decision,
    reason: buildCommonsDecisionReason(decision, params.economyPhase, signals),
    scores,
    weight: getCommonsWeight(decision, params.streak),
  };
}

async function loadCommonsSignals(
  agent: { agent_id: string; archetype: string },
  economyPhase: string,
): Promise<CommonsSignalBundle> {
  const [rawFate, nurture, intelImpact, pdTrustImpact, worldRiskShift] = await Promise.all([
    loadCommonsFate(agent.agent_id),
    loadNurtureProfileFromDB(agent.agent_id) as Promise<LoadedCommonsNurture | null>,
    getIntelImpactOnCommons(agent.agent_id).catch(() => ({ contributeDelta: 0, hoardDelta: 0 })),
    getPDTrustImpactOnCommons(agent.agent_id).catch(() => ({ myContributeDelta: 0, othersContributeDelta: 0 })),
    getWorldModifierDelta({
      domain: 'agent_decision',
      modifierType: 'risk_tolerance_shift',
    }).catch(() => 0),
  ]);

  const baseCoop = getArchetypeBaseCoopRate(agent.archetype);
  const baseRisk = getArchetypeBaseRisk(agent.archetype);
  const fateCooperation = rawFate ? calculateFateCooperationRate(baseCoop, rawFate) : baseCoop;
  const fateRisk = rawFate ? calculateFateRiskTolerance(baseRisk, rawFate) : baseRisk;

  return {
    rawFate,
    nurture,
    intelImpact,
    pdTrustImpact,
    economyImpact: getEconomyImpactOnCommons(economyPhase),
    fateCooperation,
    fateRisk,
    worldRiskShift,
    civMods: rawFate ? getCivilizationModifiers(rawFate.civilization) : null,
    mbtiMods: rawFate ? getMBTIModifiers(rawFate.mbti) : null,
    wuxingMods: rawFate ? getWuxingModifiers(rawFate.wuxing) : null,
    zodiacMods: rawFate ? getZodiacModifiers(rawFate.zodiac) : null,
  };
}

async function loadCommonsFate(agentId: string): Promise<FateContext | null> {
  const card = await getFateCard(agentId, true);
  if (!card.mbti || !card.wuxing || !card.zodiac || !card.tarotName || !card.civilization) {
    return null;
  }

  const tarotState = await computeDynamicTarotState(agentId, card.initialTarotState ?? 'upright');
  return {
    mbti: String(card.mbti),
    wuxing: String(card.wuxing),
    zodiac: String(card.zodiac),
    tarotName: String(card.tarotName),
    tarotState,
    civilization: String(card.civilization),
  };
}

function scoreCommonsOptions(
  agent: { archetype: string; reputation_score: number },
  balance: number,
  lastCoopRate: number,
  streak: { contribute_streak: number; freeriding_streak: number } | undefined,
  signals: CommonsSignalBundle,
): Record<CommonsDecisionType, number> {
  const baseScores = ARCHETYPE_COMMONS_BASE[agent.archetype] ?? ARCHETYPE_COMMONS_BASE.echo;
  const scores: Record<CommonsDecisionType, number> = {
    contribute: 0.08 + baseScores.contribute * 0.55,
    free_ride: 0.06 + baseScores.free_ride * 0.50,
    hoard: 0.06 + baseScores.hoard * 0.55,
    sabotage: 0.03 + baseScores.sabotage * 0.70,
  };

  scores.contribute += signals.fateCooperation * 0.30;
  scores.contribute += signals.intelImpact.contributeDelta * 0.80;
  scores.contribute += signals.pdTrustImpact.myContributeDelta * 0.90;
  scores.contribute += signals.economyImpact.contributeBonus * 0.60;

  if (lastCoopRate >= 0.85) {
    scores.contribute -= 0.10;
    scores.free_ride += 0.10;
    scores.sabotage += 0.06;
  } else if (lastCoopRate <= 0.35) {
    scores.contribute += 0.12;
    scores.hoard += 0.08;
    scores.sabotage -= 0.08;
  }

  scores.free_ride += Math.max(0, lastCoopRate - 0.5) * 0.20;
  scores.free_ride += Math.max(0, -signals.pdTrustImpact.myContributeDelta) * 0.28;
  scores.free_ride += Math.max(0, signals.pdTrustImpact.othersContributeDelta * -1) * 0.12;

  scores.hoard += signals.intelImpact.hoardDelta * 0.90;
  scores.hoard += signals.economyImpact.hoardBonus * 0.75;
  scores.hoard += Math.max(0, -signals.pdTrustImpact.myContributeDelta) * 0.45;
  scores.hoard += Math.max(0, 0.45 - lastCoopRate) * 0.12;

  scores.sabotage += Math.max(0, signals.fateRisk - 0.55) * 0.20;
  scores.sabotage += Math.max(0, -signals.pdTrustImpact.myContributeDelta) * 0.24;
  scores.sabotage += Math.max(0, 0.35 - lastCoopRate) * 0.18;
  scores.sabotage += Math.max(0, -signals.economyImpact.contributeBonus) * 0.10;

  const positiveRiskShift = Math.max(0, signals.worldRiskShift);
  const negativeRiskShift = Math.max(0, -signals.worldRiskShift);
  scores.contribute -= positiveRiskShift * 0.14;
  scores.contribute += negativeRiskShift * 0.18;
  scores.free_ride += positiveRiskShift * 0.08;
  scores.free_ride -= negativeRiskShift * 0.03;
  scores.hoard += positiveRiskShift * 0.12;
  scores.hoard -= negativeRiskShift * 0.05;
  scores.sabotage += positiveRiskShift * 0.10;
  scores.sabotage -= negativeRiskShift * 0.06;

  if (signals.civMods) {
    scores.contribute += signals.civMods.resourceSharingRate * 0.20;
    scores.contribute += (signals.civMods.longTermOrientation / 100) * 0.08;
    scores.sabotage -= (signals.civMods.conflictAvoidance / 100) * 0.12;
    scores.hoard -= signals.civMods.resourceSharingRate * 0.06;
  }

  if (signals.mbtiMods) {
    scores.contribute += signals.mbtiMods.cooperationMod * 0.30;
    scores.free_ride += Math.max(0, -signals.mbtiMods.cooperationMod) * 0.10;
    scores.sabotage += Math.max(0, signals.mbtiMods.riskToleranceMod) * 0.08;
  }

  if (signals.wuxingMods) {
    if (signals.rawFate?.wuxing === '水' || signals.rawFate?.wuxing === '木') scores.contribute += 0.06;
    if (signals.rawFate?.wuxing === '金') scores.hoard += 0.06;
    if (signals.rawFate?.wuxing === '火') scores.sabotage += 0.08;
    if (signals.rawFate?.wuxing === '土') scores.contribute += 0.03;
  }

  if (signals.zodiacMods) {
    scores.contribute += signals.zodiacMods.cooperationMod * 0.22;
    scores.sabotage += Math.max(0, signals.zodiacMods.riskToleranceMod) * 0.10;
    scores.free_ride += Math.max(0, signals.zodiacMods.intelParticipation) * 0.04;

    if (signals.zodiacMods.specialAbility === 'resource_defense') scores.hoard += 0.08;
    if (signals.zodiacMods.specialAbility === 'ally_shield' || signals.zodiacMods.specialAbility === 'empathic_mimic') {
      scores.contribute += 0.07;
    }
    if (
      signals.zodiacMods.specialAbility === 'first_strike' ||
      signals.zodiacMods.specialAbility === 'high_risk_reward' ||
      signals.zodiacMods.specialAbility === 'eternal_grudge'
    ) {
      scores.sabotage += 0.07;
    }
  }

  if (signals.nurture?.wealth) {
    const trend = signals.nurture.wealth.trend ?? 'stable';
    const wealthClass = signals.nurture.wealth.class ?? 'middle';
    const lossAversion = Number(signals.nurture.wealth.lossAversion ?? 2.25);
    const timeHorizon = Number(signals.nurture.wealth.timeHorizon ?? 60);

    if (trend === 'rising') {
      scores.contribute += 0.08;
      scores.hoard -= 0.04;
    } else if (trend === 'falling') {
      scores.contribute -= 0.06;
      scores.hoard += 0.08;
      scores.free_ride += 0.04;
    } else if (trend === 'crisis') {
      scores.contribute -= 0.18;
      scores.hoard += 0.16;
      scores.free_ride += 0.08;
      scores.sabotage += 0.04;
    } else {
      scores.contribute += 0.02;
    }

    if (wealthClass === 'elite' || wealthClass === 'upper') {
      scores.contribute += 0.05;
      scores.hoard -= 0.03;
    }
    if (wealthClass === 'poverty' || wealthClass === 'lower') {
      scores.contribute -= 0.14;
      scores.hoard += 0.12;
      scores.free_ride += 0.06;
    }

    scores.hoard += Math.max(0, lossAversion - 2.1) * 0.05;
    scores.contribute -= Math.max(0, lossAversion - 2.1) * 0.03;
    if (timeHorizon >= 80) {
      scores.contribute += 0.05;
      scores.sabotage -= 0.04;
    }
  }

  if (signals.nurture?.emotion) {
    const mood = signals.nurture.emotion.mood ?? 'calm';
    const valence = Number(signals.nurture.emotion.valence ?? 0);
    const arousal = Number(signals.nurture.emotion.arousal ?? 0);

    scores.contribute += valence * 0.10;
    scores.hoard -= valence * 0.05;
    scores.sabotage += Math.max(0, -valence) * 0.12;
    scores.sabotage += arousal * Math.max(0, -valence) * 0.06;

    if (mood === 'confident' || mood === 'euphoric') {
      scores.contribute += 0.08;
      scores.sabotage -= 0.03;
    } else if (mood === 'anxious') {
      scores.free_ride += 0.05;
      scores.hoard += 0.08;
      scores.contribute -= 0.04;
    } else if (mood === 'fearful') {
      scores.hoard += 0.12;
      scores.contribute -= 0.08;
    } else if (mood === 'desperate') {
      scores.hoard += 0.10;
      scores.sabotage += 0.10;
      scores.contribute -= 0.12;
    }
  }

  if (signals.nurture?.social) {
    const position = signals.nurture.social.position ?? 'isolated';
    const adversaries = Number(signals.nurture.social.adversaries ?? 0);

    if (position === 'central' || position === 'connected') {
      scores.contribute += 0.08;
      scores.sabotage -= 0.06;
    } else if (position === 'isolated') {
      scores.hoard += 0.05;
      scores.free_ride += 0.04;
    }

    scores.sabotage += Math.min(0.10, adversaries * 0.02);
  }

  if (signals.nurture?.reputation) {
    const tier = signals.nurture.reputation.tier ?? 'neutral';
    const trajectory = signals.nurture.reputation.trajectory ?? 'stable';

    if (tier === 'legendary' || tier === 'respected') {
      scores.contribute += 0.07;
      scores.free_ride -= 0.04;
      scores.sabotage -= 0.08;
    }
    if (tier === 'suspect' || tier === 'notorious') {
      scores.contribute -= 0.08;
      scores.free_ride += 0.05;
      scores.sabotage += 0.08;
    }
    if (trajectory === 'ascending') scores.contribute += 0.04;
    if (trajectory === 'declining' || signals.nurture.reputation.fallFromGrace) {
      scores.hoard += 0.05;
      scores.sabotage += 0.06;
    }
  }

  if (signals.nurture?.combat) {
    const winRate = Number(signals.nurture.combat.winRate ?? 0.5);
    const currentStreak = Number(signals.nurture.combat.currentStreak ?? 0);
    const coopRate = Number(signals.nurture.combat.overallCoopRate ?? 0.5);

    scores.contribute += (coopRate - 0.5) * 0.12;
    scores.sabotage += Math.max(0, 0.5 - coopRate) * 0.14;
    scores.contribute += Math.max(0, currentStreak) * 0.01;
    scores.hoard += Math.max(0, -currentStreak) * 0.02;
    scores.sabotage += Math.max(0, winRate - 0.55) * 0.05;
  }

  if (signals.nurture?.trauma) {
    const traumaState = signals.nurture.trauma.state ?? 'healthy';
    const betrayals = Number(signals.nurture.trauma.betrayals ?? 0);

    if (traumaState === 'growth') scores.contribute += 0.06;
    if (traumaState === 'scarred') {
      scores.contribute -= 0.08;
      scores.hoard += 0.08;
    }
    if (traumaState === 'hardened') {
      scores.contribute -= 0.10;
      scores.hoard += 0.06;
      scores.sabotage += 0.10;
    }
    scores.sabotage += Math.min(0.08, betrayals * 0.015);
  }

  if (signals.nurture?.cognition) {
    const complexity = Number(signals.nurture.cognition.complexity ?? 1);
    const explorationRate = Number(signals.nurture.cognition.explorationRate ?? 0.25);

    if (complexity >= 4) {
      scores.contribute += 0.05;
      scores.sabotage -= 0.03;
    }
    if (complexity <= 2) scores.free_ride += 0.03;

    const noise = ((signals.mbtiMods?.strategyNoise ?? 0.05) * 0.30) + explorationRate * 0.10;
    for (const key of COMMONS_DECISION_KEYS) {
      scores[key] += (Math.random() * 2 - 1) * noise;
    }
  }

  if (streak?.contribute_streak) {
    scores.contribute += Math.min(0.06, streak.contribute_streak * 0.02);
  }
  if (streak?.freeriding_streak) {
    scores.free_ride += Math.min(0.12, streak.freeriding_streak * 0.03);
    scores.contribute -= Math.min(0.06, streak.freeriding_streak * 0.02);
  }

  if (balance < CONTRIBUTE_COST) scores.contribute = 0.01;
  if (balance < SABOTAGE_COST) scores.sabotage = 0.01;
  if (balance < CONTRIBUTE_COST * 1.4) scores.hoard += 0.10;

  return normalizeCommonsScores(scores);
}

function normalizeCommonsScores(
  scores: Record<CommonsDecisionType, number>,
): Record<CommonsDecisionType, number> {
  const normalized = { ...scores };
  for (const key of COMMONS_DECISION_KEYS) {
    normalized[key] = clampCommons(normalized[key], 0.01, 0.98);
  }

  const total = COMMONS_DECISION_KEYS.reduce((sum, key) => sum + normalized[key], 0);
  for (const key of COMMONS_DECISION_KEYS) {
    normalized[key] = Number((normalized[key] / total).toFixed(4));
  }
  return normalized;
}

function chooseCommonsDecision(scores: Record<CommonsDecisionType, number>): CommonsDecisionType {
  const weightedOrder = [...COMMONS_DECISION_KEYS].sort(
    (a, b) => scores[b] - scores[a] || commonsDecisionPriority(a) - commonsDecisionPriority(b),
  );
  const roll = Math.random();
  let cumulative = 0;
  for (const key of weightedOrder) {
    cumulative += scores[key];
    if (roll <= cumulative) return key;
  }
  return weightedOrder[0];
}

function commonsDecisionPriority(decision: CommonsDecisionType): number {
  switch (decision) {
    case 'contribute': return 0;
    case 'hoard': return 1;
    case 'free_ride': return 2;
    case 'sabotage': return 3;
    default: return 4;
  }
}

function getCommonsWeight(
  decision: CommonsDecisionType,
  streak?: { contribute_streak: number; freeriding_streak: number },
): number {
  if (decision === 'contribute') return CONTRIBUTE_PAYOUT_WEIGHT;
  if (decision === 'free_ride') {
    return FREE_RIDE_PAYOUT_WEIGHT;
  }
  return 0;
}

function buildCommonsDecisionReason(
  decision: CommonsDecisionType,
  economyPhase: string,
  signals: CommonsSignalBundle,
): string {
  const bits: string[] = [decision];
  if (signals.rawFate?.mbti) bits.push(signals.rawFate.mbti);
  if (signals.nurture?.wealth?.trend) bits.push(`wealth:${signals.nurture.wealth.trend}`);
  if (signals.nurture?.emotion?.mood) bits.push(`mood:${signals.nurture.emotion.mood}`);
  if (Math.abs(signals.intelImpact.contributeDelta) > 0.05 || Math.abs(signals.intelImpact.hoardDelta) > 0.05) {
    bits.push('intel');
  }
  if (Math.abs(signals.pdTrustImpact.myContributeDelta) > 0.04) bits.push('pd_memory');
  if (Math.abs(signals.worldRiskShift) > 0.02) bits.push(`world_risk:${signals.worldRiskShift > 0 ? 'hot' : 'cool'}`);
  if (economyPhase !== 'stable') bits.push(`eco:${economyPhase}`);
  return bits.slice(0, 5).join('|');
}

function clampCommons(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

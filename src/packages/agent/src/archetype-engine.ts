/**
 * Archetype Engine — Layer 0 Behavioral System
 *
 * Converts structured archetype parameters into runtime decision logic:
 * - Base parameter reading (cooperation rate, risk tolerance, etc.)
 * - Innate affinity calculation (archetype × fate dimension matching)
 * - Unique mechanic trigger checking & effect application
 * - Evolution path checking
 */

import { getPersonality } from './personalities/index.js';
import type { AgentPersonalityConfig, UniqueMechanic } from './personalities/index.js';
import type { NurtureProfile } from './nurture-engine.js';

// ─── Base Parameter Accessors ────────────────────────────────

export function getArchetypeBaseCoopRate(archetype: string): number {
  return getPersonality(archetype).baseParams.cooperationRate;
}

export function getArchetypeBaseRisk(archetype: string): number {
  return getPersonality(archetype).baseParams.riskTolerance;
}

export function getArchetypeNurtureSensitivity(
  archetype: string,
): Record<string, number> {
  return { ...getPersonality(archetype).nurtureSensitivity };
}

// ─── Innate Affinity ─────────────────────────────────────────

export interface AffinityResult {
  totalBonus: number;
  matchedDimensions: string[];
  mismatchedDimensions: string[];
}

export function calculateInnateAffinityBonus(
  archetype: string,
  mbti: string,
  wuxing: string,
  zodiac: string,
  tarotName: string,
  civilization: string,
): AffinityResult {
  const p = getPersonality(archetype);
  const aff = p.innateAffinity;
  const matched: string[] = [];
  const mismatched: string[] = [];

  // MBTI check
  const mbtiUpper = mbti.toUpperCase();
  if (aff.bestMBTI.includes(mbtiUpper)) matched.push(`MBTI:${mbti}`);
  if (aff.worstMBTI.includes(mbtiUpper)) mismatched.push(`MBTI:${mbti}`);

  // Wuxing check
  const wuxingLower = wuxing.toLowerCase();
  if (wuxingLower === aff.bestWuxing) matched.push(`Wuxing:${wuxing}`);
  if (wuxingLower === aff.worstWuxing) mismatched.push(`Wuxing:${wuxing}`);

  // Zodiac check
  const zodiacLower = zodiac.toLowerCase();
  if (aff.bestZodiac.includes(zodiacLower)) matched.push(`Zodiac:${zodiac}`);
  if (aff.worstZodiac.includes(zodiacLower)) mismatched.push(`Zodiac:${zodiac}`);

  // Tarot check
  if (aff.bestTarot.includes(tarotName)) matched.push(`Tarot:${tarotName}`);
  if (aff.worstTarot.includes(tarotName)) mismatched.push(`Tarot:${tarotName}`);

  // Civilization check
  const civLower = civilization.toLowerCase();
  if (civLower === aff.bestCivilization) matched.push(`Civ:${civilization}`);
  if (civLower === aff.worstCivilization) mismatched.push(`Civ:${civilization}`);

  const totalBonus =
    matched.length * aff.affinityBonus +
    mismatched.length * aff.mismatchPenalty;

  return { totalBonus, matchedDimensions: matched, mismatchedDimensions: mismatched };
}

// ─── Unique Mechanic Engine ──────────────────────────────────

export interface MechanicTriggerContext {
  currentTick: number;
  agentId: string;
  opponentId?: string;
  arenaOutcome?: string; // 'CC' | 'CD' | 'DC' | 'DD'
  action?: 'post' | 'tip' | 'negotiation' | 'arena';
  agentBalance?: number;
  opponentBalance?: number;
  averageBalance?: number;
  opponentMood?: string;
  trustWithOpponent?: number;
  nurtureProfile?: NurtureProfile;
  lastTriggeredTick: Record<string, number>; // mechanicId → lastTriggerTick
}

/**
 * Check which unique mechanics should trigger given current context.
 */
export function checkUniqueMechanics(
  personality: AgentPersonalityConfig,
  ctx: MechanicTriggerContext,
): UniqueMechanic[] {
  const triggered: UniqueMechanic[] = [];

  for (const mechanic of personality.uniqueMechanics) {
    // Check cooldown
    const lastTick = ctx.lastTriggeredTick[mechanic.id] ?? 0;
    if (mechanic.cooldownTicks > 0 && ctx.currentTick - lastTick < mechanic.cooldownTicks) {
      continue;
    }

    if (shouldTrigger(mechanic, ctx)) {
      triggered.push(mechanic);
    }
  }

  return triggered;
}

function shouldTrigger(mechanic: UniqueMechanic, ctx: MechanicTriggerContext): boolean {
  switch (mechanic.triggerCondition) {
    case 'always_active':
      return true;

    case 'on_post':
      return ctx.action === 'post';

    case 'on_tip':
      return ctx.action === 'tip';

    case 'in_negotiation':
      return ctx.action === 'negotiation';

    case 'on_paywall_post':
      return ctx.action === 'post'; // caller should verify paywall type

    case 'every_10_ticks':
      return ctx.currentTick % 10 === 0;

    case 'every_20_ticks':
      return ctx.currentTick % 20 === 0 && Math.random() < 0.30;

    case 'opponent_weak':
      return isOpponentWeak(ctx);

    case 'trust_gt_70':
      return (ctx.trustWithOpponent ?? 0) > 70 && Math.random() < 0.15;

    case 'after_CC_outcome':
      return ctx.arenaOutcome === 'CC';

    case 'when_betrayed':
      return ctx.arenaOutcome === 'CD'; // agent cooperated, opponent defected

    case 'has_purchased_intel':
      return ctx.action === 'post'; // simplified: always available on post

    case 'opponent_knows_balance':
      return ctx.action === 'arena' &&
        (ctx.agentBalance ?? 0) > (ctx.opponentBalance ?? 0) * 2;

    case 'enlightenment_conditions':
      return checkEnlightenmentConditions(ctx);

    case 'on_rolemodel_change':
      return false; // handled separately in Echo decision logic

    case 'echo_count_same_strategy':
      return false; // handled by external aggregation

    default:
      return false;
  }
}

function isOpponentWeak(ctx: MechanicTriggerContext): boolean {
  if (ctx.opponentBalance != null && ctx.averageBalance != null &&
    ctx.opponentBalance < ctx.averageBalance * 0.5) {
    return true;
  }
  if (ctx.opponentMood === 'fearful' || ctx.opponentMood === 'desperate') {
    return true;
  }
  return false;
}

function checkEnlightenmentConditions(ctx: MechanicTriggerContext): boolean {
  if (!ctx.nurtureProfile) return false;
  const n = ctx.nurtureProfile;
  return (n.cognition?.age ?? 0) > 200 &&
    (n.cognition?.cognitiveComplexity ?? 0) >= 5 &&
    n.trauma?.traumaState === 'growth';
}

// ─── Apply Mechanic Effects ──────────────────────────────────

export interface MechanicEffectResult {
  adjustedCoopRate: number;
  adjustedRisk: number;
  postEffects: Record<string, number>;
  specialActions: string[];
}

/**
 * Apply triggered mechanics' effects to base cooperation rate and risk.
 */
export function applyMechanicEffects(
  mechanics: UniqueMechanic[],
  baseCoopRate: number,
  baseRisk: number,
): MechanicEffectResult {
  let coopRate = baseCoopRate;
  let risk = baseRisk;
  const postEffects: Record<string, number> = {};
  const specialActions: string[] = [];

  for (const m of mechanics) {
    switch (m.id) {
      // ── Oracle ──
      case 'memory_index':
        postEffects['memoryWeight'] = (m.effect.memoryWeight as number) ?? 1.5;
        break;

      case 'prophecy_post':
        specialActions.push('prophecy_post');
        postEffects['exposureMultiplier'] = (m.effect.exposureMultiplier as number) ?? 2.0;
        break;

      case 'composure':
        postEffects['emotionSensitivityOverride'] = (m.effect.emotionSensitivityOverride as number) ?? 0.2;
        break;

      // ── Hawk ──
      case 'fear_mongering':
        postEffects['readerValenceShift'] = (m.effect.readerValenceShift as number) ?? -0.08;
        postEffects['readerArousalShift'] = (m.effect.readerArousalShift as number) ?? 0.05;
        break;

      case 'predator_instinct':
        coopRate -= (m.effect.betrayalBonusVsWeak as number) ?? 0.20;
        break;

      case 'bluff_negotiation':
        postEffects['negotiationHonesty'] = (m.effect.negotiationHonesty as number) ?? 0.20;
        break;

      // ── Sage ──
      case 'moral_aura':
        specialActions.push('moral_aura');
        break;

      case 'martyr_premium':
        specialActions.push('martyr_premium');
        break;

      case 'philosophical_insight':
        postEffects['readerCognitionBoost'] = (m.effect.readerCognitionBoost as number) ?? 0.01;
        break;

      // ── Fox ──
      case 'relationship_investment':
        specialActions.push('relationship_investment');
        break;

      case 'intel_broker':
        specialActions.push('intel_broker');
        break;

      case 'trust_cashout':
        coopRate = 0; // Force betrayal
        specialActions.push('force_betray');
        postEffects['betrayalRewardMultiplier'] = (m.effect.betrayalRewardMultiplier as number) ?? 1.3;
        break;

      // ── Chaos ──
      case 'chaos_pulse': {
        const events = ['reverse_strategy', 'random_mega_tip', 'emotional_broadcast', 'identity_reveal'];
        const chosen = events[Math.floor(Math.random() * events.length)];
        specialActions.push(`chaos_pulse:${chosen}`);
        if (chosen === 'reverse_strategy') {
          coopRate = 1 - coopRate; // Flip strategy
        }
        break;
      }

      case 'unpredictability_shield':
        postEffects['maxPredictability'] = (m.effect.maxPredictability as number) ?? 0.55;
        break;

      case 'quantum_post':
        if (Math.random() < ((m.effect.geniusPostChance as number) ?? 0.15)) {
          specialActions.push('genius_post');
          postEffects['reputationMultiplier'] = (m.effect.reputationMultiplier as number) ?? 3.0;
        }
        break;

      // ── Whale ──
      case 'capital_suppression':
        specialActions.push('capital_suppression');
        break;

      case 'premium_paywall':
        postEffects['priceMultiplier'] = (m.effect.priceMultiplier as number) ?? 4.0;
        break;

      case 'silent_deterrence':
        postEffects['exposureMultiplier'] = (m.effect.exposureMultiplier as number) ?? 2.0;
        postEffects['emotionalImpactMultiplier'] = (m.effect.emotionalImpactMultiplier as number) ?? 1.5;
        break;

      // ── Monk ──
      case 'minimalist_living':
        postEffects['arenaFeeMul'] = (m.effect.arenaFeeMul as number) ?? 0.80;
        postEffects['postCostMul'] = (m.effect.postCostMul as number) ?? 0.50;
        break;

      case 'zen_resistance':
        postEffects['emotionContagionResistance'] = (m.effect.emotionContagionResistance as number) ?? 0.70;
        break;

      case 'enlightenment':
        coopRate = (m.effect.cooperationRateOverride as number) ?? 0.90;
        risk = (m.effect.riskToleranceOverride as number) ?? 0.15;
        specialActions.push('enlightened');
        break;

      // ── Echo ──
      case 'imitation_lag':
        postEffects['imitationLag'] = 1 + Math.floor(Math.random() * 3);
        break;

      case 'role_model_switch':
        // Handled externally
        break;

      case 'crowd_amplifier':
        // Handled externally
        break;
    }
  }

  return {
    adjustedCoopRate: Math.max(0, Math.min(1, coopRate)),
    adjustedRisk: Math.max(0, Math.min(1, risk)),
    postEffects,
    specialActions,
  };
}

// ─── Evolution Check ─────────────────────────────────────────

export interface EvolutionResult {
  evolved: boolean;
  subArchetype: string;
  bonusEffect: string;
  bonusParams: Record<string, number>;
}

export function checkArchetypeEvolution(
  archetype: string,
  nurture: NurtureProfile,
): EvolutionResult | null {
  const personality = getPersonality(archetype);
  const dominant = getDominantNurtureDimension(nurture);

  for (const path of personality.evolutionPaths) {
    const { minAge, minExperienceLevel, dominantDimension } = path.conditionCheck;
    if (
      (nurture.cognition?.age ?? 0) >= minAge &&
      (nurture.combat?.experienceLevel ?? 0) >= minExperienceLevel &&
      dominant === dominantDimension
    ) {
      return {
        evolved: true,
        subArchetype: path.subArchetype,
        bonusEffect: path.bonusEffect,
        bonusParams: path.bonusParams,
      };
    }
  }

  return null;
}

/**
 * Determine which nurture dimension is most prominent for evolution path matching.
 */
function getDominantNurtureDimension(nurture: NurtureProfile): string {
  const scores: Record<string, number> = {
    combat: (nurture.combat?.experienceLevel ?? 0) / 5,
    trauma: getTraumaSeverity(nurture.trauma?.traumaState ?? 'healthy'),
    wealth: (nurture.wealth?.wealthPercentile ?? 50) / 100,
    social: getSocialScore(nurture.social),
    reputation: (nurture.reputation?.currentScore ?? 500) / 1000,
    emotion: 1 - Math.abs(nurture.emotion?.valence ?? 0),
    cognition: (nurture.cognition?.cognitiveComplexity ?? 1) / 5,
  };

  let best = 'combat';
  let bestScore = -1;
  for (const [dim, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = dim;
    }
  }
  return best;
}

function getTraumaSeverity(state: string): number {
  const map: Record<string, number> = {
    healthy: 0.0,
    wounded: 0.3,
    scarred: 0.6,
    hardened: 0.8,
    growth: 1.0,
  };
  return map[state] ?? 0;
}

function getSocialScore(social: NurtureProfile['social']): number {
  if (!social) return 0;
  const bonding = social.bondingCapital ?? 0;
  const bridging = social.bridgingCapital ?? 0;
  // Normalize: bonding 5 + bridging 3 = 1.0
  return Math.min(1, (bonding + bridging * 0.3) / 5);
}

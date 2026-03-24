/**
 * Nurture Engine — Acquired/Post-natal Dimension System
 *
 * 7 dimensions that evolve through experience:
 * ① Combat Experience  ② Trauma Memory  ③ Wealth Psychology
 * ④ Social Capital  ⑤ Reputation Trajectory  ⑥ Emotional State  ⑦ Cognitive Maturity
 *
 * Works alongside fate-modifiers.ts (innate) to drive agent decisions.
 */

// ─── Interfaces ─────────────────────────────────────────────

export interface CombatExperience {
  totalMatches: number;
  experienceLevel: 0 | 1 | 2 | 3 | 4 | 5;
  pdExperience: number;
  rgExperience: number;
  iaExperience: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  currentStreak: number;
  longestWinStreak: number;
  longestLoseStreak: number;
  cooperationCount: number;
  betrayalCount: number;
  overallCoopRate: number;
  opponentModels: Record<string, {
    encounters: number;
    predictAccuracy: number;
    lastAction: string;
    coopRate: number;
  }>;
}

export interface TraumaMemory {
  totalBetrayalsReceived: number;
  totalBetrayalsGiven: number;
  betrayalRatio: number;
  traumaState: 'healthy' | 'wounded' | 'scarred' | 'hardened' | 'growth';
  resilience: number;
  forgivenessCapacity: number;
  ptgScore: number;
  ptgDomains: {
    lifeAppreciation: number;
    relatingToOthers: number;
    personalStrength: number;
    newPossibilities: number;
    philosophicalChange: number;
  };
  traumaRecords: Record<string, {
    betrayalCount: number;
    lastBetrayalTick: number;
    trustCeiling: number;
    forgivenessProgress: number;
  }>;
  lastBetrayalTick: number;
  ticksSinceLastBetrayal: number;
}

export interface WealthPsychology {
  currentBalance: number;
  initialBalance: number;
  peakBalance: number;
  troughBalance: number;
  balanceTrend: 'rising' | 'stable' | 'falling' | 'crisis';
  wealthPercentile: number;
  wealthClass: 'elite' | 'upper' | 'middle' | 'lower' | 'poverty';
  lossAversion: number;
  houseMoneyEffect: number;
  scarcityMindset: number;
  timeHorizon: number;
  arenaIncomeRatio: number;
  socialIncomeRatio: number;
  intelIncomeRatio: number;
}

export interface SocialCapital {
  bondingCapital: number;
  bridgingCapital: number;
  adversaries: number;
  networkPosition: 'central' | 'connected' | 'peripheral' | 'isolated';
  clusteringCoefficient: number;
  totalPostCount: number;
  totalReplyCount: number;
  totalTipsSent: number;
  totalTipsReceived: number;
  tipRatio: number;
  averageTrustGiven: number;
  averageTrustReceived: number;
  trustAsymmetry: number;
}

export interface ReputationTrajectory {
  currentScore: number;
  peakScore: number;
  troughScore: number;
  trajectory: 'ascending' | 'stable' | 'declining' | 'volatile';
  tier: 'legendary' | 'respected' | 'neutral' | 'suspect' | 'notorious';
  volatility: number;
  publicCoopRate: number;
  publicBetrayalCount: number;
  fallFromGrace: boolean;
  recoveryProgress: number;
  reputationCeiling: number;
}

export interface EmotionalState {
  valence: number;
  arousal: number;
  mood: 'euphoric' | 'confident' | 'calm' | 'anxious' | 'fearful' | 'desperate';
  moodStability: number;
  lastMoodChangeTick: number;
  contagionSusceptibility: number;
  contagionInfluence: number;
}

export interface CognitiveMaturity {
  learningRate: number;
  discountFactor: number;
  socialPreference: number;
  explorationRate: number;
  metacognitiveAccuracy: number;
  cognitiveComplexity: 1 | 2 | 3 | 4 | 5;
  strategyRepertoire: number;
  age: number;
}

export interface NurtureProfile {
  combat: CombatExperience;
  trauma: TraumaMemory;
  wealth: WealthPsychology;
  social: SocialCapital;
  reputation: ReputationTrajectory;
  emotion: EmotionalState;
  cognition: CognitiveMaturity;
}

export interface NurtureModifiers {
  cooperationMod: number;
  riskMod: number;
  socialFrequencyMod: number;
  arenaEagernessMod: number;
  trustSpeedMod: number;
}

// ─── Defaults ───────────────────────────────────────────────

export const DEFAULT_COMBAT: CombatExperience = {
  totalMatches: 0, experienceLevel: 0,
  pdExperience: 0, rgExperience: 0, iaExperience: 0,
  wins: 0, losses: 0, draws: 0, winRate: 0,
  currentStreak: 0, longestWinStreak: 0, longestLoseStreak: 0,
  cooperationCount: 0, betrayalCount: 0, overallCoopRate: 0.5,
  opponentModels: {},
};

export const DEFAULT_TRAUMA: TraumaMemory = {
  totalBetrayalsReceived: 0, totalBetrayalsGiven: 0, betrayalRatio: 0,
  traumaState: 'healthy', resilience: 0.5, forgivenessCapacity: 0.5,
  ptgScore: 0,
  ptgDomains: { lifeAppreciation: 0, relatingToOthers: 0, personalStrength: 0, newPossibilities: 0, philosophicalChange: 0 },
  traumaRecords: {}, lastBetrayalTick: 0, ticksSinceLastBetrayal: 0,
};

export const DEFAULT_WEALTH: WealthPsychology = {
  currentBalance: 10, initialBalance: 10, peakBalance: 10, troughBalance: 10,
  balanceTrend: 'stable', wealthPercentile: 50, wealthClass: 'middle',
  lossAversion: 2.25, houseMoneyEffect: 0, scarcityMindset: 0, timeHorizon: 60,
  arenaIncomeRatio: 1.0, socialIncomeRatio: 0, intelIncomeRatio: 0,
};

export const DEFAULT_SOCIAL: SocialCapital = {
  bondingCapital: 0, bridgingCapital: 0, adversaries: 0,
  networkPosition: 'isolated', clusteringCoefficient: 0,
  totalPostCount: 0, totalReplyCount: 0,
  totalTipsSent: 0, totalTipsReceived: 0, tipRatio: 0,
  averageTrustGiven: 50, averageTrustReceived: 50, trustAsymmetry: 0,
};

export const DEFAULT_REPUTATION: ReputationTrajectory = {
  currentScore: 500, peakScore: 500, troughScore: 500,
  trajectory: 'stable', tier: 'neutral', volatility: 0,
  publicCoopRate: 0.5, publicBetrayalCount: 0,
  fallFromGrace: false, recoveryProgress: 0, reputationCeiling: 1000,
};

export const DEFAULT_EMOTION: EmotionalState = {
  valence: 0, arousal: 0, mood: 'calm',
  moodStability: 0.5, lastMoodChangeTick: 0,
  contagionSusceptibility: 0.5, contagionInfluence: 0.5,
};

export const DEFAULT_COGNITION: CognitiveMaturity = {
  learningRate: 0.10, discountFactor: 0.80, socialPreference: 0,
  explorationRate: 0.25, metacognitiveAccuracy: 0.3,
  cognitiveComplexity: 1, strategyRepertoire: 2, age: 0,
};

// ─── Archetype Sensitivity Matrix ───────────────────────────

export const ARCHETYPE_NURTURE_SENSITIVITY: Record<string, Record<string, number>> = {
  oracle:  { combat: 1.0, trauma: 0.4, wealth: 0.6, social: 0.4, reputation: 0.6, emotion: 0.2, cognition: 1.0 },
  hawk:    { combat: 0.8, trauma: 0.2, wealth: 1.0, social: 0.2, reputation: 0.4, emotion: 0.4, cognition: 0.4 },
  sage:    { combat: 0.2, trauma: 1.0, wealth: 0.2, social: 0.8, reputation: 0.8, emotion: 1.0, cognition: 0.6 },
  fox:     { combat: 0.6, trauma: 0.6, wealth: 0.6, social: 1.0, reputation: 1.0, emotion: 0.6, cognition: 0.8 },
  chaos:   { combat: 0.4, trauma: 0.4, wealth: 0.4, social: 0.4, reputation: 0.2, emotion: 1.0, cognition: 0.2 },
  whale:   { combat: 0.8, trauma: 0.2, wealth: 1.0, social: 0.4, reputation: 0.6, emotion: 0.2, cognition: 0.8 },
  monk:    { combat: 0.4, trauma: 0.8, wealth: 0.2, social: 0.6, reputation: 0.4, emotion: 0.8, cognition: 1.0 },
  echo:    { combat: 0.6, trauma: 0.6, wealth: 0.6, social: 1.0, reputation: 0.6, emotion: 1.0, cognition: 0.4 },
};

// ─── Per-Dimension Modifier Functions ───────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 1. Combat Experience Modifiers
 * - S-curve accuracy: 0.88 × (1 - e^(-0.08 × matches))
 * - Streak effects: win → conservative, lose ≤3 → risk-seeking, lose >3 → learned helplessness
 */
export function getCombatModifiers(combat: CombatExperience): NurtureModifiers {
  let coopMod = 0;
  let riskMod = 0;
  let socialFreqMod = 0;
  let arenaEagMod = 0;
  const trustSpeedMod = 0;

  // Streak effects
  if (combat.currentStreak > 0) {
    riskMod = -0.05 * combat.currentStreak;  // win streak → conservative
    coopMod = 0.03 * combat.currentStreak;   // winner generosity
    arenaEagMod = -0.05 * Math.min(combat.currentStreak, 5);
  } else if (combat.currentStreak < 0) {
    const losses = Math.abs(combat.currentStreak);
    if (losses <= 3) {
      riskMod = 0.08 * losses;   // short losing → chase losses
      arenaEagMod = 0.10 * losses;
    } else {
      riskMod = -0.15;           // learned helplessness
      coopMod = -0.10;
      arenaEagMod = -0.20;
      socialFreqMod = -0.15;
    }
  }

  // Experience level bonus
  if (combat.experienceLevel >= 4) {
    coopMod += 0.05; // masters understand cooperation value
  }
  if (combat.experienceLevel >= 5) {
    coopMod += 0.05; // legends even more so
  }

  return { cooperationMod: coopMod, riskMod, socialFrequencyMod: socialFreqMod, arenaEagernessMod: arenaEagMod, trustSpeedMod };
}

/**
 * 2. Trauma Memory Modifiers
 */
export function getTraumaModifiers(trauma: TraumaMemory): NurtureModifiers {
  const mods: NurtureModifiers = { cooperationMod: 0, riskMod: 0, socialFrequencyMod: 0, arenaEagernessMod: 0, trustSpeedMod: 0 };

  switch (trauma.traumaState) {
    case 'healthy':
      break;
    case 'wounded':
      mods.cooperationMod = -0.15;
      mods.riskMod = -0.10;
      mods.trustSpeedMod = -0.30; // ×0.7
      mods.socialFrequencyMod = -0.10;
      break;
    case 'scarred':
      mods.cooperationMod = -0.25;
      mods.riskMod = -0.15;
      mods.trustSpeedMod = -0.50; // ×0.5
      mods.socialFrequencyMod = -0.20;
      break;
    case 'hardened':
      mods.cooperationMod = -0.35;
      mods.riskMod = -0.20;
      mods.trustSpeedMod = -0.70; // ×0.3
      mods.socialFrequencyMod = -0.30;
      break;
    case 'growth':
      mods.cooperationMod = 0.05;
      mods.riskMod = 0.05;
      mods.trustSpeedMod = 0.10; // ×1.1
      mods.socialFrequencyMod = 0.10;
      // PTG bonus
      mods.cooperationMod += trauma.ptgScore * 0.02;
      break;
  }

  return mods;
}

/**
 * Trauma vs specific opponent — trust ceiling override
 */
export function getTraumaModifiersVsOpponent(
  trauma: TraumaMemory,
  opponentId: string,
): { cooperationOverride: number | null; trustCeiling: number } {
  const record = trauma.traumaRecords?.[opponentId];
  if (!record) return { cooperationOverride: null, trustCeiling: 100 };

  if (record.trustCeiling < 30) {
    return { cooperationOverride: 0.05, trustCeiling: record.trustCeiling };
  }

  return { cooperationOverride: null, trustCeiling: record.trustCeiling };
}

/**
 * 3. Wealth Psychology Modifiers
 */
export function getWealthModifiers(wealth: WealthPsychology): NurtureModifiers {
  let coopMod = 0;
  let riskMod = 0;
  let arenaEagMod = 0;
  const socialFreqMod = 0;

  // Wealth class effects
  switch (wealth.wealthClass) {
    case 'elite':
      coopMod = 0.05; riskMod = -0.15; arenaEagMod = -0.10; break;
    case 'upper':
      coopMod = 0.03; riskMod = -0.08; break;
    case 'middle':
      break;
    case 'lower':
      coopMod = -0.05; riskMod = 0.10; arenaEagMod = 0.10; break;
    case 'poverty':
      coopMod = -0.15; riskMod = 0.25; arenaEagMod = 0.20; break;
  }

  // Balance trend effects
  switch (wealth.balanceTrend) {
    case 'rising':
      riskMod += -0.08; coopMod += 0.10; arenaEagMod += -0.10; break;
    case 'falling':
      riskMod += 0.12; coopMod += -0.08; arenaEagMod += 0.20; break;
    case 'crisis':
      riskMod += 0.25; coopMod += -0.20; arenaEagMod += 0.30; break;
  }

  // House Money Effect: if balance > peak × 0.8, extra risk
  if (wealth.currentBalance > wealth.peakBalance * 0.8 && wealth.currentBalance > wealth.initialBalance) {
    riskMod += 0.10;
  }

  return { cooperationMod: coopMod, riskMod, socialFrequencyMod: socialFreqMod, arenaEagernessMod: arenaEagMod, trustSpeedMod: 0 };
}

/**
 * 4. Social Capital Modifiers
 */
export function getSocialModifiers(social: SocialCapital): NurtureModifiers {
  const mods: NurtureModifiers = { cooperationMod: 0, riskMod: 0, socialFrequencyMod: 0, arenaEagernessMod: 0, trustSpeedMod: 0 };

  switch (social.networkPosition) {
    case 'central':
      mods.cooperationMod = 0.15; mods.riskMod = -0.10; mods.socialFrequencyMod = 0.20; break;
    case 'connected':
      mods.cooperationMod = 0.08; mods.riskMod = -0.05; mods.socialFrequencyMod = 0.10; break;
    case 'peripheral':
      mods.cooperationMod = -0.05; mods.riskMod = 0.05; mods.socialFrequencyMod = -0.10; break;
    case 'isolated':
      mods.cooperationMod = -0.20; mods.riskMod = 0.15; mods.socialFrequencyMod = -0.25; break;
  }

  // High clustering: in-group cooperation bonus
  if (social.clusteringCoefficient > 0.6) {
    mods.cooperationMod += 0.10; // bias toward cooperation within cluster
  }

  return mods;
}

/**
 * 5. Reputation Trajectory Modifiers
 */
export function getReputationModifiers(rep: ReputationTrajectory): NurtureModifiers {
  const mods: NurtureModifiers = { cooperationMod: 0, riskMod: 0, socialFrequencyMod: 0, arenaEagernessMod: 0, trustSpeedMod: 0 };

  switch (rep.trajectory) {
    case 'ascending':
      mods.cooperationMod = 0.10; mods.riskMod = -0.05; break;
    case 'declining':
      mods.cooperationMod = -0.12; mods.riskMod = 0.10; break;
    case 'volatile':
      mods.cooperationMod = -0.05; mods.riskMod = 0.05; break;
  }

  // Fall from Grace effect
  if (rep.fallFromGrace && rep.recoveryProgress < 0.3) {
    mods.cooperationMod -= 0.30;
    mods.socialFrequencyMod -= 0.50;
  } else if (rep.fallFromGrace && rep.recoveryProgress < 0.7) {
    mods.cooperationMod -= 0.10;
    mods.socialFrequencyMod -= 0.20;
  }

  return mods;
}

/**
 * 6. Emotional State Modifiers
 */
export function getEmotionModifiers(emotion: EmotionalState): NurtureModifiers {
  const mods: NurtureModifiers = { cooperationMod: 0, riskMod: 0, socialFrequencyMod: 0, arenaEagernessMod: 0, trustSpeedMod: 0 };

  switch (emotion.mood) {
    case 'euphoric':
      mods.cooperationMod = 0.20; mods.riskMod = 0.20; mods.socialFrequencyMod = 0.50; mods.arenaEagernessMod = 0.20; break;
    case 'confident':
      mods.cooperationMod = 0.10; mods.riskMod = 0.05; mods.socialFrequencyMod = 0.20; break;
    case 'calm':
      break;
    case 'anxious':
      mods.cooperationMod = -0.10; mods.riskMod = -0.10; mods.socialFrequencyMod = -0.20; break;
    case 'fearful':
      mods.cooperationMod = -0.20; mods.riskMod = -0.20; mods.socialFrequencyMod = -0.50; mods.arenaEagernessMod = -0.20; break;
    case 'desperate':
      mods.cooperationMod = -0.30; mods.riskMod = 0.30; mods.socialFrequencyMod = -0.70; mods.arenaEagernessMod = 0.15; break;
  }

  return mods;
}

/**
 * 7. Cognitive Maturity Modifiers
 */
export function getCognitiveModifiers(cognition: CognitiveMaturity): NurtureModifiers {
  const mods: NurtureModifiers = { cooperationMod: 0, riskMod: 0, socialFrequencyMod: 0, arenaEagernessMod: 0, trustSpeedMod: 0 };

  switch (cognition.cognitiveComplexity) {
    case 1:
      mods.cooperationMod = -0.10; // only sees immediate gain → betray bias
      break;
    case 2:
      mods.cooperationMod = -0.03;
      break;
    case 3:
      mods.cooperationMod = 0.10; // understands trust value
      break;
    case 4:
      mods.cooperationMod = 0.12; mods.riskMod = -0.05;
      break;
    case 5:
      mods.cooperationMod = 0.15; mods.riskMod = -0.08; mods.socialFrequencyMod = 0.10;
      break;
  }

  // Exploration rate adds noise to strategy (will be applied externally)
  // Higher age → less exploration → more predictable

  return mods;
}

// ─── Composite Calculation ──────────────────────────────────

/**
 * Calculate weighted nurture modifiers for an archetype.
 * Sensitivity matrix determines how much each dimension affects this archetype.
 */
export function calculateNurtureModifiers(
  archetype: string,
  nurture: NurtureProfile,
  opponentId?: string,
): NurtureModifiers {
  const sens = ARCHETYPE_NURTURE_SENSITIVITY[archetype] ?? ARCHETYPE_NURTURE_SENSITIVITY['oracle'];

  const dimMods = {
    combat: getCombatModifiers(nurture.combat),
    trauma: getTraumaModifiers(nurture.trauma),
    wealth: getWealthModifiers(nurture.wealth),
    social: getSocialModifiers(nurture.social),
    reputation: getReputationModifiers(nurture.reputation),
    emotion: getEmotionModifiers(nurture.emotion),
    cognition: getCognitiveModifiers(nurture.cognition),
  };

  let coopMod = 0;
  let riskMod = 0;
  let socialFreqMod = 0;
  let arenaEagMod = 0;
  let trustSpeedMod = 0;

  for (const [dim, mod] of Object.entries(dimMods)) {
    const weight = sens[dim] ?? 0.5;
    coopMod += mod.cooperationMod * weight;
    riskMod += mod.riskMod * weight;
    socialFreqMod += mod.socialFrequencyMod * weight;
    arenaEagMod += mod.arenaEagernessMod * weight;
    trustSpeedMod += mod.trustSpeedMod * weight;
  }

  // Opponent-specific trauma override
  if (opponentId) {
    const traumaVs = getTraumaModifiersVsOpponent(nurture.trauma, opponentId);
    if (traumaVs.cooperationOverride !== null) {
      // Trauma so deep it overrides composite — will be applied in decision-engine
    }
  }

  return {
    cooperationMod: clamp(coopMod, -0.50, 0.50),
    riskMod: clamp(riskMod, -0.50, 0.50),
    socialFrequencyMod: clamp(socialFreqMod, -0.80, 0.80),
    arenaEagernessMod: clamp(arenaEagMod, -0.50, 0.50),
    trustSpeedMod: clamp(trustSpeedMod, -0.80, 0.80),
  };
}

// ─── Nurture Prompt Section for LLM ─────────────────────────

export function buildNurturePromptSection(nurture: NurtureProfile, opponentId?: string): string {
  const lines: string[] = [
    '\n## 你的经历（后天维度）',
    `- 战斗经验: ${nurture.combat.experienceLevel}级 (${nurture.combat.totalMatches}场, ${(nurture.combat.winRate * 100).toFixed(0)}%胜率)`,
    `- 创伤状态: ${nurture.trauma.traumaState} (被背叛${nurture.trauma.totalBetrayalsReceived}次)`,
    `- 财富阶层: ${nurture.wealth.wealthClass} (百分位 ${nurture.wealth.wealthPercentile.toFixed(0)}%)`,
    `- 社交地位: ${nurture.social.networkPosition} (${nurture.social.bondingCapital}个密友)`,
    `- 声誉段位: ${nurture.reputation.tier} (${nurture.reputation.currentScore.toFixed(0)}分)`,
    `- 当前情绪: ${nurture.emotion.mood}`,
    `- 认知水平: ${nurture.cognition.cognitiveComplexity}级`,
  ];

  if (opponentId && nurture.trauma.traumaRecords?.[opponentId]) {
    const rec = nurture.trauma.traumaRecords[opponentId];
    lines.push(`\n⚠ 警告：你曾被此对手背叛${rec.betrayalCount}次。信任上限=${rec.trustCeiling}`);
  }

  if (nurture.combat.currentStreak > 3) {
    lines.push(`🔥 当前连胜${nurture.combat.currentStreak}场`);
  } else if (nurture.combat.currentStreak < -3) {
    lines.push(`💀 当前连败${Math.abs(nurture.combat.currentStreak)}场，习得性无助`);
  }

  if (nurture.wealth.balanceTrend === 'crisis') {
    lines.push('🚨 财务危机！极度短视决策模式');
  }

  return lines.join('\n');
}

// ─── Mood Classification Helper ─────────────────────────────

export function classifyMood(valence: number, arousal: number): EmotionalState['mood'] {
  if (valence >= 0.8 && arousal >= 0.8) return 'euphoric';
  if (valence >= 0.4 && arousal >= 0.4) return 'confident';
  if (valence >= -0.2 && arousal <= 0.3) return 'calm';
  if (valence >= -0.4 && arousal >= 0.5) return 'anxious';
  if (valence >= -0.8 && arousal >= 0.7) return 'fearful';
  if (valence < -0.8 && arousal >= 0.9) return 'desperate';
  if (valence < -0.4) return 'fearful';
  return 'calm';
}

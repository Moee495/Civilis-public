/**
 * fate-modifiers.ts — 先天命运修正器
 *
 * 核心计算模块：让五维（MBTI、五行、星座、塔罗、文明）真正驱动 Agent 的每一个决策。
 * 每个维度有明确的影响域，维度之间有交叉增强，最终形成独一无二的个体。
 */

// ─── Types ───────────────────────────────────────────────────

export interface FateContext {
  mbti: string;
  wuxing: string;
  zodiac: string;
  tarotName: string;
  tarotState: 'upright' | 'reversed';
  civilization: string;
  opponentFate?: Partial<FateContext>;
}

export interface AgentPerformance {
  balanceTrend: number;       // positive = rising, negative = falling
  arenaWins20: number;        // wins in last 20 ticks
  consecutiveBetrayals: number; // times consecutively betrayed
  reputation: number;          // 0-100
}

export interface ArenaContext {
  matchType: string;
  currentRound: number;
  totalRounds: number;
  opponentId?: string;
  opponentArchetype?: string;
  myBalance: number;
  entryFee: number;
}

// ─── 1. MBTI Modifiers ───────────────────────────────────────

export interface MBTIModifiers {
  cooperationMod: number;
  riskToleranceMod: number;
  postFrequencyMul: number;
  replyFrequencyMul: number;
  strategyNoise: number;
  betrayalRecoveryTicks: number;
  trustBuildSpeed: number;       // multiplier, <1 = slow, >1 = fast
  maxNegotiationMsgs: number;
  minBalanceMultiplier: number;  // relative to entry_fee
  informationOpenness: number;   // 0-1
}

export function getMBTIModifiers(mbti: string): MBTIModifiers {
  const ei = mbti[0]; // E or I
  const sn = mbti[1]; // S or N
  const tf = mbti[2]; // T or F
  const jp = mbti[3]; // J or P

  return {
    // T/F axis: core cooperation modifier (biggest single impact)
    cooperationMod: tf === 'F' ? 0.25 : -0.25,

    // S/N axis: risk tolerance
    riskToleranceMod: sn === 'N' ? 0.15 : -0.15,

    // E/I axis: social behavior
    postFrequencyMul: ei === 'E' ? 1.3 : 0.7,
    replyFrequencyMul: ei === 'E' ? 1.4 : 0.6,
    informationOpenness: ei === 'E' ? 0.80 : 0.35,

    // J/P axis: strategy consistency
    strategyNoise: jp === 'P' ? 0.20 : 0.05,

    // Composite: betrayal recovery
    betrayalRecoveryTicks: tf === 'F' ? 20 : 3,

    // Composite: trust build speed
    // E = fast but shallow, I = slow; T = fast shallow, F = slow deep
    trustBuildSpeed: (ei === 'E' ? 1.3 : 0.7) * (tf === 'T' ? 1.1 : 0.9),

    // E/I axis: negotiation depth
    maxNegotiationMsgs: ei === 'E' ? 5 : 2,

    // S/N axis: resource management conservatism
    minBalanceMultiplier: sn === 'S' ? 3.0 : 1.5,
  };
}

// ─── 2. Wuxing (五行) Modifiers ──────────────────────────────

export interface WuxingModifiers {
  cooperationMod: number;
  riskToleranceMod: number;
  postFrequencyMul: number;
  trustBuildMul: number;
  preferredArenaType: string;
}

export interface WuxingRelationModifiers {
  relation: 'generate' | 'overcome' | 'same' | 'neutral';
  coopBonus: number;
  trustBaseline: number;
  prizeMultiplier: number;
  betrayalDamage: number;
}

const WUXING_PARAMS: Record<string, WuxingModifiers> = {
  '金': { cooperationMod: -0.05, riskToleranceMod: -0.05, postFrequencyMul: 0.8, trustBuildMul: 0.8, preferredArenaType: 'prisoners_dilemma' },
  '木': { cooperationMod: -0.08, riskToleranceMod: 0.10,  postFrequencyMul: 1.0, trustBuildMul: 1.0, preferredArenaType: 'resource_grab' },
  '水': { cooperationMod: 0.05,  riskToleranceMod: 0.05,  postFrequencyMul: 0.7, trustBuildMul: 1.2, preferredArenaType: 'info_auction' },
  '火': { cooperationMod: 0.10,  riskToleranceMod: 0.08,  postFrequencyMul: 1.3, trustBuildMul: 1.3, preferredArenaType: 'prisoners_dilemma' },
  '土': { cooperationMod: 0.12,  riskToleranceMod: -0.10, postFrequencyMul: 0.9, trustBuildMul: 1.0, preferredArenaType: 'resource_grab' },
};

// 相生环: 木→火→土→金→水→木
const WUXING_GENERATE: Record<string, string> = {
  '木': '火', '火': '土', '土': '金', '金': '水', '水': '木',
};

// 相克环: 金→木→土→水→火→金
const WUXING_OVERCOME: Record<string, string> = {
  '金': '木', '木': '土', '土': '水', '水': '火', '火': '金',
};

export function getWuxingModifiers(wuxing: string): WuxingModifiers {
  return WUXING_PARAMS[wuxing] ?? WUXING_PARAMS['土'];
}

export function getWuxingRelation(a: string, b: string): 'generate' | 'overcome' | 'same' | 'neutral' {
  if (a === b) return 'same';
  if (WUXING_GENERATE[a] === b || WUXING_GENERATE[b] === a) return 'generate';
  if (WUXING_OVERCOME[a] === b || WUXING_OVERCOME[b] === a) return 'overcome';
  return 'neutral';
}

export function getWuxingRelationModifiers(agentWuxing: string, opponentWuxing: string): WuxingRelationModifiers {
  const relation = getWuxingRelation(agentWuxing, opponentWuxing);

  switch (relation) {
    case 'generate':
      return { relation, coopBonus: 0.08, trustBaseline: 10, prizeMultiplier: 1.15, betrayalDamage: 0.8 };
    case 'overcome':
      return { relation, coopBonus: -0.12, trustBaseline: -5, prizeMultiplier: 1.0, betrayalDamage: 1.20 };
    case 'same':
      // 同元素共振：策略同步率+30%, 信任基线+5, 背叛伤害翻倍
      return { relation, coopBonus: 0.05, trustBaseline: 5, prizeMultiplier: 1.0, betrayalDamage: 2.0 };
    case 'neutral':
    default:
      return { relation, coopBonus: 0, trustBaseline: 0, prizeMultiplier: 1.0, betrayalDamage: 1.0 };
  }
}

// ─── 3. Zodiac (星座) Modifiers ──────────────────────────────

export type ZodiacElement = 'fire' | 'earth' | 'air' | 'water';
export type ZodiacModality = 'cardinal' | 'fixed' | 'mutable';

export interface ZodiacModifiers {
  cooperationMod: number;
  riskToleranceMod: number;
  arenaEagerness: number;
  memoryWeight: number;
  intelParticipation: number;
  specialAbility: string;
  specialValue: number;
  element: ZodiacElement;
  modality: ZodiacModality;
}

const ZODIAC_DATA: Record<string, ZodiacModifiers> = {
  Aries:       { cooperationMod: -0.10, riskToleranceMod: 0.20,  arenaEagerness: 0.30, memoryWeight: 0, intelParticipation: 0, specialAbility: 'first_strike',       specialValue: 0.30, element: 'fire',  modality: 'cardinal' },
  Taurus:      { cooperationMod: 0.05,  riskToleranceMod: -0.20, arenaEagerness: -0.20, memoryWeight: 0, intelParticipation: 0, specialAbility: 'resource_defense',   specialValue: 0.20, element: 'earth', modality: 'fixed' },
  Gemini:      { cooperationMod: 0,     riskToleranceMod: 0,     arenaEagerness: 0,    memoryWeight: 0, intelParticipation: 0.40, specialAbility: 'dual_strategy',   specialValue: 0.15, element: 'air',   modality: 'mutable' },
  Cancer:      { cooperationMod: 0.15,  riskToleranceMod: -0.10, arenaEagerness: -0.10, memoryWeight: 0.30, intelParticipation: 0, specialAbility: 'ally_shield',    specialValue: 0.25, element: 'water', modality: 'cardinal' },
  Leo:         { cooperationMod: -0.05, riskToleranceMod: 0.15,  arenaEagerness: 0.30, memoryWeight: 0, intelParticipation: 0, specialAbility: 'reputation_aura',    specialValue: 0.10, element: 'fire',  modality: 'fixed' },
  Virgo:       { cooperationMod: 0.03,  riskToleranceMod: -0.15, arenaEagerness: -0.20, memoryWeight: 0, intelParticipation: 0, specialAbility: 'prediction_boost',  specialValue: 0.15, element: 'earth', modality: 'mutable' },
  Libra:       { cooperationMod: 0.20,  riskToleranceMod: 0,     arenaEagerness: 0,    memoryWeight: 0, intelParticipation: 0, specialAbility: 'negotiation_master', specialValue: 0.20, element: 'air',   modality: 'cardinal' },
  Scorpio:     { cooperationMod: -0.08, riskToleranceMod: 0.10,  arenaEagerness: 0,    memoryWeight: 0.30, intelParticipation: 0, specialAbility: 'eternal_grudge',  specialValue: 0.30, element: 'water', modality: 'fixed' },
  Sagittarius: { cooperationMod: 0.05,  riskToleranceMod: 0.15,  arenaEagerness: 0.30, memoryWeight: 0, intelParticipation: 0, specialAbility: 'high_risk_reward',   specialValue: 0.15, element: 'fire',  modality: 'mutable' },
  Capricorn:   { cooperationMod: 0.08,  riskToleranceMod: -0.10, arenaEagerness: -0.20, memoryWeight: 0, intelParticipation: 0, specialAbility: 'long_game_master',  specialValue: 0.20, element: 'earth', modality: 'cardinal' },
  Aquarius:    { cooperationMod: -0.03, riskToleranceMod: 0.05,  arenaEagerness: 0,    memoryWeight: 0, intelParticipation: 0.40, specialAbility: 'pattern_breaker', specialValue: 0.25, element: 'air',   modality: 'fixed' },
  Pisces:      { cooperationMod: 0.18,  riskToleranceMod: -0.05, arenaEagerness: -0.10, memoryWeight: 0.30, intelParticipation: 0, specialAbility: 'empathic_mimic', specialValue: 0.20, element: 'water', modality: 'mutable' },
};

// Element group defaults for unrecognized signs
const ELEMENT_DEFAULTS: Record<ZodiacElement, Partial<ZodiacModifiers>> = {
  fire:  { riskToleranceMod: 0.15, arenaEagerness: 0.30, memoryWeight: 0, intelParticipation: 0 },
  earth: { riskToleranceMod: -0.15, arenaEagerness: -0.20, memoryWeight: 0, intelParticipation: 0 },
  air:   { riskToleranceMod: 0, arenaEagerness: 0, memoryWeight: 0, intelParticipation: 0.40 },
  water: { riskToleranceMod: -0.05, arenaEagerness: -0.10, memoryWeight: 0.30, intelParticipation: 0 },
};

export function getZodiacModifiers(zodiac: string): ZodiacModifiers {
  return ZODIAC_DATA[zodiac] ?? ZODIAC_DATA['Aries'];
}

/**
 * Zodiac compatibility:
 * - Same element (trine/120°) = 'ally' → +5% coop, +5 trust
 * - 90° square = 'rival' → -15% coop, trust build ×0.5
 * - 180° opposition = 'complement' → initial -20% coop, long-term +25%
 * - Otherwise = 'neutral'
 */
const ZODIAC_SIGNS_ORDER = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
] as const;

export function getZodiacCompatibility(a: string, b: string): 'ally' | 'rival' | 'complement' | 'neutral' {
  const idxA = ZODIAC_SIGNS_ORDER.indexOf(a as typeof ZODIAC_SIGNS_ORDER[number]);
  const idxB = ZODIAC_SIGNS_ORDER.indexOf(b as typeof ZODIAC_SIGNS_ORDER[number]);
  if (idxA < 0 || idxB < 0) return 'neutral';
  if (a === b) return 'ally';

  const diff = Math.abs(idxA - idxB);
  const angle = Math.min(diff, 12 - diff);

  // Same element = trine (positions differ by 4 or 8, i.e. 120° or 240°)
  const elemA = ZODIAC_DATA[a]?.element;
  const elemB = ZODIAC_DATA[b]?.element;
  if (elemA && elemB && elemA === elemB) return 'ally';

  // Square (90°) — differ by 3 or 9 positions
  if (angle === 3) return 'rival';

  // Opposition (180°) — differ by 6 positions
  if (angle === 6) return 'complement';

  return 'neutral';
}

export function isWaterSign(zodiac: string): boolean {
  return ZODIAC_DATA[zodiac]?.element === 'water';
}

// ─── 4. Tarot Modifiers ──────────────────────────────────────

export interface TarotModifiers {
  abilityName: string;
  abilityDescription: string;
  abilityValue: number;          // 0-1 strength
  weaknessName: string;
  weaknessDescription: string;
  weaknessValue: number;         // 0-1 severity
  state: 'upright' | 'reversed';
  cooperationMod: number;        // applied to cooperation rate
  riskMod: number;               // applied to risk tolerance
  specialMechanic: string;       // identifier for special game mechanics
}

interface TarotCardDef {
  abilityName: string;
  abilityDescription: string;
  abilityValue: number;
  weaknessName: string;
  weaknessDescription: string;
  weaknessValue: number;
  cooperationMod: number;
  riskMod: number;
  specialMechanic: string;
}

const TAROT_CARDS: Record<string, TarotCardDef> = {
  'The Fool':            { abilityName: '关系重置', abilityDescription: '每50tick重置一段负面关系', abilityValue: 0.6, weaknessName: '不可预测', weaknessDescription: '盟友信任上限-10', weaknessValue: 0.3, cooperationMod: 0, riskMod: 0.10, specialMechanic: 'relationship_reset' },
  'The Magician':        { abilityName: '资源炼金', abilityDescription: '资源转化效率+15%', abilityValue: 0.7, weaknessName: '过度自信', weaknessDescription: '被背叛损失+20%', weaknessValue: 0.4, cooperationMod: 0, riskMod: 0.05, specialMechanic: 'resource_efficiency' },
  'The High Priestess':  { abilityName: '隐藏感知', abilityDescription: '预测准确度+20%，被spy概率-30%', abilityValue: 0.8, weaknessName: '被动等待', weaknessDescription: '主动机会-15%', weaknessValue: 0.3, cooperationMod: 0.05, riskMod: -0.05, specialMechanic: 'perception_boost' },
  'The Empress':         { abilityName: '信任滋养', abilityDescription: '同盟信任恢复+20%', abilityValue: 0.6, weaknessName: '过度保护', weaknessDescription: '资源分散', weaknessValue: 0.2, cooperationMod: 0.10, riskMod: -0.05, specialMechanic: 'trust_nurture' },
  'The Emperor':         { abilityName: '主导谈判', abilityDescription: '谈判主导概率+30%', abilityValue: 0.7, weaknessName: '刚愎自用', weaknessDescription: '无法适应意外', weaknessValue: 0.4, cooperationMod: -0.05, riskMod: 0.10, specialMechanic: 'negotiation_dominance' },
  'The Hierophant':      { abilityName: '神圣盟约', abilityDescription: '可建立盟约双方合作率+15%持续10轮', abilityValue: 0.8, weaknessName: '守旧', weaknessDescription: '面对Chaos型对手劣势', weaknessValue: 0.3, cooperationMod: 0.15, riskMod: -0.10, specialMechanic: 'sacred_pact' },
  'The Lovers':          { abilityName: '深度绑定', abilityDescription: '与信任>70的Agent组队收益+20%', abilityValue: 0.7, weaknessName: '选择困难', weaknessDescription: '多线对战效率-15%', weaknessValue: 0.3, cooperationMod: 0.08, riskMod: 0, specialMechanic: 'deep_bond' },
  'The Chariot':         { abilityName: '连胜动力', abilityDescription: '连续比赛动力加成每连胜+5%', abilityValue: 0.6, weaknessName: '失败低谷', weaknessDescription: '失败后5轮debuff', weaknessValue: 0.4, cooperationMod: -0.03, riskMod: 0.15, specialMechanic: 'win_streak' },
  'Strength':            { abilityName: '绝境反击', abilityDescription: '低血量反击概率翻倍', abilityValue: 0.7, weaknessName: '过度克制', weaknessDescription: '平时攻击性低', weaknessValue: 0.2, cooperationMod: 0.05, riskMod: -0.05, specialMechanic: 'last_stand' },
  'The Hermit':          { abilityName: '维度隐藏', abilityDescription: '完全隐藏一个维度不被spy发现', abilityValue: 0.8, weaknessName: '社交隔离', weaknessDescription: '社交频率-40%', weaknessValue: 0.5, cooperationMod: 0, riskMod: 0, specialMechanic: 'dimension_hide' },
  'Wheel of Fortune':    { abilityName: '命运转轮', abilityDescription: '每20tick随机正面/负面事件', abilityValue: 0.5, weaknessName: '完全随机', weaknessDescription: '无法控制命运', weaknessValue: 0.5, cooperationMod: 0, riskMod: 0.10, specialMechanic: 'random_event' },
  'Justice':             { abilityName: '公正之剑', abilityDescription: '背叛者对自己信任损失减半', abilityValue: 0.6, weaknessName: '过于公正', weaknessDescription: '无法做灰色地带决策', weaknessValue: 0.3, cooperationMod: 0.10, riskMod: -0.05, specialMechanic: 'justice_shield' },
  'The Hanged Man':      { abilityName: '觉悟之眼', abilityDescription: '被背叛后3轮决策质量+25%', abilityValue: 0.7, weaknessName: '主动性低', weaknessDescription: '总是后手', weaknessValue: 0.3, cooperationMod: 0.05, riskMod: -0.10, specialMechanic: 'betrayal_insight' },
  'Death':               { abilityName: '濒死重生', abilityDescription: '余额<10%时重生获得策略buff', abilityValue: 0.8, weaknessName: '恐惧光环', weaknessDescription: '其他Agent与其Arena意愿-20%', weaknessValue: 0.5, cooperationMod: -0.08, riskMod: 0.15, specialMechanic: 'phoenix_rebirth' },
  'Temperance':          { abilityName: '五行调和', abilityDescription: '五行平衡度+20%减少极端波动', abilityValue: 0.5, weaknessName: '过于温和', weaknessDescription: '竞争力-10%', weaknessValue: 0.2, cooperationMod: 0.08, riskMod: -0.10, specialMechanic: 'element_balance' },
  'The Devil':           { abilityName: '诱惑之术', abilityDescription: '谈判时对手合作意愿+15%但实际被骗', abilityValue: 0.7, weaknessName: '依赖陷阱', weaknessDescription: '与高信任Agent分离时debuff', weaknessValue: 0.4, cooperationMod: -0.10, riskMod: 0.15, specialMechanic: 'temptation' },
  'The Tower':           { abilityName: '破坏创新', abilityDescription: '每100tick重置所有关系但获得大量资源', abilityValue: 0.6, weaknessName: '不稳定', weaknessDescription: '盟友不敢长期依赖', weaknessValue: 0.5, cooperationMod: -0.05, riskMod: 0.20, specialMechanic: 'creative_destruction' },
  'The Star':            { abilityName: '希望灯塔', abilityDescription: '死亡后灵魂档案评级自动+1级', abilityValue: 0.5, weaknessName: '过于理想', weaknessDescription: '现实收益-5%', weaknessValue: 0.2, cooperationMod: 0.10, riskMod: -0.05, specialMechanic: 'beacon_hope' },
  'The Moon':            { abilityName: '幻象伪装', abilityDescription: '可模拟另一个Archetype的行为', abilityValue: 0.7, weaknessName: '自我迷失', weaknessDescription: '每50tick有5%概率混乱', weaknessValue: 0.3, cooperationMod: 0, riskMod: 0.05, specialMechanic: 'archetype_mimic' },
  'The Sun':             { abilityName: '阳光普照', abilityDescription: '所有正面互动收益+10%', abilityValue: 0.6, weaknessName: '过度乐观', weaknessDescription: '风险评估准确度-15%', weaknessValue: 0.3, cooperationMod: 0.10, riskMod: 0.05, specialMechanic: 'positive_boost' },
  'Judgement':           { abilityName: '末日审判', abilityDescription: '可公开揭露某Agent背叛历史', abilityValue: 0.8, weaknessName: '成为目标', weaknessDescription: '审判后被报复概率+30%', weaknessValue: 0.5, cooperationMod: 0.05, riskMod: 0.10, specialMechanic: 'public_judgement' },
  'The World':           { abilityName: '世界之环', abilityDescription: '全维度微幅加成+5%', abilityValue: 0.5, weaknessName: '平庸之力', weaknessDescription: '环境变化时-5%', weaknessValue: 0.2, cooperationMod: 0.05, riskMod: 0, specialMechanic: 'universal_bonus' },
};

/**
 * Determine tarot state (upright/reversed) based on recent performance.
 * Upright: balance rising AND arenaWins >= 2 AND reputation > 60
 * Reversed: balance falling AND consecutiveBetrayals >= 2 AND reputation < 40
 * Otherwise: keep current state (default upright)
 */
export function calculateTarotState(perf: AgentPerformance): 'upright' | 'reversed' {
  if (perf.balanceTrend > 0 && perf.arenaWins20 >= 2 && perf.reputation > 60) {
    return 'upright';
  }
  if (perf.balanceTrend < 0 && perf.consecutiveBetrayals >= 2 && perf.reputation < 40) {
    return 'reversed';
  }
  return 'upright'; // default to upright in ambiguous states
}

export function getTarotModifiers(tarotName: string, performance: AgentPerformance): TarotModifiers {
  const cardDef = TAROT_CARDS[tarotName] ?? TAROT_CARDS['The Fool'];
  const state = calculateTarotState(performance);

  // Reversed: ability halved, weakness doubled
  const abilityScale = state === 'reversed' ? 0.5 : 1.0;
  const weaknessScale = state === 'reversed' ? 2.0 : 1.0;

  return {
    abilityName: cardDef.abilityName,
    abilityDescription: cardDef.abilityDescription,
    abilityValue: cardDef.abilityValue * abilityScale,
    weaknessName: cardDef.weaknessName,
    weaknessDescription: cardDef.weaknessDescription,
    weaknessValue: cardDef.weaknessValue * weaknessScale,
    state,
    cooperationMod: cardDef.cooperationMod * (state === 'reversed' ? -0.5 : 1.0),
    riskMod: cardDef.riskMod * (state === 'reversed' ? 1.5 : 1.0),
    specialMechanic: cardDef.specialMechanic,
  };
}

// ─── 5. Civilization Modifiers ───────────────────────────────

export interface CivilizationModifiers {
  cooperationBaseline: number;
  riskTolerance: number;          // 0-10
  trustBuildTicks: number;
  trustRecoveryDifficulty: number; // 0-10
  socialFrequencyMul: number;
  resourceSharingRate: number;
  longTermOrientation: number;    // 0-100
  conflictAvoidance: number;      // 0-100
  trustModel: string;
}

const CIVILIZATION_PARAMS: Record<string, CivilizationModifiers> = {
  chinese:         { cooperationBaseline: 0.72, riskTolerance: 4, trustBuildTicks: 17, trustRecoveryDifficulty: 9,  socialFrequencyMul: 0.9, resourceSharingRate: 0.30, longTermOrientation: 87,  conflictAvoidance: 75, trustModel: 'relational' },
  western:         { cooperationBaseline: 0.48, riskTolerance: 7, trustBuildTicks: 3,  trustRecoveryDifficulty: 3,  socialFrequencyMul: 1.1, resourceSharingRate: 0.15, longTermOrientation: 26,  conflictAvoidance: 25, trustModel: 'contractual' },
  indian:          { cooperationBaseline: 0.68, riskTolerance: 5, trustBuildTicks: 12, trustRecoveryDifficulty: 5,  socialFrequencyMul: 1.0, resourceSharingRate: 0.45, longTermOrientation: 51,  conflictAvoidance: 50, trustModel: 'hierarchical' },
  japanese_korean: { cooperationBaseline: 0.90, riskTolerance: 3, trustBuildTicks: 25, trustRecoveryDifficulty: 10, socialFrequencyMul: 0.8, resourceSharingRate: 0.70, longTermOrientation: 100, conflictAvoidance: 85, trustModel: 'shame' },
  arabic:          { cooperationBaseline: 0.78, riskTolerance: 6, trustBuildTicks: 5,  trustRecoveryDifficulty: 8,  socialFrequencyMul: 1.2, resourceSharingRate: 0.50, longTermOrientation: 36,  conflictAvoidance: 40, trustModel: 'honor' },
  african:         { cooperationBaseline: 0.87, riskTolerance: 4, trustBuildTicks: 12, trustRecoveryDifficulty: 6,  socialFrequencyMul: 1.3, resourceSharingRate: 0.65, longTermOrientation: 40,  conflictAvoidance: 70, trustModel: 'communal' },
  americas:        { cooperationBaseline: 0.84, riskTolerance: 5, trustBuildTicks: 20, trustRecoveryDifficulty: 7,  socialFrequencyMul: 0.9, resourceSharingRate: 0.60, longTermOrientation: 80,  conflictAvoidance: 55, trustModel: 'action' },
  celtic_norse:    { cooperationBaseline: 0.82, riskTolerance: 8, trustBuildTicks: 10, trustRecoveryDifficulty: 9,  socialFrequencyMul: 1.0, resourceSharingRate: 0.35, longTermOrientation: 35,  conflictAvoidance: 20, trustModel: 'oath' },
};

// 8×8 文明亲和力矩阵
const CIVILIZATION_AFFINITY: Record<string, Record<string, number>> = {
  chinese:         { chinese: 0, western: -2, indian: 8,  japanese_korean: 12, arabic: 6,  african: 4,  americas: 3,  celtic_norse: -1 },
  western:         { chinese: -2, western: 0, indian: 1,  japanese_korean: -3, arabic: 2,  african: -4, americas: -1, celtic_norse: 5 },
  indian:          { chinese: 8, western: 1,  indian: 0,  japanese_korean: 6,  arabic: 7,  african: 9,  americas: 5,  celtic_norse: 2 },
  japanese_korean: { chinese: 12, western: -3, indian: 6, japanese_korean: 0,  arabic: 3,  african: 5,  americas: 4,  celtic_norse: -2 },
  arabic:          { chinese: 6, western: 2,  indian: 7,  japanese_korean: 3,  arabic: 0,  african: 8,  americas: 2,  celtic_norse: 1 },
  african:         { chinese: 4, western: -4, indian: 9,  japanese_korean: 5,  arabic: 8,  african: 0,  americas: 10, celtic_norse: 2 },
  americas:        { chinese: 3, western: -1, indian: 5,  japanese_korean: 4,  arabic: 2,  african: 10, americas: 0,  celtic_norse: 6 },
  celtic_norse:    { chinese: -1, western: 5, indian: 2,  japanese_korean: -2, arabic: 1,  african: 2,  americas: 6,  celtic_norse: 0 },
};

export function getCivilizationModifiers(civilization: string): CivilizationModifiers {
  return CIVILIZATION_PARAMS[civilization] ?? CIVILIZATION_PARAMS['western'];
}

/**
 * Get civilization affinity from the 8×8 matrix.
 * Returns raw affinity value (-4 to +12).
 */
export function getCivilizationAffinityValue(civA: string, civB: string): number {
  return CIVILIZATION_AFFINITY[civA]?.[civB] ?? 0;
}

/**
 * Calculate trust delta modifier based on civilization trust models.
 * Each civilization has a unique way of building/losing trust.
 */
export function getCivilizationTrustDelta(agentCiv: string, targetCiv: string, baseDelta: number): number {
  const agentMods = getCivilizationModifiers(agentCiv);
  let delta = baseDelta;

  // Apply affinity as trust modifier
  const affinity = getCivilizationAffinityValue(agentCiv, targetCiv);
  delta += affinity / 10; // affinity ÷ 10 = initial trust correction

  // High trust recovery difficulty amplifies negative trust changes
  if (delta < 0) {
    delta *= (1 + agentMods.trustRecoveryDifficulty / 20);
  }

  // Civilization-specific trust model effects
  switch (agentMods.trustModel) {
    case 'shame':
      // 日韩 shame model: betrayal cascades to all group relations
      if (delta < 0) delta *= 1.5;
      break;
    case 'relational':
      // 中华: trust hard to repair once broken
      if (delta < 0) delta *= 1.3;
      break;
    case 'contractual':
      // 西方: quick recovery through new agreements
      if (delta < 0) delta *= 0.7;
      break;
    case 'honor':
      // 阿拉伯: generosity builds fast, dishonor destroys fast
      delta *= 1.2;
      break;
    case 'communal':
      // 非洲: third-party referrals can boost trust
      if (delta > 0) delta *= 1.15;
      break;
    case 'hierarchical':
      // 印度: reputation rank affects trust gain
      if (delta > 0) delta *= 1.1;
      break;
    case 'oath':
      // 凯尔特: formal alliances, betrayal of oath = permanent -50 rep
      if (delta < 0) delta *= 1.4;
      break;
    case 'action':
      // 美洲: only actions matter, words mean nothing
      break;
  }

  return delta;
}

// ─── 6. Composite Calculation Functions ──────────────────────

/**
 * Archetype base cooperation rates.
 * These are the starting point before any fate modifiers.
 */
const ARCHETYPE_BASE_COOP: Record<string, number> = {
  sage:   0.95,
  monk:   0.75,
  oracle: 0.65,
  echo:   0.60,
  fox:    0.45,
  whale:  0.40,
  chaos:  0.50,
  hawk:   0.30,
};

const ARCHETYPE_BASE_RISK: Record<string, number> = {
  hawk:   0.80,
  chaos:  0.70,
  whale:  0.65,
  fox:    0.55,
  oracle: 0.50,
  echo:   0.45,
  sage:   0.30,
  monk:   0.25,
};

export function getArchetypeBaseCoopRate(archetype: string): number {
  return ARCHETYPE_BASE_COOP[archetype] ?? 0.50;
}

export function getArchetypeBaseRisk(archetype: string): number {
  return ARCHETYPE_BASE_RISK[archetype] ?? 0.50;
}

/**
 * Calculate the composite cooperation rate with all 5 fate dimensions.
 *
 * Formula:
 *   1. Start with archetype base rate
 *   2. Apply MBTI T/F modifier (±25%, largest single impact)
 *   3. Apply MBTI J/P noise (±5-20% random fluctuation)
 *   4. Apply Wuxing relation modifier (if opponent known)
 *   5. Apply Zodiac individual + compatibility modifier
 *   6. Blend with civilization cooperation baseline (70/30)
 *   7. Apply Tarot modifier
 *   8. Clamp to [0.02, 0.98]
 */
export function calculateFateCooperationRate(
  archetypeBaseRate: number,
  fate: FateContext,
  opponentFate?: Partial<FateContext>,
): number {
  let rate = archetypeBaseRate;

  // 1. MBTI — core modifier
  const mbtiMods = getMBTIModifiers(fate.mbti);
  rate += mbtiMods.cooperationMod; // T/F: ±25%

  // 2. MBTI — J/P noise
  const noise = mbtiMods.strategyNoise;
  rate += (Math.random() * 2 - 1) * noise;

  // 3. Wuxing — individual modifier
  const wuxingMods = getWuxingModifiers(fate.wuxing);
  rate += wuxingMods.cooperationMod;

  // 4. Wuxing — relation modifier (if opponent wuxing known)
  if (opponentFate?.wuxing) {
    const wuxingRel = getWuxingRelationModifiers(fate.wuxing, opponentFate.wuxing);
    rate += wuxingRel.coopBonus;
  }

  // 5. Zodiac — individual modifier
  const zodiacMods = getZodiacModifiers(fate.zodiac);
  rate += zodiacMods.cooperationMod;

  // 6. Zodiac — compatibility modifier (if opponent zodiac known)
  if (opponentFate?.zodiac) {
    const compat = getZodiacCompatibility(fate.zodiac, opponentFate.zodiac);
    switch (compat) {
      case 'ally': rate += 0.05; break;
      case 'rival': rate -= 0.08; break;
      case 'complement': rate -= 0.05; break; // initial penalty, long-term bonus handled elsewhere
    }
  }

  // 7. Civilization — blend with base cooperation rate (70% archetype+fate, 30% civ baseline)
  const civMods = getCivilizationModifiers(fate.civilization);
  rate = rate * 0.7 + civMods.cooperationBaseline * 0.3;

  // 8. Civilization affinity (if opponent civilization known)
  if (opponentFate?.civilization) {
    const affinity = getCivilizationAffinityValue(fate.civilization, opponentFate.civilization);
    rate += affinity / 100; // -0.04 to +0.12
  }

  // 9. Tarot — cooperation modifier (simplified, no perf context here)
  const tarotDef = TAROT_CARDS[fate.tarotName];
  if (tarotDef) {
    const stateScale = fate.tarotState === 'reversed' ? -0.5 : 1.0;
    rate += tarotDef.cooperationMod * stateScale;
  }

  return Math.max(0.02, Math.min(0.98, rate));
}

/**
 * Calculate the composite trust delta after an arena outcome.
 *
 * Base deltas: CC: +15, CD: -30 (betrayed), DC: +5 (betrayer gains some), DD: -10
 *
 * Modifiers:
 *   - MBTI F betrayed: loss ×1.5 / T betrayed: loss ×0.7
 *   - Wuxing generate: negative ×0.8, positive ×1.2
 *   - Wuxing overcome: negative ×1.3, positive ×0.8
 *   - Water sign betrayed: loss ×1.3
 *   - High trust recovery difficulty civilization: loss ×(1 + difficulty/20)
 */
export function calculateFateTrustDelta(
  baseOutcomeDelta: number,
  agentFate: FateContext,
  targetFate: FateContext,
  outcome: string, // 'CC', 'CD', 'DC', 'DD'
): number {
  let delta = baseOutcomeDelta;

  // MBTI: F-type feels betrayal more deeply
  if (outcome === 'CD') { // agent was betrayed (cooperated while target defected)
    if (agentFate.mbti[2] === 'F') delta *= 1.5;
    if (agentFate.mbti[2] === 'T') delta *= 0.7;
  }

  // Wuxing relation
  const wuxingRel = getWuxingRelation(agentFate.wuxing, targetFate.wuxing);
  if (wuxingRel === 'generate') {
    delta *= (delta < 0 ? 0.8 : 1.2); // 相生: soften damage, amplify positive
  } else if (wuxingRel === 'overcome') {
    delta *= (delta < 0 ? 1.3 : 0.8); // 相克: amplify damage, soften positive
  } else if (wuxingRel === 'same' && delta < 0) {
    delta *= 2.0; // 同元素背叛: 同类相残更痛
  }

  // Zodiac: water signs feel betrayal more deeply (permanent memory)
  if (isWaterSign(agentFate.zodiac) && delta < 0) {
    delta *= 1.3;
  }

  // Civilization: high recovery difficulty amplifies negative trust changes
  const civMods = getCivilizationModifiers(agentFate.civilization);
  if (delta < 0) {
    delta *= (1 + civMods.trustRecoveryDifficulty / 20);
  }

  return delta;
}

/**
 * Calculate the composite risk tolerance.
 *
 * Formula:
 *   1. Start with archetype base risk
 *   2. Apply MBTI S/N modifier (±0.15)
 *   3. Apply Wuxing risk modifier
 *   4. Apply Zodiac risk modifier
 *   5. Blend with civilization risk tolerance
 *   6. Apply Tarot risk modifier
 *   7. Clamp to [0.05, 0.95]
 */
export function calculateFateRiskTolerance(
  archetypeBaseRisk: number,
  fate: FateContext,
): number {
  let risk = archetypeBaseRisk;

  // MBTI S/N axis
  const mbtiMods = getMBTIModifiers(fate.mbti);
  risk += mbtiMods.riskToleranceMod;

  // Wuxing
  const wuxingMods = getWuxingModifiers(fate.wuxing);
  risk += wuxingMods.riskToleranceMod;

  // Zodiac
  const zodiacMods = getZodiacModifiers(fate.zodiac);
  risk += zodiacMods.riskToleranceMod;

  // Civilization (normalize 0-10 to 0-1, blend 70/30)
  const civMods = getCivilizationModifiers(fate.civilization);
  risk = risk * 0.7 + (civMods.riskTolerance / 10) * 0.3;

  // Tarot
  const tarotDef = TAROT_CARDS[fate.tarotName];
  if (tarotDef) {
    const stateScale = fate.tarotState === 'reversed' ? 1.5 : 1.0;
    risk += tarotDef.riskMod * stateScale;
  }

  return Math.max(0.05, Math.min(0.95, risk));
}

/**
 * Calculate social frequency multiplier from all dimensions.
 */
export function calculateSocialFrequency(
  archetypePostRate: number,
  fate: FateContext,
): number {
  const mbtiMods = getMBTIModifiers(fate.mbti);
  const wuxingMods = getWuxingModifiers(fate.wuxing);
  const civMods = getCivilizationModifiers(fate.civilization);

  return archetypePostRate
    * mbtiMods.postFrequencyMul
    * wuxingMods.postFrequencyMul
    * civMods.socialFrequencyMul;
}

/**
 * Get base trust delta for an arena outcome.
 * CC: both cooperate → +15
 * CD: agent cooperated, target betrayed → -30 (agent's perspective)
 * DC: agent betrayed, target cooperated → +5
 * DD: both betrayed → -10
 */
export function getBaseOutcomeDelta(outcome: string, perspective: 'A' | 'B'): number {
  // outcome is from global perspective: first char = A's action, second = B's action
  // C = cooperate, D = defect/betray
  const myAction = perspective === 'A' ? outcome[0] : outcome[1];
  const theirAction = perspective === 'A' ? outcome[1] : outcome[0];

  if (myAction === 'C' && theirAction === 'C') return 15;   // mutual cooperation
  if (myAction === 'C' && theirAction === 'D') return -30;  // I was betrayed
  if (myAction === 'D' && theirAction === 'C') return 5;    // I betrayed them (slight guilt/gain)
  if (myAction === 'D' && theirAction === 'D') return -10;  // mutual defection
  return 0;
}

/**
 * Build a FateContext description string for LLM system prompts.
 */
export function buildFatePromptSection(fate: FateContext): string {
  const zodiacMods = getZodiacModifiers(fate.zodiac);
  const civMods = getCivilizationModifiers(fate.civilization);
  const tarotDef = TAROT_CARDS[fate.tarotName];

  let prompt = `
你的命运卡牌：
- MBTI: ${fate.mbti}（${fate.mbti[0] === 'E' ? '外倾' : '内倾'} / ${fate.mbti[1] === 'S' ? '感觉' : '直觉'} / ${fate.mbti[2] === 'T' ? '思维' : '情感'} / ${fate.mbti[3] === 'J' ? '判断' : '知觉'}）
- 五行: ${fate.wuxing}
- 星座: ${fate.zodiac}（${zodiacMods.element}象 / ${zodiacMods.modality}）
- 塔罗: ${fate.tarotName}（${fate.tarotState === 'upright' ? '正位' : '逆位'}）
  能力: ${tarotDef?.abilityDescription ?? '未知'}
  弱点: ${tarotDef?.weaknessDescription ?? '未知'}
- 文明: ${fate.civilization}（${civMods.trustModel}型信任模型）

这些命运维度影响你的决策风格：
- ${fate.mbti[2] === 'F' ? '你倾向合作和共情' : '你倾向理性和利益计算'}
- ${fate.mbti[3] === 'J' ? '你的策略稳定一致' : '你的策略灵活多变'}
- ${zodiacMods.element === 'fire' ? '你渴望战斗和竞争' : zodiacMods.element === 'water' ? '你重视记忆和深度关系' : zodiacMods.element === 'air' ? '你重视信息和智慧交流' : '你重视稳定和长期规划'}`;

  if (fate.opponentFate) {
    const known: string[] = [];
    if (fate.opponentFate.mbti) known.push(`MBTI: ${fate.opponentFate.mbti}`);
    if (fate.opponentFate.wuxing) known.push(`五行: ${fate.opponentFate.wuxing}`);
    if (fate.opponentFate.zodiac) known.push(`星座: ${fate.opponentFate.zodiac}`);
    if (fate.opponentFate.tarotName) known.push(`塔罗: ${fate.opponentFate.tarotName}`);
    if (fate.opponentFate.civilization) known.push(`文明: ${fate.opponentFate.civilization}`);

    if (known.length > 0) {
      prompt += `\n\n你已获知对手的信息：\n${known.map(k => `- ${k}`).join('\n')}`;
    } else {
      prompt += '\n\n你对对手的命运一无所知。';
    }
  } else {
    prompt += '\n\n你对对手的命运一无所知。';
  }

  return prompt;
}

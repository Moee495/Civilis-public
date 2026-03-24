/**
 * Intel Market V2 — Type definitions and archetype profiles
 */

export const INTEL_PUBLIC_BUYER_THRESHOLD = 3;
export const INTEL_PUBLIC_REVEAL_DELAY_TICKS = 3;
export const INTEL_CONSENSUS_VERIFICATION_THRESHOLD = 3;

// ── 6 Intel Categories ──

export type IntelCategory =
  | 'fate_dimension'      // 命运卡维度 (MBTI/五行/星座/塔罗/文明)
  | 'behavior_pattern'    // 行为模式 (PD历史、Commons倾向、Prediction偏好)
  | 'relationship_map'    // 关系图谱 (谁跟谁信任度高/低)
  | 'economic_forecast'   // 经济预测 (下一轮合作率预测、经济阶段走势)
  | 'price_signal'        // 价格信号 (对OKB/BTC/ETH走势的判断)
  | 'counter_intel';      // 反情报 (谁在窥探谁、谁买了什么情报)

// ── Intel Item (core V2 entity) ──

export interface IntelItem {
  id: number;
  category: IntelCategory;
  producer_agent_id: string;
  subject_agent_id: string | null;    // null for market-wide intel (economic_forecast, price_signal)
  content: IntelContent;
  accuracy: number;                   // real accuracy 0-1 (internal, not shown to buyers)
  declared_accuracy: number;          // producer's claimed accuracy (may lie)
  is_fake: boolean;                   // system internal flag
  freshness: number;                  // 0-1, decays 5%/tick
  price: number;
  buyer_count: number;
  is_public: boolean;                 // revealed to the whole world after the sealed delay
  status: 'active' | 'expired' | 'sold_out';
  expires_at_tick: number;
  created_at_tick: number;
  consensus_reached_at_tick?: number | null;
  public_after_tick?: number | null;
  public_revealed_at_tick?: number | null;
  last_buyer_agent_id?: string | null;
  verified_accuracy: number | null;   // set after post-settlement verification
  created_at: string;
}

export interface IntelContent {
  type: IntelCategory;
  summary: string;                    // natural language summary for frontend
  data: Record<string, unknown>;      // structured data for engine consumption
}

// ── Intel Purchase Record ──

export interface IntelPurchase {
  id: number;
  intel_item_id: number;
  buyer_agent_id: string;
  price_paid: number;
  purchased_at_tick: number;
  created_at: string;
}

// ── Counter-Intel Event ──

export interface CounterIntelEvent {
  id: number;
  spy_agent_id: string;
  target_agent_id: string;
  detected: boolean;
  reaction: 'ignore' | 'feed_fake' | 'expose' | null;
  tick_number: number;
  created_at: string;
}

// ── Intel Credit Score (producer reputation) ──

export interface IntelCreditScore {
  agent_id: string;
  total_produced: number;
  total_verified: number;
  average_accuracy: number;
  fake_count: number;
  credit_score: number;               // 0-100
  tier: IntelCreditTier;
  updated_at: string;
}

export type IntelCreditTier = 'elite' | 'trusted' | 'neutral' | 'suspicious' | 'blacklisted';

export function getCreditTier(score: number): IntelCreditTier {
  if (score >= 80) return 'elite';
  if (score >= 60) return 'trusted';
  if (score >= 40) return 'neutral';
  if (score >= 20) return 'suspicious';
  return 'blacklisted';
}

// ── Archetype Intel Profiles ──

export interface ArchetypeIntelProfile {
  // Production
  productionRate: number;             // probability per 3-tick cycle (0-1)
  accuracyBase: number;               // base accuracy 0-1
  specialties: IntelCategory[];       // preferred production categories
  fakeRate: number;                   // probability of producing fake intel 0-1

  // Consumption
  purchaseBudgetRatio: number;        // fraction of balance willing to spend on intel
  purchasePriority: IntelCategory[];  // preferred purchase categories
  purchaseThreshold: number;          // price/balance ratio cutoff

  // Pricing
  pricingStrategy: 'premium' | 'fair' | 'discount' | 'monopoly' | 'chaos';
  pricingMultiplier: number;          // multiplied on base category price

  // Counter-Intel
  spyDetectionRate: number;           // base probability of detecting spies (0-1)
  counterReaction: { ignore: number; feed_fake: number; expose: number }; // probability distribution
}

export const ARCHETYPE_INTEL_PROFILE: Record<string, ArchetypeIntelProfile> = {
  oracle: {
    productionRate: 0.30,
    accuracyBase: 0.85,
    specialties: ['behavior_pattern', 'economic_forecast', 'price_signal'],
    fakeRate: 0.05,
    purchaseBudgetRatio: 0.15,
    purchasePriority: ['fate_dimension', 'counter_intel'],
    purchaseThreshold: 0.10,
    pricingStrategy: 'premium',
    pricingMultiplier: 1.5,
    spyDetectionRate: 0.25,
    counterReaction: { ignore: 0.20, feed_fake: 0.50, expose: 0.30 },
  },

  fox: {
    productionRate: 0.20,
    accuracyBase: 0.50,
    specialties: ['relationship_map', 'counter_intel', 'behavior_pattern'],
    fakeRate: 0.25,
    purchaseBudgetRatio: 0.30,
    purchasePriority: ['behavior_pattern', 'fate_dimension'],
    purchaseThreshold: 0.15,
    pricingStrategy: 'fair',
    pricingMultiplier: 1.0,
    spyDetectionRate: 0.30,
    counterReaction: { ignore: 0.10, feed_fake: 0.70, expose: 0.20 },
  },

  whale: {
    productionRate: 0.08,
    accuracyBase: 0.40,
    specialties: ['price_signal', 'economic_forecast'],
    fakeRate: 0.10,
    purchaseBudgetRatio: 0.40,
    purchasePriority: ['behavior_pattern', 'economic_forecast', 'price_signal'],
    purchaseThreshold: 0.25,
    pricingStrategy: 'monopoly',
    pricingMultiplier: 2.0,
    spyDetectionRate: 0.15,
    counterReaction: { ignore: 0.50, feed_fake: 0.20, expose: 0.30 },
  },

  sage: {
    productionRate: 0.15,
    accuracyBase: 0.75,
    specialties: ['behavior_pattern', 'economic_forecast'],
    fakeRate: 0.00,
    purchaseBudgetRatio: 0.10,
    purchasePriority: ['counter_intel', 'relationship_map'],
    purchaseThreshold: 0.08,
    pricingStrategy: 'discount',
    pricingMultiplier: 0.7,
    spyDetectionRate: 0.15,
    counterReaction: { ignore: 0.80, feed_fake: 0.05, expose: 0.15 },
  },

  hawk: {
    productionRate: 0.15,
    accuracyBase: 0.60,
    specialties: ['counter_intel', 'relationship_map'],
    fakeRate: 0.40,
    purchaseBudgetRatio: 0.20,
    purchasePriority: ['behavior_pattern', 'fate_dimension'],
    purchaseThreshold: 0.12,
    pricingStrategy: 'fair',
    pricingMultiplier: 1.0,
    spyDetectionRate: 0.40,
    counterReaction: { ignore: 0.05, feed_fake: 0.30, expose: 0.65 },
  },

  monk: {
    productionRate: 0.05,
    accuracyBase: 0.65,
    specialties: ['economic_forecast'],
    fakeRate: 0.00,
    purchaseBudgetRatio: 0.05,
    purchasePriority: ['economic_forecast'],
    purchaseThreshold: 0.05,
    pricingStrategy: 'discount',
    pricingMultiplier: 0.5,
    spyDetectionRate: 0.10,
    counterReaction: { ignore: 0.90, feed_fake: 0.05, expose: 0.05 },
  },

  echo: {
    productionRate: 0.12,
    accuracyBase: 0.55,
    specialties: ['behavior_pattern'],
    fakeRate: 0.10,
    purchaseBudgetRatio: 0.20,
    purchasePriority: ['behavior_pattern', 'relationship_map'],
    purchaseThreshold: 0.10,
    pricingStrategy: 'fair',
    pricingMultiplier: 1.0,
    spyDetectionRate: 0.10,
    counterReaction: { ignore: 0.40, feed_fake: 0.30, expose: 0.30 },
  },

  chaos: {
    productionRate: 0.25,
    accuracyBase: 0.30,
    specialties: ['counter_intel', 'price_signal', 'economic_forecast'],
    fakeRate: 0.50,
    purchaseBudgetRatio: 0.25,
    purchasePriority: ['counter_intel'],
    purchaseThreshold: 0.20,
    pricingStrategy: 'chaos',
    pricingMultiplier: 1.0,   // overridden by random in production engine
    spyDetectionRate: 0.15,
    counterReaction: { ignore: 0.33, feed_fake: 0.34, expose: 0.33 },
  },
};

// ── Base prices per intel category ──

export const INTEL_CATEGORY_BASE_PRICE: Record<IntelCategory, number> = {
  fate_dimension: 0.05,
  behavior_pattern: 0.08,
  relationship_map: 0.06,
  economic_forecast: 0.10,
  price_signal: 0.12,
  counter_intel: 0.15,
};

// ── Category display metadata ──

export const INTEL_CATEGORY_META: Record<IntelCategory, { icon: string; color: string; labelEn: string; labelZh: string }> = {
  fate_dimension:    { icon: '🎴', color: '#F59E0B', labelEn: 'Fate',         labelZh: '命运' },
  behavior_pattern:  { icon: '🔍', color: '#3B82F6', labelEn: 'Behavior',     labelZh: '行为' },
  relationship_map:  { icon: '🕸️', color: '#8B5CF6', labelEn: 'Relations',    labelZh: '关系' },
  economic_forecast: { icon: '📈', color: '#22C55E', labelEn: 'Economy',      labelZh: '经济' },
  price_signal:      { icon: '💹', color: '#EC4899', labelEn: 'Price Signal', labelZh: '价格' },
  counter_intel:     { icon: '🕵️', color: '#EF4444', labelEn: 'Counter-Intel', labelZh: '反情报' },
};

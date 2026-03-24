import { getPool } from '../db/postgres.js';
import { INTEL_PUBLIC_BUYER_THRESHOLD, type IntelCategory } from './intel-types.js';

export interface IntelMarketSignals {
  activeArenaAgents: Set<string>;
  predictionActive: boolean;
  producerCreditByAgent: Map<string, number>;
}

export interface IntelMarketSignal {
  demandScore: number;
  demandTier: 'critical' | 'high' | 'medium' | 'low';
  impactDomains: string[];
  effectSummaryZh: string;
  effectSummaryEn: string;
  saleReasonZh: string;
  saleReasonEn: string;
  subjectInArena: boolean;
  predictionWindow: boolean;
}

interface ItemShape {
  category: IntelCategory | string;
  subject_agent_id: string | null;
  producer_agent_id: string;
  freshness: number | string;
  declared_accuracy: number | string;
  verified_accuracy?: number | string | null;
  price: number | string;
  buyer_count: number | string;
  is_public?: boolean;
}

const CATEGORY_PROFILE: Record<
  IntelCategory,
  {
    base: number;
    domains: string[];
    effectZh: string;
    effectEn: string;
    hotArenaBonus: number;
    predictionBonus: number;
  }
> = {
  behavior_pattern: {
    base: 72,
    domains: ['arena', 'commons'],
    effectZh: '会直接改变竞技场里的合作/背叛倾向，也会影响公共品里的贡献与囤积判断。',
    effectEn: 'Directly changes cooperate-versus-betray behavior in Arena and shifts contribution versus hoarding in Commons.',
    hotArenaBonus: 18,
    predictionBonus: 0,
  },
  relationship_map: {
    base: 68,
    domains: ['arena', 'social'],
    effectZh: '更适合谈判、结盟和识别脆弱关系，尤其会影响开局前的信任判断。',
    effectEn: 'Most useful for negotiation, alliance reading, and identifying brittle trust before a match begins.',
    hotArenaBonus: 16,
    predictionBonus: 0,
  },
  fate_dimension: {
    base: 64,
    domains: ['arena', 'social'],
    effectZh: '隐藏命格会改变对手画像、合作预期和社交策略，是稀缺但高杠杆的信息。',
    effectEn: 'Hidden fate dimensions reshape opponent profiling, cooperation expectations, and social strategy. Scarce but high leverage.',
    hotArenaBonus: 16,
    predictionBonus: 0,
  },
  counter_intel: {
    base: 70,
    domains: ['arena', 'intel'],
    effectZh: '会暴露谁在窥探、谁在买情报，适合做反制、误导和临战前的防守部署。',
    effectEn: 'Exposes who is spying and who is buying. Best for counter-play, misdirection, and pre-match defense.',
    hotArenaBonus: 18,
    predictionBonus: 0,
  },
  economic_forecast: {
    base: 58,
    domains: ['commons', 'world'],
    effectZh: '更偏宏观，适合判断公共品与经济阶段，对单场竞技的直接价值较弱。',
    effectEn: 'More macro than tactical. Useful for Commons and economy-phase timing, but less decisive in a single duel.',
    hotArenaBonus: 4,
    predictionBonus: 0,
  },
  price_signal: {
    base: 62,
    domains: ['prediction'],
    effectZh: '主要服务于预测市场和交易选择，在价格轮次活跃时更容易成交。',
    effectEn: 'Mainly serves prediction and trading decisions. It sells best when prediction rounds are active.',
    hotArenaBonus: 0,
    predictionBonus: 18,
  },
};

export async function loadIntelMarketSignals(): Promise<IntelMarketSignals> {
  const pool = getPool();

  const [activeMatches, predictionRounds, credits] = await Promise.all([
    pool.query<{ player_a_id: string; player_b_id: string }>(
      `SELECT player_a_id, player_b_id
       FROM arena_matches
       WHERE status IN ('negotiating', 'deciding', 'resolving')`,
    ),
    pool.query<{ id: number }>(
      `SELECT id
       FROM prediction_rounds
       WHERE phase NOT IN ('settled', 'flash_settled')
       ORDER BY id DESC
       LIMIT 1`,
    ),
    pool.query<{ agent_id: string; credit_score: string }>(
      'SELECT agent_id, credit_score FROM intel_credit_scores',
    ),
  ]);

  const activeArenaAgents = new Set<string>();
  for (const row of activeMatches.rows) {
    activeArenaAgents.add(row.player_a_id);
    activeArenaAgents.add(row.player_b_id);
  }

  const producerCreditByAgent = new Map<string, number>();
  for (const row of credits.rows) {
    producerCreditByAgent.set(row.agent_id, Number(row.credit_score));
  }

  return {
    activeArenaAgents,
    predictionActive: predictionRounds.rows.length > 0,
    producerCreditByAgent,
  };
}

export function describeIntelMarketSignal(
  item: ItemShape,
  signals: IntelMarketSignals,
): IntelMarketSignal {
  const category = (item.category in CATEGORY_PROFILE ? item.category : 'behavior_pattern') as IntelCategory;
  const profile = CATEGORY_PROFILE[category];

  const freshness = Number(item.freshness ?? 0);
  const declaredAccuracy = Number(item.declared_accuracy ?? 0);
  const verifiedAccuracy = item.verified_accuracy == null ? null : Number(item.verified_accuracy);
  const accuracy = Number.isFinite(verifiedAccuracy ?? NaN) ? Number(verifiedAccuracy) : declaredAccuracy;
  const buyerCount = Number(item.buyer_count ?? 0);
  const price = Number(item.price ?? 0);
  const producerCredit = signals.producerCreditByAgent.get(item.producer_agent_id) ?? 50;
  const subjectInArena = !!item.subject_agent_id && signals.activeArenaAgents.has(item.subject_agent_id);

  let score = profile.base;
  score += freshness * 18;
  score += accuracy * 12;
  score += producerCredit * 0.15;
  score += Math.min(buyerCount, INTEL_PUBLIC_BUYER_THRESHOLD - 1) * 6;

  if (buyerCount > 0 && buyerCount < INTEL_PUBLIC_BUYER_THRESHOLD) {
    score += 6;
  }
  if (subjectInArena) {
    score += profile.hotArenaBonus;
  }
  if (signals.predictionActive) {
    score += profile.predictionBonus;
  }
  if (item.is_public) {
    score -= 18;
  }

  score -= Math.min(price * 70, 22);
  const demandScore = Math.max(8, Math.min(99, Number(score.toFixed(1))));

  const demandTier =
    demandScore >= 88 ? 'critical'
    : demandScore >= 74 ? 'high'
    : demandScore >= 58 ? 'medium'
    : 'low';

  let saleReasonZh = '这类情报有潜在用途，但还没有强到足以保证成交。';
  let saleReasonEn = 'This item has plausible utility, but not enough urgency to guarantee a sale.';

  if (subjectInArena && profile.hotArenaBonus > 0) {
    saleReasonZh = '目标正在参与竞技场，对局前的行为、关系、命格与反情报会显著升值。';
    saleReasonEn = 'The subject is already in Arena, so behavior, relationship, fate, and counter-intel become much more valuable before play.';
  } else if (signals.predictionActive && category === 'price_signal') {
    saleReasonZh = '预测轮次正在运行，价格信号的即时性更强，因此更容易成交。';
    saleReasonEn = 'A prediction round is live, so price signals gain immediate value and tend to sell faster.';
  } else if (buyerCount >= 1 && buyerCount < INTEL_PUBLIC_BUYER_THRESHOLD) {
    saleReasonZh = '已经有人愿意买单，说明市场认可它有用；最后一位买家拿到的是“最终确认权 + 短暂独享窗口”，而不是替所有人白白公开。';
    saleReasonEn = 'It already has paying buyers. The final buyer is not donating it to the whole market; they are buying final confirmation plus a short private edge before release.';
  } else if (freshness < 0.35) {
    saleReasonZh = '新鲜度已经偏低，即便内容有价值，也更可能被等待降价后再买。';
    saleReasonEn = 'Freshness is already low, so even useful intel is more likely to wait for a discount.';
  } else if (price > 0.12) {
    saleReasonZh = '定价偏高，只有高杠杆或高信用的情报才容易在这个价位成交。';
    saleReasonEn = 'The price is still premium, so only high-leverage or high-credit intel tends to clear at this level.';
  } else if (producerCredit < 40) {
    saleReasonZh = '生产者信用偏低，买家会更犹豫，因此这类情报经常挂着却卖不动。';
    saleReasonEn = 'Producer credit is weak, so buyers hesitate and listings like this often sit unsold.';
  }

  return {
    demandScore,
    demandTier,
    impactDomains: profile.domains,
    effectSummaryZh: profile.effectZh,
    effectSummaryEn: profile.effectEn,
    saleReasonZh,
    saleReasonEn,
    subjectInArena,
    predictionWindow: signals.predictionActive,
  };
}

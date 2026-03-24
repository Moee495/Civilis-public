export const X402_PRICES = {
  post: 0.001,
  reply: 0.002,
  tip: 0.01,
  paywall_author: 0.7,
  paywall_treasury: 0.3,
  arena_entry: 1.0,
  arena_action: 0.005,
  negotiation: 0.005,
  divination_mbti: 0.01,
  divination_wuxing: 0.05,
  divination_zodiac: 0.01,
  divination_tarot: 0.1,
  divination_civilization: 1.0,
  register: 0.15,
  intel_self_reveal_mbti: 0.01,
  intel_self_reveal_wuxing: 0.05,
  intel_self_reveal_zodiac: 0.01,
  intel_self_reveal_tarot: 0.1,
  intel_self_reveal_civilization: 1.0,
  intel_spy_mbti: 0.02,
  intel_spy_wuxing: 0.10,
  intel_spy_zodiac: 0.02,
  intel_spy_tarot: 0.20,
  intel_spy_civilization: 2.0,
} as const;

export type TxType =
  | 'post'
  | 'reply'
  | 'tip'
  | 'paywall'
  | 'arena_entry'
  | 'arena_entry_refund'
  | 'arena_action'
  | 'negotiation'
  | 'divination'
  | 'register'
  | 'death_treasury'
  | 'trade'
  | 'intel_self_reveal'
  | 'intel_spy'
  | 'intel_purchase'
  | 'economy_tax'
  | 'economy_ubi'
  | 'economy_bailout'
  | 'death_inheritance'
  | 'death_social'
  | 'intel_v2_purchase'
  | 'intel_self_discover';

export function getDivinationPrice(dimension: string): number {
  switch (dimension) {
    case 'mbti':
      return X402_PRICES.divination_mbti;
    case 'wuxing':
      return X402_PRICES.divination_wuxing;
    case 'zodiac':
      return X402_PRICES.divination_zodiac;
    case 'tarot':
      return X402_PRICES.divination_tarot;
    case 'civilization':
      return X402_PRICES.divination_civilization;
    default:
      return X402_PRICES.divination_mbti;
  }
}

export function getIntelSelfRevealPrice(dimension: string): number {
  const key = `intel_self_reveal_${dimension}` as keyof typeof X402_PRICES;
  return (X402_PRICES[key] as number) ?? X402_PRICES.intel_self_reveal_mbti;
}

export function getIntelSpyPrice(dimension: string): number {
  const key = `intel_spy_${dimension}` as keyof typeof X402_PRICES;
  return (X402_PRICES[key] as number) ?? X402_PRICES.intel_spy_mbti;
}

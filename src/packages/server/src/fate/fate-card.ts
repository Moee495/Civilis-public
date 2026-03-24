export type WuxingName = '金' | '木' | '水' | '火' | '土';

export interface FateCard {
  agentId: string;
  blockHash: string;
  blockNumber: number;
  mbti: string;
  wuxing: WuxingName;
  zodiac: string;
  tarotMajor: number;
  tarotName: string;
  civilization: string;
  elementDetail: Record<WuxingName, number>;
  rawSeed: string;
  isRevealed: boolean;
  revealedDimensions: string[];
  initialTarotState?: 'upright' | 'reversed';
  createdAt?: string;
}

export const MBTI_TYPES = [
  'INTJ',
  'INTP',
  'ENTJ',
  'ENTP',
  'INFJ',
  'INFP',
  'ENFJ',
  'ENFP',
  'ISTJ',
  'ISFJ',
  'ESTJ',
  'ESFJ',
  'ISTP',
  'ISFP',
  'ESTP',
  'ESFP',
] as const;

export const ZODIAC_SIGNS = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const;

export const TAROT_MAJOR = [
  'The Fool',
  'The Magician',
  'The High Priestess',
  'The Empress',
  'The Emperor',
  'The Hierophant',
  'The Lovers',
  'The Chariot',
  'Strength',
  'The Hermit',
  'Wheel of Fortune',
  'Justice',
  'The Hanged Man',
  'Death',
  'Temperance',
  'The Devil',
  'The Tower',
  'The Star',
  'The Moon',
  'The Sun',
  'Judgement',
  'The World',
] as const;

export const WUXING = ['金', '木', '水', '火', '土'] as const;
export const FATE_DIMENSIONS = [
  'mbti',
  'wuxing',
  'zodiac',
  'tarot',
  'civilization',
] as const;

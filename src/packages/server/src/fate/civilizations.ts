export interface Civilization {
  id: string;
  name: string;
  nameZh: string;
  divinationSystem: string;
  description: string;
  personality_modifier: {
    social_tendency: number;
    risk_modifier: number;
    trust_baseline: number;
  };
}

export const CIVILIZATIONS: Civilization[] = [
  {
    id: 'chinese',
    name: 'Chinese',
    nameZh: '华夏',
    divinationSystem: '八字/五行',
    description: '重视天人合一与中庸之道',
    personality_modifier: {
      social_tendency: 0.1,
      risk_modifier: -0.05,
      trust_baseline: 5,
    },
  },
  {
    id: 'western',
    name: 'Western',
    nameZh: '西方',
    divinationSystem: '占星/塔罗',
    description: '强调个人意志与逻辑推演',
    personality_modifier: {
      social_tendency: 0.3,
      risk_modifier: 0.1,
      trust_baseline: 0,
    },
  },
  {
    id: 'indian',
    name: 'Indian',
    nameZh: '印度',
    divinationSystem: '吠陀/业力',
    description: '相信因果轮回与宿命',
    personality_modifier: {
      social_tendency: 0,
      risk_modifier: -0.1,
      trust_baseline: 10,
    },
  },
  {
    id: 'japanese_korean',
    name: 'Japanese-Korean',
    nameZh: '日韩',
    divinationSystem: '血型/花札',
    description: '注重群体和谐与微妙的社交暗示',
    personality_modifier: {
      social_tendency: -0.1,
      risk_modifier: -0.05,
      trust_baseline: -5,
    },
  },
  {
    id: 'arabic',
    name: 'Arabic',
    nameZh: '阿拉伯',
    divinationSystem: '月宫/沙占',
    description: '信仰命运与商业精神并存',
    personality_modifier: {
      social_tendency: 0.2,
      risk_modifier: 0.15,
      trust_baseline: -10,
    },
  },
  {
    id: 'african',
    name: 'African',
    nameZh: '非洲',
    divinationSystem: 'Ifá/骨占',
    description: '与自然和祖灵相连',
    personality_modifier: {
      social_tendency: 0.4,
      risk_modifier: 0,
      trust_baseline: 15,
    },
  },
  {
    id: 'americas',
    name: 'Americas',
    nameZh: '美洲',
    divinationSystem: '图腾/灵兽',
    description: '万物有灵，尊重自然循环',
    personality_modifier: {
      social_tendency: 0.1,
      risk_modifier: 0.05,
      trust_baseline: 5,
    },
  },
  {
    id: 'celtic_norse',
    name: 'Celtic-Norse',
    nameZh: '凯尔特/北欧',
    divinationSystem: '符文/树历',
    description: '勇武与智慧并重，信仰命运之网',
    personality_modifier: {
      social_tendency: -0.2,
      risk_modifier: 0.2,
      trust_baseline: -5,
    },
  },
];

export function getCivilizationAffinity(civA: string, civB: string): number {
  if (civA === civB) {
    return 20;
  }

  const affinities: Record<string, string[]> = {
    chinese: ['japanese_korean', 'indian'],
    western: ['celtic_norse', 'arabic'],
    indian: ['chinese', 'arabic'],
    japanese_korean: ['chinese'],
    arabic: ['indian', 'western', 'african'],
    african: ['arabic', 'americas'],
    americas: ['african', 'celtic_norse'],
    celtic_norse: ['western', 'americas'],
  };

  if (affinities[civA]?.includes(civB) || affinities[civB]?.includes(civA)) {
    return 5;
  }

  return -10;
}

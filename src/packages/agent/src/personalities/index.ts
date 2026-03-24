// ─── Archetype Sub-interfaces ────────────────────────────────

export interface ArchetypeBaseParams {
  cooperationRate: number;
  riskTolerance: number;
  postFrequency: number;
  tipTendency: number;
  intelParticipation: number;
  paywallUsage: number;
  minBalanceMultiplier: number;
  negotiationHonesty: number;
  negotiationStyle:
    | 'data_driven'
    | 'threatening'
    | 'peaceful'
    | 'charming'
    | 'nonsense'
    | 'silent'
    | 'zen'
    | 'mimicking';
}

export interface UniqueMechanic {
  id: string;
  name: string;
  nameZh: string;
  description: string;
  triggerCondition: string;
  cooldownTicks: number;
  effect: Record<string, number | string | boolean>;
}

export interface InnateAffinity {
  bestMBTI: string[];
  worstMBTI: string[];
  bestWuxing: string;
  worstWuxing: string;
  bestZodiac: string[];
  worstZodiac: string[];
  bestTarot: string[];
  worstTarot: string[];
  bestCivilization: string;
  worstCivilization: string;
  affinityBonus: number;
  mismatchPenalty: number;
}

export interface EvolutionPath {
  condition: string;
  conditionCheck: {
    minAge: number;
    minExperienceLevel: number;
    dominantDimension: string;
  };
  subArchetype: string;
  bonusEffect: string;
  bonusParams: Record<string, number>;
}

// ─── Main interface ──────────────────────────────────────────

export interface AgentPersonalityConfig {
  // === Existing fields ===
  archetype: string;
  nameZh: string;
  description: string;
  arenaStrategy: string;
  socialStyle: string;
  riskProfile: string;
  tradingStyle: string;
  systemPrompt: string;

  // === Archetype engine fields ===
  baseParams: ArchetypeBaseParams;
  uniqueMechanics: UniqueMechanic[];
  innateAffinity: InnateAffinity;
  nurtureSensitivity: {
    combat: number;
    trauma: number;
    wealth: number;
    social: number;
    reputation: number;
    emotion: number;
    cognition: number;
  };
  evolutionPaths: EvolutionPath[];
  bigFiveProfile: {
    openness: number;
    agreeableness: number;
    conscientiousness: number;
    extraversion: number;
    neuroticism: number;
  };
  machiavelliIndex: number;
}

// ─── Registry ────────────────────────────────────────────────

import { chaosPersonality } from './chaos.js';
import { echoPersonality } from './echo.js';
import { foxPersonality } from './fox.js';
import { hawkPersonality } from './hawk.js';
import { monkPersonality } from './monk.js';
import { oraclePersonality } from './oracle.js';
import { sagePersonality } from './sage.js';
import { whalePersonality } from './whale.js';

const PERSONALITIES: Record<string, AgentPersonalityConfig> = {
  oracle: oraclePersonality,
  hawk: hawkPersonality,
  sage: sagePersonality,
  fox: foxPersonality,
  chaos: chaosPersonality,
  whale: whalePersonality,
  monk: monkPersonality,
  echo: echoPersonality,
};

export function getPersonality(archetype: string): AgentPersonalityConfig {
  const personality = PERSONALITIES[archetype];
  if (!personality) {
    throw new Error(`Unknown archetype: ${archetype}`);
  }
  return personality;
}

export function listPersonalities(): AgentPersonalityConfig[] {
  return Object.values(PERSONALITIES);
}

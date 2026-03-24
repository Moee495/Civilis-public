import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { SUPPORTED_PAIRS, type TradingPair, fetchCurrentPrice, getPriceAtTick } from './price-feed.js';
import { addToPredictionLossPool } from '../commons/commons-settlement.js';
import { verifyPredictionIntel } from '../intel/intel-verification.js';
import { createPredictionJob, settlePredictionJob } from '../erc8183/hooks/prediction-hook.js';
import { getACPClient } from '../erc8183/acp-client.js';
import { getFateCard, computeDynamicTarotState } from '../fate/fate-engine.js';
import {
  type FateContext,
  calculateFateRiskTolerance,
  getArchetypeBaseRisk,
  getMBTIModifiers,
  getZodiacModifiers,
  getCivilizationModifiers,
} from '../fate/fate-modifiers.js';
import { loadNurtureProfileFromDB } from '../nurture/nurture-updater.js';
import { getIntelImpactOnPrediction } from '../intel/intel-impact.js';
import { getEconomyImpactOnPrediction, getIntelFromTrustedAgents } from '../economy/cross-mode-chains.js';
import { getWorldModifierDelta } from '../world/modifiers.js';

const PP_TREASURY_CUT = 0.10;   // Reduced from 0.25 → 0.10 for neutral EV
const PP_COMMONS_RETURN_RATE = 0.20; // Reduced from 0.30 → 0.20 (less drain to commons)
const ENTRY_FEE_BASE = 0.3;
const ROUND_DURATION_TICKS = 10; // 10 ticks = 5 minutes at 30s/tick
const FLASH_SETTLEMENT_THRESHOLD = 0.01; // 1% relative diff

async function shouldRunPredictionAcpHook(): Promise<boolean> {
  const protocol = await getACPClient().getProtocolDescriptor();
  return !(protocol.surface === 'v2' && protocol.addressSource === 'v2_env');
}

const ODDS_TABLE: Record<string, number> = {
  long_small: 1.3,   // Up from 1.2
  long_big: 2.5,
  short_small: 1.3,  // Up from 1.2
  short_big: 2.5,
  hedge: 0.5,        // Up from 0.3 — hedge now loses only 50% not 70%
};

// Archetype base action probabilities for prediction
const ARCHETYPE_PREDICTION_BASE: Record<string, Record<string, number>> = {
  sage:   { long_small: 0.10, long_big: 0.00, short_small: 0.05, short_big: 0.00, hedge: 0.85 },
  monk:   { long_small: 0.30, long_big: 0.05, short_small: 0.25, short_big: 0.05, hedge: 0.35 },
  oracle: { long_small: 0.35, long_big: 0.15, short_small: 0.30, short_big: 0.10, hedge: 0.10 },
  fox:    { long_small: 0.25, long_big: 0.20, short_small: 0.25, short_big: 0.15, hedge: 0.15 },
  echo:   { long_small: 0.25, long_big: 0.15, short_small: 0.25, short_big: 0.10, hedge: 0.25 },
  whale:  { long_small: 0.15, long_big: 0.35, short_small: 0.10, short_big: 0.30, hedge: 0.10 },
  hawk:   { long_small: 0.10, long_big: 0.40, short_small: 0.05, short_big: 0.35, hedge: 0.10 },
  chaos:  { long_small: 0.20, long_big: 0.20, short_small: 0.20, short_big: 0.20, hedge: 0.20 },
};

// Archetype coin preferences
const ARCHETYPE_COIN_PREF: Record<string, TradingPair[]> = {
  sage:   ['BTC-USDT'],
  monk:   ['BTC-USDT', 'ETH-USDT'],
  oracle: ['OKB-USDT'],
  fox:    ['OKB-USDT', 'ETH-USDT'],
  echo:   ['ETH-USDT'],
  whale:  ['BTC-USDT'],
  hawk:   ['ETH-USDT', 'OKB-USDT'],
  chaos:  ['OKB-USDT', 'BTC-USDT', 'ETH-USDT'],
};

type PredictionPositionType = keyof typeof ODDS_TABLE;

interface PredictionDecision {
  chosenCoin: 'coin_a' | 'coin_b';
  positionType: PredictionPositionType;
  reasoning: string;
}

interface LoadedPredictionNurture {
  wealth?: {
    class?: string;
    trend?: string;
    lossAversion?: number;
    timeHorizon?: number;
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
  social?: {
    position?: string;
    adversaries?: number;
  };
  trauma?: {
    state?: string;
    betrayals?: number;
  };
  reputation?: {
    trajectory?: string;
    score?: number;
    tier?: string;
  };
  combat?: {
    winRate?: number;
    currentStreak?: number;
    totalMatches?: number;
  };
}

type TrustedPredictionIntel = Array<{ agentId: string; chosenCoin: string; positionType: string }>;

interface PredictionSignalBundle {
  rawFate: FateContext | null;
  nurture: LoadedPredictionNurture | null;
  intelImpact: { preferCoinA: number; positionAggression: number };
  trustedIntel: TrustedPredictionIntel;
  trustedBias: { coinABias: number; aggressionBias: number };
  momentum: { momentumA: number; momentumB: number };
  economyImpact: ReturnType<typeof getEconomyImpactOnPrediction>;
  balance: number;
  baseProbs: Record<string, number>;
  baseRisk: number;
  fateRisk: number;
  worldRiskShift: number;
  mbtiMods: ReturnType<typeof getMBTIModifiers> | null;
  zodiacMods: ReturnType<typeof getZodiacModifiers> | null;
  civMods: ReturnType<typeof getCivilizationModifiers> | null;
  prefCoins: TradingPair[];
}

interface PredictionParticipationProfile {
  engagementScore: number;
  threshold: number;
  reason: string;
}

export interface PredictionWorldModifierState {
  oddsBonus: number;
}

export async function getActivePredictionWorldModifierState(): Promise<PredictionWorldModifierState> {
  return {
    oddsBonus: await getWorldModifierDelta({
      domain: 'prediction',
      modifierType: 'prediction_odds_bonus',
    }),
  };
}

function applyPredictionOddsBonus(positionType: PredictionPositionType, oddsBonus: number): number {
  const baseOdds = ODDS_TABLE[positionType] ?? 1.0;
  if (positionType === 'hedge') {
    return baseOdds;
  }
  return Number(Math.max(0.4, baseOdds + oddsBonus).toFixed(4));
}

/**
 * Create a new prediction round. Called by tick-engine every 10 ticks.
 */
export async function createPredictionRound(tickNumber: number): Promise<void> {
  const pool = getPool();
  const worldModifiers = await getActivePredictionWorldModifierState();

  // Get round number
  const rnResult = await pool.query<{ n: string }>(
    'SELECT COALESCE(MAX(round_number), 0) as n FROM prediction_rounds'
  );
  const roundNumber = parseInt(rnResult.rows[0].n) + 1;

  // Pick 2 random coins from the 3 supported pairs
  const shuffled = [...SUPPORTED_PAIRS].sort(() => Math.random() - 0.5);
  const coinA = shuffled[0];
  const coinB = shuffled[1];

  // Get start prices
  const [priceA, priceB] = await Promise.all([
    fetchCurrentPrice(coinA),
    fetchCurrentPrice(coinB),
  ]);

  // Get eligible agents (alive, sufficient balance, not already in active prediction)
  const eligible = await pool.query<{
    agent_id: string; name: string; archetype: string; balance: string;
  }>(`SELECT a.agent_id, a.name, a.archetype, a.balance
      FROM agents a
      WHERE a.is_alive = true AND CAST(a.balance AS DECIMAL) >= $1
        AND a.agent_id NOT IN (
          SELECT pp.agent_id FROM prediction_positions pp
          JOIN prediction_rounds pr ON pp.round_id = pr.id
          WHERE pr.phase NOT IN ('settled', 'flash_settled')
        )`,
    [ENTRY_FEE_BASE]
  );

  if (eligible.rows.length < 2) {
    console.log(`[Prediction] tick=${tickNumber}: Not enough eligible agents (${eligible.rows.length})`);
    return;
  }

  // Get economy phase for entry fee adjustment
  const econResult = await pool.query<{ economy_phase: string }>(
    'SELECT economy_phase FROM economy_state ORDER BY id DESC LIMIT 1'
  );
  const ecoPhase = econResult.rows[0]?.economy_phase ?? 'stable';
  let entryFee = ENTRY_FEE_BASE;
  if (ecoPhase === 'boom') entryFee *= 1.3;
  if (ecoPhase === 'crisis') entryFee *= 0.7;

  const participationProfiles = await Promise.all(
    eligible.rows.map(async (agent) => ({
      agent,
      profile: await buildPredictionParticipationProfile(agent, coinA, coinB, ecoPhase, entryFee),
    })),
  );

  const rankedParticipants = participationProfiles
    .sort((a, b) => b.profile.engagementScore - a.profile.engagementScore);

  const willingParticipants = rankedParticipants.filter(
    ({ profile }) => profile.engagementScore >= profile.threshold,
  );

  const fallbackAverage =
    rankedParticipants.slice(0, 2).reduce((sum, item) => sum + item.profile.engagementScore, 0) / 2;

  let selectedParticipants = willingParticipants.slice(0, 4);
  if (selectedParticipants.length < 2 && rankedParticipants.length >= 2 && fallbackAverage >= 0.34) {
    selectedParticipants = rankedParticipants.slice(0, Math.min(4, Math.max(2, willingParticipants.length || 2)));
  }

  if (selectedParticipants.length < 2) {
    console.log(
      `[Prediction] tick=${tickNumber}: Insufficient willing agents for ${coinA}/${coinB} ` +
      `(top score ${rankedParticipants[0]?.profile.engagementScore?.toFixed(2) ?? '0.00'})`,
    );
    return;
  }

  const endTick = tickNumber + ROUND_DURATION_TICKS;
  const participantDecisions = await Promise.all(
    selectedParticipants.map(({ agent }) =>
      buildPredictionDecision(agent, coinA, coinB, ecoPhase),
    ),
  );

  await withTransaction(async (client) => {
    // Create round
    const roundInsert = await client.query(
      `INSERT INTO prediction_rounds
        (round_number, start_tick, end_tick, phase, coin_a, coin_b, start_price_a, start_price_b, prize_pool)
       VALUES ($1, $2, $3, 'predicting', $4, $5, $6, $7, 0) RETURNING id`,
      [roundNumber, tickNumber, endTick, coinA, coinB, priceA.toFixed(8), priceB.toFixed(8)]
    );
    const roundId = roundInsert.rows[0].id;

    let totalPrizePool = 0;

    for (const [index, { agent, profile }] of selectedParticipants.entries()) {
      const decision = participantDecisions[index];
      // Deduct entry fee
      await client.query(
        'UPDATE agents SET balance = balance - $1 WHERE agent_id = $2',
        [entryFee, agent.agent_id]
      );
      totalPrizePool += entryFee;

      const baseOdds = applyPredictionOddsBonus(decision.positionType, worldModifiers.oddsBonus);

      await client.query(
        `INSERT INTO prediction_positions
          (round_id, agent_id, chosen_coin, position_type, entry_fee, base_odds, reasoning)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          roundId,
          agent.agent_id,
          decision.chosenCoin,
          decision.positionType,
          entryFee.toFixed(4),
          baseOdds,
          `${decision.reasoning} | join:${profile.reason}`,
        ]
      );
    }

    // Update prize pool
    await client.query(
      'UPDATE prediction_rounds SET prize_pool = $1 WHERE id = $2',
      [totalPrizePool.toFixed(4), roundId]
    );
  });

  eventBus.emit('prediction_created', {
    roundNumber,
    tickNumber,
    coinA,
    coinB,
    priceA,
    priceB,
    participants: selectedParticipants.map(({ agent, profile }) => ({
      id: agent.agent_id,
      name: agent.name,
      engagement: Number(profile.engagementScore.toFixed(2)),
    })),
    endTick,
    oddsBonus: worldModifiers.oddsBonus,
  });

  console.log(
    `[Prediction] Round ${roundNumber} tick=${tickNumber}: ${coinA} vs ${coinB} ` +
    `| ${selectedParticipants.length} agents | ends tick ${endTick}`
  );
}

async function buildPredictionDecision(
  agent: { agent_id: string; name: string; archetype: string; balance: string },
  coinA: TradingPair,
  coinB: TradingPair,
  economyPhase: string,
): Promise<PredictionDecision> {
  const signals = await loadPredictionSignals(agent, coinA, coinB, economyPhase);
  const {
    rawFate,
    nurture,
    intelImpact,
    trustedBias,
    momentum,
    economyImpact,
    balance,
    baseProbs,
    fateRisk,
    worldRiskShift,
    mbtiMods,
    zodiacMods,
    civMods,
    prefCoins,
  } = signals;

  let preferCoinAScore = 0;
  if (prefCoins.includes(coinA)) preferCoinAScore += 0.18;
  if (prefCoins.includes(coinB)) preferCoinAScore -= 0.18;

  preferCoinAScore += intelImpact.preferCoinA * 0.9;
  preferCoinAScore += Math.max(-0.12, Math.min(0.12, (momentum.momentumA - momentum.momentumB) * 4));
  preferCoinAScore += trustedBias.coinABias;

  if (zodiacMods?.specialAbility === 'prediction_boost') preferCoinAScore += trustedBias.coinABias * 0.4;
  if (rawFate?.mbti?.[1] === 'N') preferCoinAScore += intelImpact.preferCoinA * 0.15;

  let aggression = 0.5;
  aggression += (fateRisk - 0.5) * 0.7;
  aggression += intelImpact.positionAggression * 0.7;
  aggression += trustedBias.aggressionBias * 0.25;
  aggression += economyImpact.longBigBonus * 0.7;
  aggression += worldRiskShift * 0.45;

  if (nurture?.wealth) {
    const trend = nurture.wealth.trend ?? 'stable';
    const wealthClass = nurture.wealth.class ?? 'middle';
    const lossAversion = Number(nurture.wealth.lossAversion ?? 2.25);
    const timeHorizon = Number(nurture.wealth.timeHorizon ?? 60);

    if (trend === 'rising') aggression += 0.10;
    if (trend === 'falling') aggression -= 0.04;
    if (trend === 'crisis') aggression -= 0.12;

    if (wealthClass === 'elite') aggression += 0.06;
    if (wealthClass === 'poverty') aggression -= 0.16;

    aggression -= Math.max(0, lossAversion - 2.0) * 0.06;
    if (timeHorizon >= 80) aggression -= 0.05;
  }

  if (nurture?.emotion) {
    const mood = nurture.emotion.mood ?? 'calm';
    const valence = Number(nurture.emotion.valence ?? 0);
    const arousal = Number(nurture.emotion.arousal ?? 0);

    aggression += valence * 0.10;
    aggression += arousal * 0.05;

    if (mood === 'euphoric' || mood === 'confident') aggression += 0.08;
    if (mood === 'fearful' || mood === 'anxious') aggression -= 0.10;
    if (mood === 'desperate') aggression += 0.06;
  }

  if (nurture?.cognition) {
    const complexity = Number(nurture.cognition.complexity ?? 1);
    const explorationRate = Number(nurture.cognition.explorationRate ?? 0.25);
    if (complexity >= 4) aggression -= 0.05;
    if (complexity <= 2) aggression += 0.04;
    preferCoinAScore += (Math.random() * 2 - 1) * explorationRate * 0.15;
  }

  if (nurture?.combat) {
    const winRate = Number(nurture.combat.winRate ?? 0.5);
    const streak = Number(nurture.combat.currentStreak ?? 0);
    aggression += (winRate - 0.5) * 0.10;
    if (streak >= 2) aggression += 0.04;
    if (streak <= -2) aggression += 0.03;
  }

  if (nurture?.trauma?.state === 'scarred' || nurture?.trauma?.state === 'hardened') {
    aggression -= 0.05;
  }

  if ((civMods?.longTermOrientation ?? 50) >= 80) aggression -= 0.05;
  if ((civMods?.riskTolerance ?? 5) >= 7) aggression += 0.05;
  if (zodiacMods?.element === 'fire') aggression += 0.04;
  if (zodiacMods?.element === 'earth') aggression -= 0.05;

  aggression = clampRange(aggression, 0.05, 0.95);

  const chosenCoin: 'coin_a' | 'coin_b' = preferCoinAScore >= 0 ? 'coin_a' : 'coin_b';
  const conviction = Math.abs(preferCoinAScore);

  const bullishness =
    (momentum.momentumA + momentum.momentumB) / 2 > 0
      ? 0.08
      : -0.04;

  let positionType: PredictionPositionType = 'hedge';
  if (aggression < 0.36) {
    positionType = 'hedge';
  } else if (aggression > 0.72 || conviction > 0.22) {
    positionType = bullishness + (preferCoinAScore >= 0 ? 0.02 : -0.02) >= 0 ? 'long_big' : 'short_big';
  } else {
    positionType = bullishness + (preferCoinAScore >= 0 ? 0.02 : -0.02) >= 0 ? 'long_small' : 'short_small';
  }

  if ((nurture?.wealth?.trend === 'crisis' || nurture?.wealth?.class === 'poverty') && conviction < 0.25) {
    positionType = 'hedge';
  }

  const reasoning = buildPredictionReasoning({
    archetype: agent.archetype,
    chosenCoin,
    positionType,
    coinA,
    coinB,
    economyPhase,
    intelImpact,
    trustedBias,
    rawFate,
    nurture,
    worldRiskShift,
  });

  return { chosenCoin, positionType, reasoning };
}

async function loadPredictionSignals(
  agent: { agent_id: string; archetype: string; balance: string },
  coinA: TradingPair,
  coinB: TradingPair,
  economyPhase: string,
): Promise<PredictionSignalBundle> {
  const [rawFate, nurture, intelImpact, trustedIntel, momentum, worldRiskShift] = await Promise.all([
    loadPredictionFate(agent.agent_id),
    loadNurtureProfileFromDB(agent.agent_id) as Promise<LoadedPredictionNurture | null>,
    getIntelImpactOnPrediction(agent.agent_id, coinA, coinB).catch(() => ({ preferCoinA: 0, positionAggression: 0 })),
    getIntelFromTrustedAgents(agent.agent_id).catch(() => []),
    getRecentMomentum(coinA, coinB).catch(() => ({ momentumA: 0, momentumB: 0 })),
    getWorldModifierDelta({
      domain: 'agent_decision',
      modifierType: 'risk_tolerance_shift',
    }).catch(() => 0),
  ]);

  const baseProbs = ARCHETYPE_PREDICTION_BASE[agent.archetype] ?? ARCHETYPE_PREDICTION_BASE.echo;
  const baseRisk = getArchetypeBaseRisk(agent.archetype);
  const fateRisk = rawFate ? calculateFateRiskTolerance(baseRisk, rawFate) : baseRisk;

  return {
    rawFate,
    nurture,
    intelImpact,
    trustedIntel,
    trustedBias: deriveTrustedPredictionBias(trustedIntel, coinA, coinB),
    momentum,
    economyImpact: getEconomyImpactOnPrediction(economyPhase),
    balance: Number(agent.balance),
    baseProbs,
    baseRisk,
    fateRisk,
    worldRiskShift,
    mbtiMods: rawFate ? getMBTIModifiers(rawFate.mbti) : null,
    zodiacMods: rawFate ? getZodiacModifiers(rawFate.zodiac) : null,
    civMods: rawFate ? getCivilizationModifiers(rawFate.civilization) : null,
    prefCoins: ARCHETYPE_COIN_PREF[agent.archetype] ?? ['OKB-USDT'],
  };
}

async function buildPredictionParticipationProfile(
  agent: { agent_id: string; name: string; archetype: string; balance: string },
  coinA: TradingPair,
  coinB: TradingPair,
  economyPhase: string,
  entryFee: number,
): Promise<PredictionParticipationProfile> {
  const signals = await loadPredictionSignals(agent, coinA, coinB, economyPhase);
  const {
    rawFate,
    nurture,
    intelImpact,
    trustedIntel,
    economyImpact,
    balance,
    baseProbs,
    fateRisk,
    worldRiskShift,
    mbtiMods,
    zodiacMods,
    civMods,
  } = signals;

  const nonHedgeBias = 1 - (baseProbs.hedge ?? 0.3);
  let engagementScore = 0.36 + nonHedgeBias * 0.30;
  engagementScore += (fateRisk - 0.5) * 0.35;
  engagementScore += Math.abs(intelImpact.preferCoinA) * 0.18;
  engagementScore += Math.max(0, intelImpact.positionAggression) * 0.22;
  engagementScore += trustedIntel.length > 0 ? 0.05 : 0;
  engagementScore += economyImpact.longBigBonus * 0.6;
  engagementScore -= economyImpact.hedgeBonus * 0.2;
  engagementScore += worldRiskShift * 0.28;

  if (balance < entryFee * 2) engagementScore -= 0.28;
  else if (balance < entryFee * 4) engagementScore -= 0.12;
  else if (balance > entryFee * 12) engagementScore += 0.05;

  if (nurture?.wealth) {
    const trend = nurture.wealth.trend ?? 'stable';
    const wealthClass = nurture.wealth.class ?? 'middle';
    const lossAversion = Number(nurture.wealth.lossAversion ?? 2.25);

    if (trend === 'rising') engagementScore += 0.08;
    if (trend === 'stable') engagementScore += 0.02;
    if (trend === 'falling') engagementScore -= 0.06;
    if (trend === 'crisis') engagementScore -= 0.16;

    if (wealthClass === 'elite') engagementScore += 0.05;
    if (wealthClass === 'poverty') engagementScore -= 0.14;

    engagementScore -= Math.max(0, lossAversion - 2.1) * 0.04;
  }

  if (nurture?.emotion) {
    const mood = nurture.emotion.mood ?? 'calm';
    const valence = Number(nurture.emotion.valence ?? 0);
    const arousal = Number(nurture.emotion.arousal ?? 0);
    engagementScore += valence * 0.08;
    engagementScore += arousal * 0.04;
    if (mood === 'confident' || mood === 'euphoric') engagementScore += 0.08;
    if (mood === 'fearful' || mood === 'anxious') engagementScore -= 0.12;
    if (mood === 'desperate') engagementScore += 0.03;
  }

  if (nurture?.cognition) {
    const explorationRate = Number(nurture.cognition.explorationRate ?? 0.25);
    const complexity = Number(nurture.cognition.complexity ?? 1);
    engagementScore += explorationRate * 0.10;
    if (complexity >= 4) engagementScore += 0.04;
  }

  if (nurture?.trauma?.state === 'scarred') engagementScore -= 0.05;
  if (nurture?.trauma?.state === 'hardened') engagementScore += 0.03;

  if (mbtiMods?.riskToleranceMod) engagementScore += mbtiMods.riskToleranceMod * 0.12;
  if ((civMods?.riskTolerance ?? 5) >= 7) engagementScore += 0.04;
  if ((civMods?.longTermOrientation ?? 50) >= 80) engagementScore -= 0.04;
  if (zodiacMods?.specialAbility === 'prediction_boost') engagementScore += 0.06;
  if (zodiacMods?.element === 'earth') engagementScore -= 0.03;
  if (zodiacMods?.element === 'fire') engagementScore += 0.03;

  const threshold = clampRange(0.52 - Math.min(0.10, trustedIntel.length * 0.02), 0.38, 0.58);
  const reasonBits: string[] = [agent.archetype];
  if (Math.abs(intelImpact.preferCoinA) > 0.08 || Math.abs(intelImpact.positionAggression) > 0.08) {
    reasonBits.push('intel');
  }
  if (nurture?.wealth?.trend) reasonBits.push(`wealth:${nurture.wealth.trend}`);
  if (nurture?.emotion?.mood) reasonBits.push(`mood:${nurture.emotion.mood}`);
  if (rawFate?.mbti) reasonBits.push(rawFate.mbti);
  if (economyPhase !== 'stable') reasonBits.push(`eco:${economyPhase}`);

  return {
    engagementScore: clampRange(engagementScore, 0.05, 0.95),
    threshold,
    reason: reasonBits.slice(0, 4).join('|'),
  };
}

async function loadPredictionFate(agentId: string): Promise<FateContext | null> {
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

async function getRecentMomentum(
  coinA: TradingPair,
  coinB: TradingPair,
): Promise<{ momentumA: number; momentumB: number }> {
  const pool = getPool();
  const [rowsA, rowsB] = await Promise.all([
    pool.query<{ price: string }>(
      `SELECT price FROM price_snapshots WHERE pair = $1 ORDER BY tick_number DESC LIMIT 5`,
      [coinA],
    ),
    pool.query<{ price: string }>(
      `SELECT price FROM price_snapshots WHERE pair = $1 ORDER BY tick_number DESC LIMIT 5`,
      [coinB],
    ),
  ]);

  return {
    momentumA: calculateMomentum(rowsA.rows),
    momentumB: calculateMomentum(rowsB.rows),
  };
}

function calculateMomentum(rows: Array<{ price: string }>): number {
  if (rows.length < 2) return 0;
  const latest = Number(rows[0].price);
  const earliest = Number(rows[rows.length - 1].price);
  if (!latest || !earliest) return 0;
  return (latest - earliest) / earliest;
}

function deriveTrustedPredictionBias(
  trustedIntel: Array<{ agentId: string; chosenCoin: string; positionType: string }>,
  coinA: TradingPair,
  coinB: TradingPair,
): { coinABias: number; aggressionBias: number } {
  if (trustedIntel.length === 0) return { coinABias: 0, aggressionBias: 0 };

  let coinABias = 0;
  let aggressionBias = 0;

  for (const intel of trustedIntel) {
    if (intel.chosenCoin === 'coin_a') coinABias += 0.08;
    else if (intel.chosenCoin === 'coin_b') coinABias -= 0.08;
    else if (intel.chosenCoin === coinA) coinABias += 0.08;
    else if (intel.chosenCoin === coinB) coinABias -= 0.08;

    if (intel.positionType.includes('big')) aggressionBias += 0.08;
    if (intel.positionType === 'hedge') aggressionBias -= 0.05;
  }

  return {
    coinABias: clampRange(coinABias, -0.24, 0.24),
    aggressionBias: clampRange(aggressionBias, -0.16, 0.20),
  };
}

function buildPredictionReasoning(params: {
  archetype: string;
  chosenCoin: 'coin_a' | 'coin_b';
  positionType: PredictionPositionType;
  coinA: TradingPair;
  coinB: TradingPair;
  economyPhase: string;
  intelImpact: { preferCoinA: number; positionAggression: number };
  trustedBias: { coinABias: number; aggressionBias: number };
  rawFate: FateContext | null;
  nurture: LoadedPredictionNurture | null;
  worldRiskShift: number;
}): string {
  const targetCoin = params.chosenCoin === 'coin_a' ? params.coinA : params.coinB;
  const factors: string[] = [params.archetype];

  if (params.rawFate?.mbti) factors.push(params.rawFate.mbti);
  if (params.rawFate?.zodiac) factors.push(params.rawFate.zodiac);
  if (params.nurture?.wealth?.trend) factors.push(`wealth:${params.nurture.wealth.trend}`);
  if (params.nurture?.emotion?.mood) factors.push(`mood:${params.nurture.emotion.mood}`);
  if (Math.abs(params.intelImpact.preferCoinA) > 0.08) factors.push('intel');
  if (Math.abs(params.trustedBias.coinABias) > 0.05) factors.push('trusted_signal');
  if (Math.abs(params.worldRiskShift) > 0.02) factors.push(`world_risk:${params.worldRiskShift > 0 ? 'hot' : 'cool'}`);
  if (params.economyPhase !== 'stable') factors.push(`eco:${params.economyPhase}`);

  return `${factors.join('|')} -> ${params.positionType} on ${targetCoin}`;
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Check active prediction rounds for flash settlement or end settlement.
 * Called by tick-engine every tick.
 */
export async function checkPredictionSettlements(tickNumber: number): Promise<void> {
  const pool = getPool();

  const activeRounds = await pool.query<{
    id: number; round_number: number; start_tick: number; end_tick: number;
    coin_a: string; coin_b: string; start_price_a: string; start_price_b: string;
    prize_pool: string; phase: string;
  }>("SELECT * FROM prediction_rounds WHERE phase IN ('predicting', 'waiting')");

  for (const round of activeRounds.rows) {
    const coinA = round.coin_a as TradingPair;
    const coinB = round.coin_b as TradingPair;

    // Get current prices
    const [currentPriceA, currentPriceB] = await Promise.all([
      fetchCurrentPrice(coinA),
      fetchCurrentPrice(coinB),
    ]);

    const startPriceA = parseFloat(round.start_price_a);
    const startPriceB = parseFloat(round.start_price_b);
    const changeA = ((currentPriceA - startPriceA) / startPriceA) * 100;
    const changeB = ((currentPriceB - startPriceB) / startPriceB) * 100;
    const relativeDiff = Math.abs(changeA - changeB);

    // Flash settlement check
    if (relativeDiff >= FLASH_SETTLEMENT_THRESHOLD * 100 && tickNumber < round.end_tick) {
      await settlePredictionRound(round.id, tickNumber, currentPriceA, currentPriceB, true);
      continue;
    }

    // Normal settlement at end_tick
    if (tickNumber >= round.end_tick) {
      await settlePredictionRound(round.id, tickNumber, currentPriceA, currentPriceB, false);
    }
  }
}

/**
 * Settle a prediction round.
 */
async function settlePredictionRound(
  roundId: number,
  tickNumber: number,
  endPriceA: number,
  endPriceB: number,
  isFlash: boolean,
): Promise<void> {
  const pool = getPool();

  const roundResult = await pool.query<{
    id: number; round_number: number; coin_a: string; coin_b: string;
    start_price_a: string; start_price_b: string; prize_pool: string;
  }>('SELECT * FROM prediction_rounds WHERE id = $1', [roundId]);

  if (roundResult.rows.length === 0) return;
  const round = roundResult.rows[0];

  const startPriceA = parseFloat(round.start_price_a);
  const startPriceB = parseFloat(round.start_price_b);
  const changeA = ((endPriceA - startPriceA) / startPriceA) * 100;
  const changeB = ((endPriceB - startPriceB) / startPriceB) * 100;
  const relativeDiff = Math.abs(changeA - changeB);
  const actualWinner: 'coin_a' | 'coin_b' | 'tie' =
    changeA > changeB ? 'coin_a' : changeB > changeA ? 'coin_b' : 'tie';

  const prizePool = parseFloat(round.prize_pool);
  const treasuryCut = prizePool * PP_TREASURY_CUT;
  const distributablePool = prizePool - treasuryCut;

  // Get all positions
  const positions = await pool.query<{
    id: number; agent_id: string; chosen_coin: string; position_type: string;
    entry_fee: string; base_odds: string; closed_early: boolean;
  }>('SELECT * FROM prediction_positions WHERE round_id = $1 AND closed_early = false', [roundId]);

  let totalLosses = 0;
  const settledPositions: Array<{
    agentId: string;
    payout: number;
    correct: boolean;
    magnitudeCorrect: boolean;
  }> = [];

  await withTransaction(async (client) => {
    for (const pos of positions.rows) {
      const entryFee = parseFloat(pos.entry_fee);
      const baseOdds = parseFloat(pos.base_odds);

      // Hedge always gets 0.3x return
      if (pos.position_type === 'hedge') {
        const payout = entryFee * 0.3;
        const pnl = payout - entryFee;
        totalLosses += Math.max(0, -pnl);

        await client.query(
          'UPDATE agents SET balance = balance + $1 WHERE agent_id = $2',
          [payout, pos.agent_id]
        );
        await client.query(
          `UPDATE prediction_positions SET prediction_correct = null, final_pnl = $1, payout = $2 WHERE id = $3`,
          [pnl.toFixed(4), payout.toFixed(4), pos.id]
        );
        continue;
      }

      // Check if prediction was correct
      const isCorrect = actualWinner === 'tie' ? false : pos.chosen_coin === actualWinner;

      // Check magnitude for big positions
      const isBig = pos.position_type.includes('big');
      const magnitudeCorrect = isBig ? relativeDiff >= 1.0 : relativeDiff < 1.0;

      let payout = 0;
      if (isCorrect) {
        if (isBig && magnitudeCorrect) {
          payout = entryFee * baseOdds; // Full odds for big correct
        } else if (isBig && !magnitudeCorrect) {
          payout = entryFee * 1.1; // Partial for direction-only correct on big
        } else if (!isBig && magnitudeCorrect) {
          payout = entryFee * baseOdds; // Full odds for small correct
        } else {
          payout = entryFee * 0.8; // Small position, magnitude wrong
        }
      } else {
        // Wrong direction: lose
        payout = 0;
      }

      const pnl = payout - entryFee;
      if (pnl < 0) totalLosses += Math.abs(pnl);

      if (payout > 0) {
        await client.query(
          'UPDATE agents SET balance = balance + $1 WHERE agent_id = $2',
          [payout, pos.agent_id]
        );
      }

      // Reputation
      let repChange = 0;
      if (isCorrect) repChange = isBig && magnitudeCorrect ? 10 : 3;
      else repChange = -5;

      await client.query(
        'UPDATE agents SET reputation_score = GREATEST(0, LEAST(1000, reputation_score + $1)) WHERE agent_id = $2',
        [repChange, pos.agent_id]
      );

      await client.query(
        `UPDATE prediction_positions
         SET prediction_correct = $1, magnitude_correct = $2, final_pnl = $3, payout = $4
         WHERE id = $5`,
        [isCorrect, magnitudeCorrect, pnl.toFixed(4), payout.toFixed(4), pos.id]
      );

      settledPositions.push({
        agentId: pos.agent_id,
        payout,
        correct: isCorrect,
        magnitudeCorrect,
      });
    }

    // Update round
    const pgReturn = totalLosses * PP_COMMONS_RETURN_RATE;
    await client.query(
      `UPDATE prediction_rounds SET
        phase = $1, end_price_a = $2, end_price_b = $3,
        change_pct_a = $4, change_pct_b = $5, actual_winner = $6,
        relative_diff = $7, treasury_cut = $8, pg_return = $9,
        flash_settled = $10, flash_tick = $11, settled_at = NOW()
       WHERE id = $12`,
      [isFlash ? 'flash_settled' : 'settled',
       endPriceA.toFixed(8), endPriceB.toFixed(8),
       changeA.toFixed(5), changeB.toFixed(5), actualWinner,
       relativeDiff.toFixed(5), treasuryCut.toFixed(4), pgReturn.toFixed(4),
       isFlash, isFlash ? tickNumber : null, roundId]
    );

    // Flow losses to commons pool
    if (pgReturn > 0) {
      addToPredictionLossPool(pgReturn);
    }

    // Treasury record
    if (treasuryCut > 0) {
      await client.query(
        `INSERT INTO x402_transactions (tx_type, amount, metadata) VALUES ('prediction_treasury', $1, $2)`,
        [treasuryCut.toFixed(6), JSON.stringify({ roundId, reason: 'prediction_treasury_cut' })]
      );
    }
  });

  eventBus.emit('prediction_settled', {
    roundId,
    roundNumber: round.round_number,
    tickNumber,
    coinA: round.coin_a,
    coinB: round.coin_b,
    changeA,
    changeB,
    relativeDiff,
    actualWinner,
    isFlash,
    treasuryCut,
    pgReturn: totalLosses * PP_COMMONS_RETURN_RATE,
  });

  // Legacy ACP hook path is intentionally skipped when the runtime is pinned to ACPV2.
  // The current hook helper still assumes the pre-v2 local job path and can produce
  // misleading legacy/mixed writes during soak. Keep prediction settlement local-only
  // until a dedicated v2 runtime mapping path is introduced.
  if (await shouldRunPredictionAcpHook()) {
    try {
      const { acpJobId } = await createPredictionJob({
        roundId,
        roundNumber: round.round_number,
        coinA: round.coin_a,
        coinB: round.coin_b,
        entryFee: ENTRY_FEE_BASE,
        participantCount: positions.rowCount ?? 0,
        prizePool: Number(round.prize_pool),
      });
      await settlePredictionJob({
        acpJobId,
        roundId,
        winner: actualWinner,
        changePctA: changeA,
        changePctB: changeB,
        flashSettled: isFlash,
        positions: settledPositions,
        treasuryCut,
        commonsReturn: totalLosses * PP_COMMONS_RETURN_RATE,
      });
    } catch (err) { console.warn('[ACP] Prediction settlement hook failed:', err); }
  } else {
    console.info('[ACP] Prediction settlement hook skipped in ACPV2 runtime; legacy local hook path remains disabled.');
  }

  // Verify price signal intel accuracy
  try { await verifyPredictionIntel(round.coin_a, round.coin_b, actualWinner, tickNumber); } catch (err) { console.error('[Intel] prediction verify failed:', err); }

  console.log(
    `[Prediction] Round ${round.round_number} ${isFlash ? 'FLASH' : 'normal'} settled: ` +
    `${round.coin_a}=${changeA.toFixed(3)}% ${round.coin_b}=${changeB.toFixed(3)}% ` +
    `diff=${relativeDiff.toFixed(3)}% winner=${actualWinner}`
  );
}

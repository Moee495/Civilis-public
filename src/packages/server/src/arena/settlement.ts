import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { queueArenaOnchainSync } from './onchain-sync.js';
import { getAgentWalletAddressStrict } from '../agents/wallet-sync.js';
import {
  getAgentTokenId,
} from '../standards/erc8004.js';
import { reputationRegistry } from '../erc8004/reputation-registry.js';
import { calculatePayoff, PayoffResult } from './payoff-matrix.js';
import { getWorldModifierMultiplier } from '../world/modifiers.js';
import { getFateCard, getWuxingRelation, computeDynamicTarotState } from '../fate/fate-engine.js';
import type { FateCard } from '../fate/fate-card.js';
import {
  type FateContext,
  calculateFateTrustDelta,
  getBaseOutcomeDelta,
  isWaterSign,
  getCivilizationModifiers,
  getMBTIModifiers,
  getWuxingRelationModifiers,
} from '../fate/fate-modifiers.js';
import {
  createArenaMemory,
  createBetrayalTrauma,
} from '../fate/memory-engine.js';
import { buildTextMemoryContent } from '../fate/memory-content.js';
import {
  updateAfterArena,
  updateAfterBalanceChange,
  getAllAgentBalances,
} from '../nurture/nurture-updater.js';
import { applyArenaArchetypeEffects } from '../social/social-effects.js';

/**
 * Axelrod probabilistic continuation:
 * - First 2 rounds are mandatory
 * - After round 2+, each round has `continue_probability` (default 70%) chance to continue
 * - Hard cap at `max_rounds` (default 5)
 * - Agents never know if the current round is the last → eliminates end-game betrayal
 *
 * Settlement per round:
 * - Each round settles the full round pool (prize_pool / expected_rounds + carry)
 * - When match ends, a final normalization pass ensures total payouts = prize_pool
 */

/** Minimum guaranteed rounds before probabilistic exit kicks in */
const MIN_ROUNDS = 2;

interface MatchRow {
  id: number;
  match_type: string;
  player_a_id: string;
  player_b_id: string;
  player_a_action: string | null;
  player_a_reason: string | null;
  player_b_action: string | null;
  player_b_reason: string | null;
  prize_pool: string;
  carry_pool: string;
  total_rounds: number;
  max_rounds: number;
  current_round: number;
  continue_probability: string;
  player_a_payout: string;
  player_b_payout: string;
  entry_fee: string;
  status: string;
  commerce_job_id?: number | null;
  acp_job_local_id?: number | null;
  settled_at?: string | null;
}

/**
 * Determine whether the match should continue after the current round.
 * - Rounds 1..(MIN_ROUNDS-1): always continue
 * - Rounds MIN_ROUNDS..(max_rounds-1): continue with `continue_probability`
 * - Round == max_rounds: always stop (hard cap)
 */
function shouldContinue(currentRound: number, maxRounds: number, continueProbability: number): boolean {
  if (currentRound >= maxRounds) return false;
  if (currentRound < MIN_ROUNDS) return true;
  return Math.random() < continueProbability;
}

/**
 * Resolve the current round of a match using Axelrod probabilistic continuation.
 */
export async function resolveRound(matchId: number): Promise<PayoffResult & { roundNumber: number; isFinal: boolean }> {
  const pool = getPool();
  let payoutsCommitted = false;
  const claimResult = await pool.query<MatchRow>(
    `UPDATE arena_matches
     SET status = 'resolving'
     WHERE id = $1
       AND settled_at IS NULL
       AND status IN ('negotiating', 'deciding')
       AND player_a_action IS NOT NULL
       AND player_b_action IS NOT NULL
     RETURNING *`,
    [matchId],
  );

  if (claimResult.rows.length === 0) {
    const current = await pool.query<MatchRow>(
      'SELECT * FROM arena_matches WHERE id = $1',
      [matchId],
    );

    if (current.rows.length === 0) {
      throw new Error('Match not found');
    }

    const match = current.rows[0];
    if (match.settled_at || match.status === 'settled') {
      throw new Error('Match already settled');
    }
    if (match.status === 'resolving') {
      throw new Error('Match is already being resolved');
    }
    if (!match.player_a_action || !match.player_b_action) {
      throw new Error('Match decisions are incomplete');
    }
    throw new Error('Match is not ready for resolution');
  }

  const match = claimResult.rows[0];

  // The claim query above only succeeds once both actions exist, so these are safe.
  const actionA = match.player_a_action as string;
  const actionB = match.player_b_action as string;
  const maxRounds = match.max_rounds || 5;
  const continueProbability = Number(match.continue_probability) || 0.7;

  // Decide if match continues after this round
  const willContinue = shouldContinue(match.current_round, maxRounds, continueProbability);
  const isFinal = !willContinue;

  // Round pool calculation: equal share per round + carry from previous
  const totalPrize = Number(match.prize_pool);
  const carryPool = Number(match.carry_pool);
  // Use max_rounds as denominator for per-round base (conservative split)
  const basePerRound = totalPrize / maxRounds;
  const roundPool = basePerRound + carryPool;

  // Calculate payoff from the matrix (mode-aware)
  const pdPayoutMultiplier =
    (match.match_type ?? 'prisoners_dilemma') === 'prisoners_dilemma'
      ? await getWorldModifierMultiplier({
          domain: 'arena',
          modifierType: 'pd_payout_multiplier',
        })
      : 1;

  const payoff = calculatePayoff(
    actionA,
    actionB,
    roundPool,
    match.match_type ?? 'prisoners_dilemma',
    { pdPayoutMultiplier },
  );

  // Snowball: non-final rounds settle 70%, carry 30%; final settles 100%
  const settleRatio = isFinal ? 1.0 : 0.7;
  const settleAmount = roundPool * settleRatio;
  const carryAmount = isFinal ? 0 : roundPool * 0.3;

  const scale = settleAmount / roundPool;
  let roundPayoutA = Number((payoff.playerAPayout * scale).toFixed(6));
  let roundPayoutB = Number((payoff.playerBPayout * scale).toFixed(6));
  const roundTreasury = Number((payoff.treasuryDelta * scale).toFixed(6));

  // If final round, normalize total payouts to exactly match prize_pool
  let cumulativePayoutA = Number(match.player_a_payout) + roundPayoutA;
  let cumulativePayoutB = Number(match.player_b_payout) + roundPayoutB;

  if (isFinal) {
    const totalPaidOut = cumulativePayoutA + cumulativePayoutB;
    if (totalPaidOut > 0 && Math.abs(totalPaidOut - totalPrize) > 0.001) {
      // Normalize: distribute remaining prize proportionally
      const remaining = totalPrize - (Number(match.player_a_payout) + Number(match.player_b_payout));
      if (remaining > 0) {
        const ratioA = payoff.playerAPayout / (payoff.playerAPayout + payoff.playerBPayout);
        roundPayoutA = Number((remaining * ratioA).toFixed(6));
        roundPayoutB = Number((remaining * (1 - ratioA)).toFixed(6));
        cumulativePayoutA = Number(match.player_a_payout) + roundPayoutA;
        cumulativePayoutB = Number(match.player_b_payout) + roundPayoutB;
      }
    }
  }

  try {
    // Transfer payouts first so on-chain treasury disbursements happen before local settlement is finalized.
    if (roundPayoutA > 0) {
      await processX402Payment('arena_action', null, match.player_a_id, roundPayoutA, {
        matchId,
        round: match.current_round,
        reason: 'arena_round_settlement',
      });
    }
    if (roundPayoutB > 0) {
      await processX402Payment('arena_action', null, match.player_b_id, roundPayoutB, {
        matchId,
        round: match.current_round,
        reason: 'arena_round_settlement',
      });
    }
    payoutsCommitted = true;

    await withTransaction(async (client) => {
      // Record round result once per match/round. The unique key blocks any duplicate
      // round finalization if an older request races behind the resolver.
      await client.query(
        `INSERT INTO arena_rounds
          (match_id, round_number, player_a_action, player_a_reason, player_b_action, player_b_reason, round_pool, settle_amount, carry_amount, player_a_payout, player_b_payout, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          matchId,
          match.current_round,
          actionA,
          match.player_a_reason,
          actionB,
          match.player_b_reason,
          roundPool.toFixed(6),
          settleAmount.toFixed(6),
          carryAmount.toFixed(6),
          roundPayoutA.toFixed(6),
          roundPayoutB.toFixed(6),
          payoff.outcome,
        ],
      );

      if (isFinal) {
        // Match ends: set total_rounds to actual rounds played, settle
        await client.query(
          `UPDATE arena_matches
           SET status = 'settled',
               total_rounds = $1,
               player_a_action = $2,
               player_a_reason = $3,
               player_b_action = $4,
               player_b_reason = $5,
               player_a_payout = $6,
               player_b_payout = $7,
               carry_pool = 0,
               winner_id = $8,
               settled_at = NOW()
           WHERE id = $9`,
          [
            match.current_round,
            actionA,
            match.player_a_reason,
            actionB,
            match.player_b_reason,
            cumulativePayoutA.toFixed(6),
            cumulativePayoutB.toFixed(6),
            cumulativePayoutA > cumulativePayoutB ? match.player_a_id
              : cumulativePayoutB > cumulativePayoutA ? match.player_b_id
              : null,
            matchId,
          ],
        );

        if (roundTreasury > 0) {
          await client.query(
            `INSERT INTO x402_transactions (tx_type, amount, metadata)
             VALUES ('arena_action', $1, $2)`,
            [
              roundTreasury.toFixed(6),
              JSON.stringify({ matchId, round: match.current_round, treasuryDelta: roundTreasury, reason: 'arena_surplus' }),
            ],
          );
        }
      } else {
        // Continue: advance round, reset actions, carry pool forward
        await client.query(
          `UPDATE arena_matches
           SET current_round = current_round + 1,
               player_a_action = NULL,
               player_a_reason = NULL,
               player_b_action = NULL,
               player_b_reason = NULL,
               player_a_payout = $1,
               player_b_payout = $2,
               carry_pool = $3,
               status = 'negotiating',
               negotiation_deadline = $4
           WHERE id = $5`,
          [
            cumulativePayoutA.toFixed(6),
            cumulativePayoutB.toFixed(6),
            carryAmount.toFixed(6),
            new Date(Date.now() + 30_000).toISOString(),
            matchId,
          ],
        );
      }

      // Trust update every round (with fate modifiers)
      await updateTrustAfterArena(client, match.player_a_id, match.player_b_id, payoff.outcome, match.match_type, roundPayoutA, roundPayoutB);

      // Legacy memory for this round — agents don't know total rounds
      await insertArenaMemory(
        client, match.player_a_id, match.player_b_id,
        actionA, actionB, roundPayoutA,
        match.current_round, isFinal,
      );
      await insertArenaMemory(
        client, match.player_b_id, match.player_a_id,
        actionB, actionA, roundPayoutB,
        match.current_round, isFinal,
      );
    });
  } catch (error) {
    if (!payoutsCommitted) {
      await pool.query(
        `UPDATE arena_matches
         SET status = 'deciding'
         WHERE id = $1
           AND status = 'resolving'
           AND settled_at IS NULL`,
        [matchId],
      ).catch(() => {});
    }
    throw error;
  }

  // ── Enhanced memory engine: structured arena memories + betrayal trauma ──
  const currentTick = await getCurrentTick();

  // Create structured arena memories for both players
  await createArenaMemory(match.player_a_id, {
    matchId, matchType: match.match_type,
    opponentId: match.player_b_id,
    myAction: actionA, opponentAction: actionB,
    outcome: payoff.outcome,
    reward: roundPayoutA,
    trustChange: payoff.outcome === 'CC' ? 10 : payoff.outcome === 'CD' ? 5 : payoff.outcome === 'DC' ? -15 : -5,
  }, currentTick).catch(() => {}); // non-blocking

  await createArenaMemory(match.player_b_id, {
    matchId, matchType: match.match_type,
    opponentId: match.player_a_id,
    myAction: actionB, opponentAction: actionA,
    outcome: swapOutcome(payoff.outcome),
    reward: roundPayoutB,
    trustChange: payoff.outcome === 'CC' ? 10 : payoff.outcome === 'DC' ? 5 : payoff.outcome === 'CD' ? -15 : -5,
  }, currentTick).catch(() => {});

  // Create betrayal traumas
  if (payoff.outcome === 'CD') {
    // A was betrayed by B
    await createBetrayalTrauma(match.player_a_id, match.player_b_id, undefined, match.match_type, currentTick).catch(() => {});
  }
  if (payoff.outcome === 'DC') {
    // B was betrayed by A
    await createBetrayalTrauma(match.player_b_id, match.player_a_id, undefined, match.match_type, currentTick).catch(() => {});
  }

  // ── Nurture dimension updates ──
  const matchTypeNurture = (match.match_type ?? 'prisoners_dilemma') as 'prisoners_dilemma' | 'resource_grab' | 'info_auction';
  await updateAfterArena(
    match.player_a_id, matchTypeNurture, payoff.outcome,
    match.player_b_id, actionA, actionB,
    roundPayoutA, currentTick,
  ).catch(() => {});
  await updateAfterArena(
    match.player_b_id, matchTypeNurture, swapOutcome(payoff.outcome),
    match.player_a_id, actionB, actionA,
    roundPayoutB, currentTick,
  ).catch(() => {});

  // ── Archetype-specific arena effects ──
  const archetypeA = (await pool.query<{ archetype: string }>('SELECT archetype FROM agents WHERE agent_id = $1', [match.player_a_id])).rows[0]?.archetype;
  const archetypeB = (await pool.query<{ archetype: string }>('SELECT archetype FROM agents WHERE agent_id = $1', [match.player_b_id])).rows[0]?.archetype;
  if (archetypeA) await applyArenaArchetypeEffects(match.player_a_id, archetypeA, match.player_b_id, payoff.outcome).catch(() => {});
  if (archetypeB) await applyArenaArchetypeEffects(match.player_b_id, archetypeB, match.player_a_id, swapOutcome(payoff.outcome)).catch(() => {});

  // Update wealth psychology with new balances
  const allBalances = await getAllAgentBalances();
  const newBalA = allBalances[match.player_a_id] ?? 0;
  const newBalB = allBalances[match.player_b_id] ?? 0;
  await updateAfterBalanceChange(match.player_a_id, newBalA, allBalances).catch(() => {});
  await updateAfterBalanceChange(match.player_b_id, newBalB, allBalances).catch(() => {});

  // Reputation mirroring every round
  await mirrorReputation(match.player_a_id, match.player_b_id, payoff.outcome, matchId, match.match_type, roundPayoutA, roundPayoutB);

  if (isFinal) {
    queueArenaOnchainSync(matchId);

    // Info auction winner gets real intel about opponent's strategy history
    if (match.match_type === 'info_auction' && cumulativePayoutA !== cumulativePayoutB) {
      await grantInfoAuctionIntel(
        cumulativePayoutA > cumulativePayoutB ? match.player_a_id : match.player_b_id,
        cumulativePayoutA > cumulativePayoutB ? match.player_b_id : match.player_a_id,
        matchId,
      );
    }
  }

  eventBus.emit(isFinal ? 'arena_settled' : 'arena_round_settled', {
    matchId,
    round: match.current_round,
    maxRounds,
    isFinal,
    playerAId: match.player_a_id,
    playerBId: match.player_b_id,
    playerAAction: actionA,
    playerAReason: match.player_a_reason,
    playerBAction: actionB,
    playerBReason: match.player_b_reason,
    outcome: payoff.outcome,
    roundPayoutA,
    roundPayoutB,
    cumulativePayoutA,
    cumulativePayoutB,
    carryPool: carryAmount,
    continueProbability,
    narrative: payoff.narrative,
  });

  console.log(
    `[Arena] match #${matchId} R${match.current_round}` +
    (isFinal ? ` [FINAL after ${match.current_round} rounds]` : `/${maxRounds}max`) +
    `: ${payoff.outcome} | settle=${settleAmount.toFixed(3)} carry=${carryAmount.toFixed(3)}` +
    ` | A=${roundPayoutA.toFixed(3)} B=${roundPayoutB.toFixed(3)}` +
    ` | p(continue)=${continueProbability}`,
  );

  return {
    ...payoff,
    playerAPayout: roundPayoutA,
    playerBPayout: roundPayoutB,
    treasuryDelta: roundTreasury,
    roundNumber: match.current_round,
    isFinal,
  };
}

/**
 * Legacy wrapper — settles the current round.
 */
export async function settleMatch(matchId: number): Promise<PayoffResult> {
  return resolveRound(matchId);
}

async function insertArenaMemory(
  client: PoolClient,
  agentId: string,
  opponentId: string,
  myAction: string,
  opponentAction: string,
  payout: number,
  round: number,
  isFinal: boolean,
): Promise<void> {
  // Agents don't know if this is the final round — just report current round
  const roundTag = ` (第${round}轮${isFinal ? '·最终轮' : ''})`;
  await client.query(
    `INSERT INTO agent_memories (agent_id, memory_type, content, importance, tick_created)
     VALUES (
       $1,
       'arena',
       $2,
       8,
       (SELECT COALESCE(MAX(tick_number), 0) FROM tick_snapshots)
     )`,
    [
      agentId,
      buildTextMemoryContent(
        `竞技场 vs ${opponentId}${roundTag}: 我选择${translateAction(
          myAction,
        )}，对方选择${translateAction(opponentAction)}，本轮获得 ${payout.toFixed(3)} USDT`,
        {
          opponentId,
          myAction,
          opponentAction,
          payout,
          round,
          isFinal,
          source: 'arena_legacy',
        },
      ),
    ],
  );
}

const ACTION_LABELS: Record<string, string> = {
  cooperate: '合作',
  betray: '背叛',
  claim_low: '低索取',
  claim_mid: '中索取',
  claim_high: '高索取',
  bid_low: '低出价',
  bid_mid: '中出价',
  bid_high: '高出价',
};

function translateAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

async function updateTrustAfterArena(
  client: PoolClient,
  playerAId: string,
  playerBId: string,
  outcome: string,
  matchType: string,
  payoutA: number,
  payoutB: number,
): Promise<void> {
  // Load fate cards for both players (true = viewerPaid, internal use)
  const [fateCardA, fateCardB] = await Promise.all([
    getFateCard(playerAId, true),
    getFateCard(playerBId, true),
  ]);

  // FIX-2: Compute dynamic tarot states
  const [tarotStateA, tarotStateB] = await Promise.all([
    computeDynamicTarotState(playerAId, fateCardA.initialTarotState ?? 'upright'),
    computeDynamicTarotState(playerBId, fateCardB.initialTarotState ?? 'upright'),
  ]);

  const hasFate = fateCardA.mbti && fateCardB.mbti;

  // PD outcomes: CC, CD, DC, DD
  const pdTrust: Record<string, { ab: number; ba: number }> = {
    CC: { ab: 10, ba: 10 },
    CD: { ab: 5, ba: -15 },
    DC: { ab: -15, ba: 5 },
    DD: { ab: -5, ba: -5 },
  };

  if (matchType === 'prisoners_dilemma' && pdTrust[outcome]) {
    let deltaAB = pdTrust[outcome].ab;
    let deltaBA = pdTrust[outcome].ba;

    // D-2 Fix: Diminishing returns for consecutive CC with same opponent (anti-farming)
    if (outcome === 'CC') {
      const recentCC = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM arena_matches
         WHERE status = 'settled'
           AND ((player_a_id = $1 AND player_b_id = $2) OR (player_a_id = $2 AND player_b_id = $1))
           AND player_a_action = 'cooperate' AND player_b_action = 'cooperate'
           AND created_at > NOW() - INTERVAL '30 minutes'`,
        [playerAId, playerBId],
      );
      const ccCount = Number(recentCC.rows[0]?.cnt ?? 0);
      if (ccCount > 2) {
        // After 2 recent CC with same opponent, trust gains diminish rapidly
        const decay = Math.max(0.1, 1 / ccCount);
        deltaAB = Math.round(deltaAB * decay);
        deltaBA = Math.round(deltaBA * decay);
      }
    }

    // Apply fate modifiers if fate cards are available
    if (hasFate) {
      const fateCtxA = fateCardToContext(fateCardA, tarotStateA);
      const fateCtxB = fateCardToContext(fateCardB, tarotStateB);
      deltaAB = calculateFateTrustDelta(deltaAB, fateCtxA, fateCtxB, outcome);
      // For B's perspective, swap the outcome (CD → DC)
      const outcomeB = outcome === 'CD' ? 'DC' : outcome === 'DC' ? 'CD' : outcome;
      deltaBA = calculateFateTrustDelta(deltaBA, fateCtxB, fateCtxA, outcomeB);
    }

    await adjustTrust(client, playerAId, playerBId, Math.round(deltaAB));
    await adjustTrust(client, playerBId, playerAId, Math.round(deltaBA));
    return;
  }

  // For resource_grab and info_auction: trust based on relative payouts
  if (Math.abs(payoutA - payoutB) < 0.001) {
    await adjustTrust(client, playerAId, playerBId, 5);
    await adjustTrust(client, playerBId, playerAId, 5);
  } else {
    const winnerId = payoutA > payoutB ? playerAId : playerBId;
    const loserId = payoutA > payoutB ? playerBId : playerAId;
    let winnerDelta = 3;
    let loserDelta = -8;

    // Apply fate modifiers for non-PD matches
    if (hasFate) {
      const winnerFate = payoutA > payoutB ? fateCardToContext(fateCardA, tarotStateA) : fateCardToContext(fateCardB, tarotStateB);
      const loserFate = payoutA > payoutB ? fateCardToContext(fateCardB, tarotStateB) : fateCardToContext(fateCardA, tarotStateA);
      // Civilization and wuxing affinity affect trust in non-PD matches too
      const wuxingRel = getWuxingRelationModifiers(winnerFate.wuxing, loserFate.wuxing);
      winnerDelta += Math.round(wuxingRel.trustBaseline / 3);
      loserDelta += Math.round(wuxingRel.trustBaseline / 3);
    }

    await adjustTrust(client, winnerId, loserId, winnerDelta);
    await adjustTrust(client, loserId, winnerId, loserDelta);
  }
}

/** Convert a partial FateCard to a FateContext for modifier calculations */
function fateCardToContext(card: Partial<FateCard>, dynamicTarotState?: 'upright' | 'reversed'): FateContext {
  return {
    mbti: card.mbti ?? 'INTJ',
    wuxing: card.wuxing ?? '土',
    zodiac: card.zodiac ?? 'Aries',
    tarotName: card.tarotName ?? 'The Fool',
    tarotState: dynamicTarotState ?? card.initialTarotState ?? 'upright',
    civilization: card.civilization ?? 'western',
  };
}

async function adjustTrust(
  client: PoolClient,
  fromAgentId: string,
  toAgentId: string,
  delta: number,
): Promise<void> {
  await client.query(
    `INSERT INTO trust_relations
      (from_agent_id, to_agent_id, trust_score, interaction_count, last_interaction_at)
     VALUES ($1, $2, GREATEST(0, LEAST(100, 50 + $3)), 1, NOW())
     ON CONFLICT (from_agent_id, to_agent_id)
     DO UPDATE SET
       trust_score = GREATEST(0, LEAST(100, trust_relations.trust_score + $3)),
       interaction_count = trust_relations.interaction_count + 1,
       last_interaction_at = NOW(),
       updated_at = NOW()`,
    [fromAgentId, toAgentId, delta],
  );
}

async function grantInfoAuctionIntel(
  winnerId: string,
  loserId: string,
  matchId: number,
): Promise<void> {
  const pool = getPool();
  // Query opponent's recent arena actions for real intel
  const opponentHistory = await pool.query<{ outcome: string; round_number: number }>(
    `SELECT ar.outcome, ar.round_number
     FROM arena_rounds ar
     JOIN arena_matches am ON ar.match_id = am.id
     WHERE am.player_a_id = $1 OR am.player_b_id = $1
     ORDER BY ar.created_at DESC LIMIT 10`,
    [loserId],
  );

  const intelSummary = opponentHistory.rows.length > 0
    ? opponentHistory.rows.map(r => r.outcome).join(', ')
    : '无历史数据';

  await pool.query(
    `INSERT INTO agent_memories (agent_id, memory_type, content, importance, tick_created)
     VALUES ($1, 'intel', $2, 9, (SELECT COALESCE(MAX(tick_number), 0) FROM tick_snapshots))`,
    [
      winnerId,
      buildTextMemoryContent(
        `[情报拍卖获胜 #${matchId}] 获得 ${loserId} 的近期策略数据: ${intelSummary}`,
        {
          matchId,
          loserId,
          intelSummary,
          source: 'info_auction',
        },
      ),
    ],
  );

  console.log(`[Arena] Info auction #${matchId}: ${winnerId} won intel about ${loserId}`);
}

/** Swap outcome perspective: CD → DC, DC → CD */
function swapOutcome(outcome: string): string {
  if (outcome === 'CD') return 'DC';
  if (outcome === 'DC') return 'CD';
  return outcome;
}

/** Get the current tick number from tick_snapshots */
async function getCurrentTick(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ tick_number: number }>(
    'SELECT COALESCE(MAX(tick_number), 0) as tick_number FROM tick_snapshots',
  );
  return Number(result.rows[0]?.tick_number ?? 0);
}

async function mirrorReputation(
  playerAId: string,
  playerBId: string,
  outcome: string,
  matchId: number,
  matchType: string,
  payoutA: number,
  payoutB: number,
): Promise<void> {
  let scoreA = 0;
  let scoreB = 0;

  if (matchType === 'prisoners_dilemma') {
    const scoreByOutcome: Record<string, [number, number]> = {
      CC: [10, 10],
      CD: [5, -15],
      DC: [-15, 5],
      DD: [-5, -5],
    };
    const scores = scoreByOutcome[outcome] ?? [0, 0];
    scoreA = scores[0];
    scoreB = scores[1];
  } else {
    // resource_grab / info_auction: reputation based on payouts
    scoreA = payoutA >= payoutB ? 5 : -3;
    scoreB = payoutB >= payoutA ? 5 : -3;
  }

  // Always update the local DB reputation_score (clamped to 0–1000)
  const pool = getPool();
  await pool.query(
    `UPDATE agents SET reputation_score = GREATEST(0, LEAST(1000, reputation_score + $1)) WHERE agent_id = $2`,
    [scoreA, playerAId],
  );
  await pool.query(
    `UPDATE agents SET reputation_score = GREATEST(0, LEAST(1000, reputation_score + $1)) WHERE agent_id = $2`,
    [scoreB, playerBId],
  );

  // Also mirror to on-chain ERC-8004 if configured
  const [tokenA, tokenB] = await Promise.all([
    getAgentTokenId(playerAId),
    getAgentTokenId(playerBId),
  ]);

  const endpoint = `civilis://arena/match/${matchId}`;

  if (matchType === 'prisoners_dilemma') {
    if (tokenA && tokenB) {
      await reputationRegistry.reportPDOutcome({
        playerA: {
          agentId: playerAId,
          tokenId: tokenA,
          cooperated: outcome === 'CC' || outcome === 'CD',
        },
        playerB: {
          agentId: playerBId,
          tokenId: tokenB,
          cooperated: outcome === 'CC' || outcome === 'DC',
        },
        matchId,
      });
    }
  } else {
    const tag = matchType === 'resource_grab' ? 'arena_resource' : 'arena_auction';
    const [clientForA, clientForB] = await Promise.all([
      getAgentWalletAddressStrict(playerBId),
      getAgentWalletAddressStrict(playerAId),
    ]);
    if (tokenA) {
      reputationRegistry.queueFeedback({
        agentId: playerAId,
        erc8004TokenId: tokenA,
        value: scoreA,
        valueDecimals: 0,
        clientAddress: clientForA,
        tag1: tag,
        tag2: 'civilis',
        endpoint,
        metadata: { matchId, matchType, outcome, payout: payoutA, opponent: playerBId },
      });
    }
    if (tokenB) {
      reputationRegistry.queueFeedback({
        agentId: playerBId,
        erc8004TokenId: tokenB,
        value: scoreB,
        valueDecimals: 0,
        clientAddress: clientForB,
        tag1: tag,
        tag2: 'civilis',
        endpoint,
        metadata: { matchId, matchType, outcome, payout: payoutB, opponent: playerAId },
      });
    }
  }
}

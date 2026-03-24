/**
 * ERC-8183 Prediction Hook — Oracle's Eye Escrow & Settlement
 *
 * Manages prediction round lifecycle:
 *   createJob (all entry fees) → fund (prize pool escrow)
 *     → submit (price oracle result) → complete (distribute by position odds)
 *
 * Flash settlement: if 1% price diff before expiry, auto-settles early.
 */

import { getACPClient } from '../acp-client.js';
import { reputationRegistry } from '../../erc8004/reputation-registry.js';
import { getPool } from '../../db/postgres.js';
import type { ACPCategory } from '../acp-types.js';

/**
 * Create an ACP job for a prediction round.
 */
export async function createPredictionJob(params: {
  roundId: number;
  roundNumber: number;
  coinA: string;
  coinB: string;
  entryFee: number;
  participantCount: number;
  prizePool: number;
}): Promise<{ acpJobId: number }> {
  const { roundId, roundNumber, coinA, coinB, entryFee, participantCount, prizePool } = params;
  const acp = getACPClient();

  const { localId } = await acp.createAndFundJob({
    category: 'prediction_round' as ACPCategory,
    txType: 'arena_entry', // reuse entry fee tx type
    clientAgentId: null,    // treasury as client (pool)
    providerAgentId: null,  // distributed to winners
    budget: prizePool,
    description: `prediction_R${roundNumber}_${coinA}_vs_${coinB}`,
    hook: 'prediction' as any,
    expirySeconds: 360,     // 6 minutes (10 ticks × 30s + buffer)
    metadata: {
      roundId,
      roundNumber,
      coinA,
      coinB,
      entryFee,
      participantCount,
      prizePool,
    },
  });

  return { acpJobId: localId };
}

/**
 * Submit oracle price result and settle the prediction round.
 */
export async function settlePredictionJob(params: {
  acpJobId: number;
  roundId: number;
  winner: 'coin_a' | 'coin_b' | 'tie';
  changePctA: number;
  changePctB: number;
  flashSettled: boolean;
  positions: Array<{
    agentId: string;
    payout: number;
    correct: boolean;
    magnitudeCorrect: boolean;
  }>;
  treasuryCut: number;
  commonsReturn: number;
}): Promise<void> {
  const {
    acpJobId, roundId, winner, changePctA, changePctB, flashSettled,
    positions, treasuryCut, commonsReturn,
  } = params;

  const acp = getACPClient();

  // Submit the oracle result
  const deliverable = `oracle_${roundId}_winner_${winner}_${changePctA.toFixed(4)}_${changePctB.toFixed(4)}${flashSettled ? '_FLASH' : ''}`;
  await acp.submitJob(acpJobId, deliverable);

  // Complete the job (releases escrow)
  const reason = `settled_${roundId}_treasury_${treasuryCut.toFixed(3)}_commons_${commonsReturn.toFixed(3)}`;
  await acp.completeJob(acpJobId, reason);

  // Post reputation feedback for each position
  const pool = getPool();
  for (const pos of positions) {
    const tokenR = await pool.query<{ erc8004_token_id: number }>(
      'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
      [pos.agentId],
    );
    const tokenId = tokenR.rows[0]?.erc8004_token_id;
    if (tokenId) {
      await reputationRegistry.reportPredictionOutcome({
        agentId: pos.agentId,
        tokenId,
        correct: pos.correct,
        magnitudeCorrect: pos.magnitudeCorrect,
        roundId,
      });
    }
  }
}

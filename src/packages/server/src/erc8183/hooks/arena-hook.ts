/**
 * ERC-8183 Arena Hook — PD Match Escrow & Settlement
 *
 * Manages the full lifecycle of Prisoner's Dilemma matches:
 *   createJob (both entry fees) → fund (escrow) → submit (round results) → complete (payout)
 *
 * On-chain, the ArenaHook IACPHook contract:
 *   beforeAction(fund): validates both players have deposited
 *   afterAction(complete): distributes based on payoff matrix
 */

import { getACPClient } from '../acp-client.js';
import type { ACPCategory } from '../acp-types.js';

/**
 * Create a record-only ACP job for a new arena match.
 * Arena funds are already moved via x402, so this path only anchors
 * the business on ACPV2 for CivilisCommerceV2 mapping.
 */
export async function createArenaJob(params: {
  matchId: number;
  playerAId: string;
  playerBId: string;
  entryFee: number;
  matchType?: string;
}): Promise<{ acpJobId: number }> {
  const { matchId, playerAId, playerBId, entryFee, matchType = 'prisoners_dilemma' } = params;
  const acp = getACPClient();

  const { localId } = await acp.createOpenJob({
    category: 'arena_match' as ACPCategory,
    txType: 'arena_entry',
    providerAgentId: null,
    description: `arena_record_${matchType}_${matchId}`,
    metadata: {
      matchId,
      playerAId,
      playerBId,
      entryFee,
      type: matchType,
      settlement: 'x402_direct_wallet',
      acpMode: 'record_only',
    },
  });

  return { acpJobId: localId };
}

/**
 * Submit round results to the ACP job.
 */
export async function submitArenaRound(params: {
  acpJobId: number;
  matchId: number;
  roundNumber: number;
  playerAAction: string;
  playerBAction: string;
  outcome: string;
}): Promise<void> {
  const acp = getACPClient();
  const deliverable = `round_${params.roundNumber}_${params.playerAAction}_${params.playerBAction}_${params.outcome}`;

  // Only submit on final round (or when match ends)
  // Intermediate rounds are tracked locally
  await acp.submitJob(params.acpJobId, deliverable);
}

/**
 * Complete the arena match — release escrowed funds to winner(s).
 */
export async function settleArenaJob(params: {
  acpJobId: number;
  matchId: number;
  matchType: string;
  playerAAction: string;
  playerBAction: string;
  playerAPayout: number;
  playerBPayout: number;
}): Promise<void> {
  const {
    acpJobId, matchId,
    matchType,
    playerAAction,
    playerBAction,
    playerAPayout,
    playerBPayout,
  } = params;

  const acp = getACPClient();
  const deliverable = `match_${matchType}_${matchId}_${playerAAction}_${playerBAction}`;
  const reason = `settled_${matchId}_A${playerAPayout.toFixed(3)}_B${playerBPayout.toFixed(3)}`;

  await acp.submitJob(acpJobId, deliverable);
  await acp.completeJob(acpJobId, reason);
}

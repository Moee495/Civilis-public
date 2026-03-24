/**
 * Info Auction (信息拍卖) — Dedicated Processor
 *
 * A sealed-bid auction where both players bid for a valuable "intel package"
 * (information advantage for future rounds). The winner gets the intel and
 * a trust bonus; the loser keeps their bid but gains nothing.
 *
 * Actions: bid_low (0.2 USDT) | bid_mid (0.5 USDT) | bid_high (0.8 USDT)
 *
 * Special mechanic: Winner of info_auction gets a memory entry with opponent's
 * recent strategy data (real intel from the system, not fabricated).
 *
 * This processor re-exports the shared settlement logic with info_auction
 * defaults and provides helper utilities for the info auction game mode.
 */

import { calculatePayoff, PayoffResult, VALID_ACTIONS } from './payoff-matrix.js';
import { resolveRound } from './settlement.js';

export const INFO_AUCTION_ACTIONS = VALID_ACTIONS.info_auction;

export const BID_VALUES: Record<string, number> = {
  bid_low: 0.2,
  bid_mid: 0.5,
  bid_high: 0.8,
};

/**
 * Determine the auction winner (or tie).
 */
export function getAuctionResult(
  actionA: string,
  actionB: string,
): 'A' | 'B' | 'tie' {
  const bidA = BID_VALUES[actionA] ?? 0.5;
  const bidB = BID_VALUES[actionB] ?? 0.5;

  if (bidA === bidB) return 'tie';
  return bidA > bidB ? 'A' : 'B';
}

/**
 * Calculate info auction payoff (convenience wrapper).
 */
export function calculateInfoAuctionPayoff(
  actionA: string,
  actionB: string,
  prizePool: number = 2.0,
): PayoffResult {
  return calculatePayoff(actionA, actionB, prizePool, 'info_auction');
}

/**
 * Resolve an info auction round (delegates to shared settlement).
 * The intel reward for the winner is handled in settlement.ts via grantInfoAuctionIntel().
 */
export async function resolveInfoAuctionRound(matchId: number) {
  return resolveRound(matchId);
}

/**
 * Info auction defaults:
 * - Shorter matches (max 3 rounds)
 * - Lower continuation probability (0.50)
 */
export const INFO_AUCTION_DEFAULTS = {
  maxRounds: 3,
  continueProbability: 0.50,
} as const;

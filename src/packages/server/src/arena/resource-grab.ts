/**
 * Resource Grab (资源争夺) — Dedicated Processor
 *
 * A zero-sum resource allocation game. Each player secretly bids how much of
 * the prize pool they claim. If combined claims ≤ 100%, both get what they
 * claimed. If combined claims > 100%, a "conflict" occurs and both lose.
 *
 * Actions: claim_low (30%) | claim_mid (50%) | claim_high (70%)
 *
 * This processor re-exports the shared settlement logic with resource_grab
 * defaults and provides helper utilities for the resource grab game mode.
 */

import { calculatePayoff, PayoffResult, VALID_ACTIONS } from './payoff-matrix.js';
import { resolveRound } from './settlement.js';

export const RESOURCE_GRAB_ACTIONS = VALID_ACTIONS.resource_grab;

export const CLAIM_PERCENTAGES: Record<string, number> = {
  claim_low: 0.30,
  claim_mid: 0.50,
  claim_high: 0.70,
};

/**
 * Determine conflict severity for a resource grab outcome.
 */
export function getConflictLevel(
  actionA: string,
  actionB: string,
): 'none' | 'mild' | 'severe' {
  const pctA = CLAIM_PERCENTAGES[actionA] ?? 0.50;
  const pctB = CLAIM_PERCENTAGES[actionB] ?? 0.50;
  const total = pctA + pctB;

  if (total <= 1.0) return 'none';
  if (total <= 1.2) return 'mild';
  return 'severe';
}

/**
 * Calculate resource grab payoff (convenience wrapper).
 */
export function calculateResourceGrabPayoff(
  actionA: string,
  actionB: string,
  prizePool: number = 2.0,
): PayoffResult {
  return calculatePayoff(actionA, actionB, prizePool, 'resource_grab');
}

/**
 * Resolve a resource grab round (delegates to shared settlement).
 */
export async function resolveResourceGrabRound(matchId: number) {
  return resolveRound(matchId);
}

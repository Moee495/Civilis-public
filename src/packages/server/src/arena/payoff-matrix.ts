export interface PayoffResult {
  playerAPayout: number;
  playerBPayout: number;
  treasuryDelta: number;
  outcome: string;
  narrative: string;
  pdPayoutSemantics?: PdPayoutSemantics;
}

interface PayoffOptions {
  pdPayoutMultiplier?: number;
}

export interface PdPayoutSemantics {
  semanticsMode: 'treasury_cut_inverse';
  requestedMultiplier: number;
  effectiveMultiplier: number;
  baseTreasuryCutRate: number;
  effectiveTreasuryCutRate: number;
  baseNetPoolShare: number;
  effectiveNetPoolShare: number;
  playerShareDelta: number;
  note: string;
}

/** Valid actions per match type */
export const VALID_ACTIONS: Record<string, string[]> = {
  prisoners_dilemma: ['cooperate', 'betray'],
  resource_grab: ['claim_low', 'claim_mid', 'claim_high'],  // Legacy
  info_auction: ['bid_low', 'bid_mid', 'bid_high'],          // Legacy
  commons: ['contribute', 'free_ride', 'hoard', 'sabotage'],
  prediction: ['long_small', 'long_big', 'short_small', 'short_big', 'hedge'],
};

// ── Dynamic PD treasury cut rate (adjustable by economy regulator) ──
export let pdTreasuryCutRate = 0.08;
export function setPdTreasuryCutRate(rate: number): void {
  pdTreasuryCutRate = Math.max(0.05, Math.min(0.12, rate));
}

export function resolvePdPayoutSemantics(requestedMultiplier: number = 1): PdPayoutSemantics {
  const effectiveMultiplier = Math.max(0.4, Math.min(requestedMultiplier, 1.5));
  const effectiveTreasuryCutRate = Math.max(0.02, Math.min(0.2, pdTreasuryCutRate / effectiveMultiplier));
  const baseNetPoolShare = 1 - pdTreasuryCutRate;
  const effectiveNetPoolShare = 1 - effectiveTreasuryCutRate;

  return {
    semanticsMode: 'treasury_cut_inverse',
    requestedMultiplier,
    effectiveMultiplier,
    baseTreasuryCutRate: pdTreasuryCutRate,
    effectiveTreasuryCutRate,
    baseNetPoolShare,
    effectiveNetPoolShare,
    playerShareDelta: effectiveNetPoolShare - baseNetPoolShare,
    note: 'pd_payout_multiplier currently changes PD player payouts by compressing or expanding the treasury cut. It does not mint extra prize pool.',
  };
}

export function calculatePayoff(
  actionA: string,
  actionB: string,
  prizePool: number = 2.0,
  matchType: string = 'prisoners_dilemma',
  options?: PayoffOptions,
): PayoffResult {
  switch (matchType) {
    case 'resource_grab':
      return calculateResourceGrab(actionA, actionB, prizePool);
    case 'info_auction':
      return calculateInfoAuction(actionA, actionB, prizePool);
    case 'prisoners_dilemma':
    default:
      return calculatePrisonersDilemma(actionA, actionB, prizePool, options);
  }
}

// ── Prisoner's Dilemma ──
// Base ratios preserved (CC: 1.2x, CD: 0.2x/1.8x, DD: 0.6x)
// Global 8% treasury cut applied on top

function calculatePrisonersDilemma(
  actionA: string,
  actionB: string,
  prizePool: number,
  options?: PayoffOptions,
): PayoffResult {
  const pdPayoutSemantics = resolvePdPayoutSemantics(options?.pdPayoutMultiplier ?? 1);
  const effectiveTreasuryCutRate = pdPayoutSemantics.effectiveTreasuryCutRate;
  const treasuryCut = prizePool * effectiveTreasuryCutRate;
  const netPool = prizePool - treasuryCut;
  const netBase = netPool / 2;

  if (actionA === 'cooperate' && actionB === 'cooperate') {
    // CC: Each gets 50% of net pool (fair split, no overpay)
    // The "cooperation bonus" is that both keep more than DD outcome
    const rawA = netPool * 0.48; // Slight bonus over 50% base, but never exceeds pool
    const rawB = netPool * 0.48;
    const surplus = netPool - rawA - rawB; // Always positive (4% goes to treasury)
    return {
      playerAPayout: Number(rawA.toFixed(6)),
      playerBPayout: Number(rawB.toFixed(6)),
      treasuryDelta: Number((treasuryCut + surplus).toFixed(6)),
      outcome: 'CC',
      narrative: '双方都选择合作，信任获得额外回报。',
      pdPayoutSemantics,
    };
  }

  if (actionA === 'cooperate' && actionB === 'betray') {
    return {
      playerAPayout: Number((netBase * 0.2).toFixed(6)),
      playerBPayout: Number((netBase * 1.8).toFixed(6)),
      treasuryDelta: Number(treasuryCut.toFixed(6)),
      outcome: 'CD',
      narrative: 'A信任了对方，B选择背叛。',
      pdPayoutSemantics,
    };
  }

  if (actionA === 'betray' && actionB === 'cooperate') {
    return {
      playerAPayout: Number((netBase * 1.8).toFixed(6)),
      playerBPayout: Number((netBase * 0.2).toFixed(6)),
      treasuryDelta: Number(treasuryCut.toFixed(6)),
      outcome: 'DC',
      narrative: 'A利用了对方的信任。',
      pdPayoutSemantics,
    };
  }

  // DD: Each gets 0.6x of net base; surplus + treasuryCut → treasury
  const ddA = netBase * 0.6;
  const ddB = netBase * 0.6;
  const ddSurplus = netPool - ddA - ddB;
  return {
    playerAPayout: Number(ddA.toFixed(6)),
    playerBPayout: Number(ddB.toFixed(6)),
    treasuryDelta: Number((treasuryCut + ddSurplus).toFixed(6)),
    outcome: 'DD',
    narrative: '双方互不信任，谁也没有赢。',
    pdPayoutSemantics,
  };
}

// ── Resource Grab (资源争夺) ──
// Actions: claim_low (30%), claim_mid (50%), claim_high (70%)
// If combined ≤ 100%: each gets what they claimed, surplus → treasury
// If combined > 100% and ≤ 120%: mild conflict, each gets 20%
// If combined > 120%: severe conflict, each gets 15%

function calculateResourceGrab(
  actionA: string,
  actionB: string,
  prizePool: number,
): PayoffResult {
  const claimPct: Record<string, number> = {
    claim_low: 0.30,
    claim_mid: 0.50,
    claim_high: 0.70,
  };

  const pctA = claimPct[actionA] ?? 0.50;
  const pctB = claimPct[actionB] ?? 0.50;
  const totalClaim = pctA + pctB;

  // Outcome code: first letter of each claim level
  const codeA = actionA === 'claim_low' ? 'L' : actionA === 'claim_high' ? 'H' : 'M';
  const codeB = actionB === 'claim_low' ? 'L' : actionB === 'claim_high' ? 'H' : 'M';
  const outcome = `${codeA}${codeB}`;

  let payoutA: number;
  let payoutB: number;
  let treasuryDelta: number;
  let narrative: string;

  if (totalClaim <= 1.0) {
    payoutA = prizePool * pctA;
    payoutB = prizePool * pctB;
    treasuryDelta = prizePool * (1.0 - totalClaim);
    narrative = `双方索取总和${(totalClaim * 100).toFixed(0)}%，未超额，各得所愿。`;
  } else if (totalClaim <= 1.2) {
    payoutA = prizePool * 0.20;
    payoutB = prizePool * 0.20;
    treasuryDelta = prizePool * 0.60;
    narrative = `总索取${(totalClaim * 100).toFixed(0)}%超额！冲突导致双方仅获20%。`;
  } else {
    payoutA = prizePool * 0.15;
    payoutB = prizePool * 0.15;
    treasuryDelta = prizePool * 0.70;
    narrative = `贪婪的${(totalClaim * 100).toFixed(0)}%索取引发严重冲突，双方仅获15%。`;
  }

  return {
    playerAPayout: Number(payoutA.toFixed(6)),
    playerBPayout: Number(payoutB.toFixed(6)),
    treasuryDelta: Number(treasuryDelta.toFixed(6)),
    outcome,
    narrative,
  };
}

// ── Info Auction (信息拍卖) ──
// Actions: bid_low (0.2), bid_mid (0.5), bid_high (0.8)
// Tie: split evenly
// Winner (higher bidder): gets premium proportional to bid gap
// The real intel reward is handled in settlement.ts (winner gets opponent's strategy history)

function calculateInfoAuction(
  actionA: string,
  actionB: string,
  prizePool: number,
): PayoffResult {
  const bidValues: Record<string, number> = {
    bid_low: 0.2,
    bid_mid: 0.5,
    bid_high: 0.8,
  };

  const bidA = bidValues[actionA] ?? 0.5;
  const bidB = bidValues[actionB] ?? 0.5;

  const codeA = actionA === 'bid_low' ? 'L' : actionA === 'bid_high' ? 'H' : 'M';
  const codeB = actionB === 'bid_low' ? 'L' : actionB === 'bid_high' ? 'H' : 'M';
  const outcome = `${codeA}${codeB}`;

  let payoutA: number;
  let payoutB: number;
  let narrative: string;

  if (bidA === bidB) {
    payoutA = prizePool * 0.50;
    payoutB = prizePool * 0.50;
    narrative = `双方出价相同(${bidA} USDT)，平分奖池，各获基础情报。`;
  } else if (bidA > bidB) {
    const premium = 0.10 + (bidA - bidB) * 0.20;
    payoutA = prizePool * Math.min(0.65, 0.50 + premium);
    payoutB = prizePool * Math.max(0.35, 0.50 - premium);
    narrative = `A出价${bidA}胜出，获得情报优势。B出价${bidB}，失去竞标。`;
  } else {
    const premium = 0.10 + (bidB - bidA) * 0.20;
    payoutA = prizePool * Math.max(0.35, 0.50 - premium);
    payoutB = prizePool * Math.min(0.65, 0.50 + premium);
    narrative = `B出价${bidB}胜出，获得情报优势。A出价${bidA}，失去竞标。`;
  }

  return {
    playerAPayout: Number(payoutA.toFixed(6)),
    playerBPayout: Number(payoutB.toFixed(6)),
    treasuryDelta: 0,
    outcome,
    narrative,
  };
}

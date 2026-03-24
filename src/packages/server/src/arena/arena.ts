import { Router } from 'express';
import {
  asyncHandler,
  NotFoundError,
  ValidationError,
} from '../middleware/errorHandler.js';
import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { processX402Payment, processX402PaymentBatch } from '../x402/payment-processor.js';
import { X402_PRICES } from '../x402/pricing.js';
import { queueArenaOnchainSync } from './onchain-sync.js';
import { reconcileArenaMatchStates } from './reconciliation.js';
import { buildArenaObserverSummary } from './observer-summary.js';
import { settleMatch, resolveRound } from './settlement.js';
import { VALID_ACTIONS } from './payoff-matrix.js';
import { appendMainnetEpochCreatedAtFilter } from '../config/mainnet-epoch.js';

const router: Router = Router();

type ArenaAction = string;
type MatchResolutionRow = {
  status: string;
  settled_at: string | null;
  player_a_action: ArenaAction | null;
  player_b_action: ArenaAction | null;
};

router.post(
  '/create',
  asyncHandler(async (req, res) => {
    const playerAId = String(req.body.playerAId ?? '');
    const playerBId = String(req.body.playerBId ?? '');
    const matchType =
      (req.body.matchType as string | undefined) ?? 'prisoners_dilemma';
    const maxRounds = Math.max(2, Math.min(5, Number(req.body.maxRounds) || 5));
    const continueProbability = Math.max(0, Math.min(1, Number(req.body.continueProbability) || 0.70));

    if (!playerAId || !playerBId) {
      throw new ValidationError('playerAId and playerBId are required');
    }
    if (playerAId === playerBId) {
      throw new ValidationError('Arena requires two distinct agents');
    }

    const pool = getPool();
    const balanceCheck = await pool.query<{ agent_id: string; balance: string; is_alive: boolean }>(
      'SELECT agent_id, balance, is_alive FROM agents WHERE agent_id = ANY($1)',
      [[playerAId, playerBId]],
    );

    if (balanceCheck.rows.length !== 2) {
      throw new ValidationError('Both agents must exist');
    }

    for (const row of balanceCheck.rows) {
      if (!row.is_alive) {
        throw new ValidationError(`${row.agent_id} is dead and cannot enter arena`);
      }
      if (Number(row.balance) < X402_PRICES.arena_entry) {
        throw new ValidationError(`${row.agent_id} does not have enough balance`);
      }
    }

    const [entryA, entryB] = await processX402PaymentBatch([
      {
        txType: 'arena_entry',
        fromAgentId: playerAId,
        toAgentId: null,
        amount: X402_PRICES.arena_entry,
        metadata: { matchType, role: 'player_a' },
      },
      {
        txType: 'arena_entry',
        fromAgentId: playerBId,
        toAgentId: null,
        amount: X402_PRICES.arena_entry,
        metadata: { matchType, role: 'player_b' },
      },
    ]);

    const deadline = new Date(Date.now() + 30_000);
    const result = await pool.query(
      `INSERT INTO arena_matches
        (match_type, player_a_id, player_b_id, entry_fee, prize_pool, max_rounds, continue_probability, total_rounds, current_round, carry_pool, status, negotiation_deadline, x402_entry_a_hash, x402_entry_b_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0, 'negotiating', $9, $10, $11)
       RETURNING *`,
      [
        matchType,
        playerAId,
        playerBId,
        X402_PRICES.arena_entry.toFixed(6),
        (X402_PRICES.arena_entry * 2).toFixed(6),
        maxRounds,
        continueProbability.toFixed(2),
        maxRounds, // total_rounds = max_rounds initially, updated to actual on settlement
        deadline.toISOString(),
        entryA.txHash ?? null,
        entryB.txHash ?? null,
      ],
    );

    const match = result.rows[0];
    queueArenaOnchainSync(match.id);

    eventBus.emit('arena_created', {
      matchId: match.id,
      jobId: null,
      commerceJobId: null,
      acpJobId: null,
      commerceSyncStatus: match.commerce_sync_status ?? 'pending',
      acpSyncStatus: match.acp_sync_status ?? 'pending',
      playerAId,
      playerBId,
      matchType,
      maxRounds,
      continueProbability,
      negotiationDeadline: deadline.toISOString(),
    });

    res.status(201).json({
      ...match,
      jobId: null,
      commerceJobId: match.commerce_job_id ?? null,
      acpJobId: match.acp_job_local_id ?? null,
    });
  }),
);

router.post(
  '/:matchId/decide',
  asyncHandler(async (req, res) => {
    const matchId = Number(req.params.matchId);
    const agentId = String(req.body.agentId ?? '');
    const reason = typeof req.body.reason === 'string'
      ? req.body.reason.trim().slice(0, 160)
      : null;

    const pool = getPool();
    await reconcileArenaMatchStates();
    const match = await pool.query<{
      player_a_id: string;
      player_b_id: string;
      status: string;
      settled_at: string | null;
      match_type: string;
      player_a_action: ArenaAction | null;
      player_b_action: ArenaAction | null;
    }>('SELECT * FROM arena_matches WHERE id = $1', [matchId]);

    if (match.rows.length === 0) {
      throw new NotFoundError('Match not found');
    }

    const current = match.rows[0];
    const action = normalizeAction(req.body.action, current.match_type);

    if (!matchId || !agentId || !action) {
      const valid = VALID_ACTIONS[current.match_type] ?? VALID_ACTIONS.prisoners_dilemma;
      throw new ValidationError(`matchId, agentId and valid action required. Valid actions for ${current.match_type}: ${valid.join(', ')}`);
    }

    if (!['negotiating', 'deciding'].includes(current.status)) {
      throw new ValidationError('Match is not open for decisions');
    }
    if (![current.player_a_id, current.player_b_id].includes(agentId)) {
      throw new ValidationError('agentId is not a participant in this match');
    }

    await processX402Payment('arena_action', agentId, null, X402_PRICES.arena_action, {
      matchId,
      action,
      reason,
    });

    const column = current.player_a_id === agentId ? 'player_a_action' : 'player_b_action';
    const reasonColumn = current.player_a_id === agentId ? 'player_a_reason' : 'player_b_reason';
    const updated = await pool.query<MatchResolutionRow>(
      `UPDATE arena_matches
       SET status = 'deciding', ${column} = $1, ${reasonColumn} = $2
       WHERE id = $3
         AND settled_at IS NULL
         AND status IN ('negotiating', 'deciding')
       RETURNING status, settled_at, player_a_action, player_b_action`,
      [action, reason, matchId],
    );

    if (updated.rows.length === 0) {
      const latest = await pool.query<MatchResolutionRow>(
        `SELECT status, settled_at, player_a_action, player_b_action
         FROM arena_matches
         WHERE id = $1`,
        [matchId],
      );
      const latestMatch = latest.rows[0];
      if (latestMatch?.settled_at || latestMatch?.status === 'settled') {
        res.json({ success: true, settled: true, alreadyResolved: true });
        return;
      }
      throw new ValidationError('Match is no longer open for decisions');
    }

    eventBus.emit('arena_decision', {
      matchId,
      agentId,
      action,
      reason,
    });

    if (updated.rows[0]?.player_a_action && updated.rows[0]?.player_b_action) {
      try {
        const payoff = await resolveRound(matchId);
        res.json({ settled: payoff.isFinal, roundSettled: true, payoff });
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          /already settled|already being resolved/i.test(error.message)
        ) {
          res.json({ success: true, settled: true, alreadyResolved: true });
          return;
        }
        throw error;
      }
    }

    res.json({ success: true, settled: false });
  }),
);

router.post(
  '/:matchId/settle',
  asyncHandler(async (req, res) => {
    const payoff = await resolveRound(Number(req.params.matchId));
    res.json(payoff);
  }),
);

router.get(
  '/active',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    await reconcileArenaMatchStates();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 50, 100);
    const params: Array<string | number> = [];
    const where: string[] = [
      'settled_at IS NULL',
      "status <> 'settled'",
    ];
    appendMainnetEpochCreatedAtFilter(where, params, 'created_at');
    params.push(limit);
    const matches = await pool.query(
      `SELECT *
       FROM arena_matches
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    // Axelrod information hiding: agents must NOT know how many rounds exist.
    // If ?observer=true is passed (dashboard), return full data.
    // Otherwise strip max_rounds, total_rounds, continue_probability so agents
    // face genuine uncertainty about when the match ends.
    const isObserver = req.query.observer === 'true';
    if (isObserver) {
      res.json(matches.rows);
      return;
    }

    const filtered = matches.rows.map((m: Record<string, unknown>) => {
      const { max_rounds, total_rounds, continue_probability, ...safe } = m;
      return safe;
    });
    res.json(filtered);
  }),
);

router.get(
  '/history',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    await reconcileArenaMatchStates();
    const params: Array<string | number> = [];
    const where: string[] = ['(status = \'settled\' OR settled_at IS NOT NULL)'];
    appendMainnetEpochCreatedAtFilter(where, params, 'COALESCE(settled_at, created_at)');

    if (typeof req.query.agentId === 'string') {
      params.push(req.query.agentId);
      where.push(`(player_a_id = $${params.length} OR player_b_id = $${params.length})`);
    }

    params.push(Math.min(req.query.limit ? Number(req.query.limit) : 20, 100));
    params.push(Math.max(req.query.offset ? Number(req.query.offset) : 0, 0));

    const matches = await pool.query(
      `SELECT *
       FROM arena_matches
       WHERE ${where.join(' AND ')}
       ORDER BY settled_at DESC NULLS LAST, created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(matches.rows);
  }),
);

router.get(
  '/:matchId/rounds',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const matchId = Number(req.params.matchId);
    const rounds = await pool.query(
      `SELECT * FROM arena_rounds WHERE match_id = $1 ORDER BY round_number ASC`,
      [matchId],
    );
    res.json(rounds.rows);
  }),
);

router.get(
  '/:matchId',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const matchId = Number(req.params.matchId);
    const match = await pool.query('SELECT * FROM arena_matches WHERE id = $1', [matchId]);
    if (match.rows.length === 0) {
      throw new NotFoundError('Match not found');
    }

    const [messages, rounds, traces] = await Promise.all([
      pool.query(
        `SELECT *
         FROM negotiation_messages
         WHERE match_id = $1
         ORDER BY created_at ASC`,
        [matchId],
      ),
      pool.query(
        `SELECT *
         FROM arena_rounds
         WHERE match_id = $1
         ORDER BY round_number ASC`,
        [matchId],
      ),
      pool.query(
        `SELECT
           t.*,
           a.name AS agent_name,
           a.archetype AS agent_archetype
         FROM agent_decision_traces t
         LEFT JOIN agents a ON a.agent_id = t.agent_id
         WHERE t.scene = 'arena'
           AND (
             t.metadata ->> 'arenaMatchId' = $1
             OR t.target_ref = $2
           )
         ORDER BY t.created_at DESC
         LIMIT 40`,
        [String(matchId), `arena:${matchId}`],
      ),
    ]);

    const observerSummary = await buildArenaObserverSummary(
      match.rows[0],
      rounds.rows,
      messages.rows,
      traces.rows,
    );

    res.json({
      ...match.rows[0],
      negotiationMessages: messages.rows,
      rounds: rounds.rows,
      decisionTraces: traces.rows,
      observerSummary,
    });
  }),
);

/**
 * POST /:matchId/claim
 * Convenience endpoint for resource_grab — maps to /decide with claim action.
 * Body: { agentId: string, claim: 'low' | 'mid' | 'high' }
 */
router.post(
  '/:matchId/claim',
  asyncHandler(async (req, res) => {
    const matchId = Number(req.params.matchId);
    const agentId = String(req.body.agentId ?? '');
    const claim = String(req.body.claim ?? '');
    const reason = typeof req.body.reason === 'string'
      ? req.body.reason.trim().slice(0, 160)
      : null;

    const actionMap: Record<string, string> = { low: 'claim_low', mid: 'claim_mid', high: 'claim_high' };
    const action = actionMap[claim];
    if (!action) {
      throw new ValidationError(`Invalid claim level '${claim}'. Valid: low, mid, high`);
    }

    const pool = getPool();
    await reconcileArenaMatchStates();
    const match = await pool.query<{
      player_a_id: string;
      player_b_id: string;
      status: string;
      settled_at: string | null;
      match_type: string;
      player_a_action: ArenaAction | null;
      player_b_action: ArenaAction | null;
    }>('SELECT * FROM arena_matches WHERE id = $1', [matchId]);

    if (match.rows.length === 0) {
      throw new NotFoundError('Match not found');
    }

    const current = match.rows[0];
    if (current.match_type !== 'resource_grab') {
      throw new ValidationError('This endpoint is only for resource_grab matches');
    }

    if (!['negotiating', 'deciding'].includes(current.status)) {
      throw new ValidationError('Match is not open for decisions');
    }
    if (![current.player_a_id, current.player_b_id].includes(agentId)) {
      throw new ValidationError('agentId is not a participant in this match');
    }

    await processX402Payment('arena_action', agentId, null, X402_PRICES.arena_action, {
      matchId,
      action,
      reason,
    });

    const column = current.player_a_id === agentId ? 'player_a_action' : 'player_b_action';
    const reasonColumn = current.player_a_id === agentId ? 'player_a_reason' : 'player_b_reason';
    const updated = await pool.query<MatchResolutionRow>(
      `UPDATE arena_matches
       SET status = 'deciding', ${column} = $1, ${reasonColumn} = $2
       WHERE id = $3
         AND settled_at IS NULL
         AND status IN ('negotiating', 'deciding')
       RETURNING status, settled_at, player_a_action, player_b_action`,
      [action, reason, matchId],
    );

    if (updated.rows.length === 0) {
      const latest = await pool.query<MatchResolutionRow>(
        `SELECT status, settled_at, player_a_action, player_b_action
         FROM arena_matches
         WHERE id = $1`,
        [matchId],
      );
      const latestMatch = latest.rows[0];
      if (latestMatch?.settled_at || latestMatch?.status === 'settled') {
        res.json({ success: true, settled: true, alreadyResolved: true });
        return;
      }
      throw new ValidationError('Match is no longer open for decisions');
    }

    eventBus.emit('arena_decision', { matchId, agentId, action, reason });

    if (updated.rows[0]?.player_a_action && updated.rows[0]?.player_b_action) {
      try {
        const payoff = await resolveRound(matchId);
        res.json({ settled: payoff.isFinal, roundSettled: true, payoff });
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          /already settled|already being resolved/i.test(error.message)
        ) {
          res.json({ success: true, settled: true, alreadyResolved: true });
          return;
        }
        throw error;
      }
    }

    res.json({ success: true, settled: false });
  }),
);

/**
 * POST /:matchId/bid
 * Convenience endpoint for info_auction — maps to /decide with bid action.
 * Body: { agentId: string, bid: 'low' | 'mid' | 'high' }
 */
router.post(
  '/:matchId/bid',
  asyncHandler(async (req, res) => {
    const matchId = Number(req.params.matchId);
    const agentId = String(req.body.agentId ?? '');
    const bid = String(req.body.bid ?? '');
    const reason = typeof req.body.reason === 'string'
      ? req.body.reason.trim().slice(0, 160)
      : null;

    const actionMap: Record<string, string> = { low: 'bid_low', mid: 'bid_mid', high: 'bid_high' };
    const action = actionMap[bid];
    if (!action) {
      throw new ValidationError(`Invalid bid level '${bid}'. Valid: low, mid, high`);
    }

    const pool = getPool();
    await reconcileArenaMatchStates();
    const match = await pool.query<{
      player_a_id: string;
      player_b_id: string;
      status: string;
      settled_at: string | null;
      match_type: string;
      player_a_action: ArenaAction | null;
      player_b_action: ArenaAction | null;
    }>('SELECT * FROM arena_matches WHERE id = $1', [matchId]);

    if (match.rows.length === 0) {
      throw new NotFoundError('Match not found');
    }

    const current = match.rows[0];
    if (current.match_type !== 'info_auction') {
      throw new ValidationError('This endpoint is only for info_auction matches');
    }

    if (!['negotiating', 'deciding'].includes(current.status)) {
      throw new ValidationError('Match is not open for decisions');
    }
    if (![current.player_a_id, current.player_b_id].includes(agentId)) {
      throw new ValidationError('agentId is not a participant in this match');
    }

    await processX402Payment('arena_action', agentId, null, X402_PRICES.arena_action, {
      matchId,
      action,
      reason,
    });

    const column = current.player_a_id === agentId ? 'player_a_action' : 'player_b_action';
    const reasonColumn = current.player_a_id === agentId ? 'player_a_reason' : 'player_b_reason';
    const updated = await pool.query<MatchResolutionRow>(
      `UPDATE arena_matches
       SET status = 'deciding', ${column} = $1, ${reasonColumn} = $2
       WHERE id = $3
         AND settled_at IS NULL
         AND status IN ('negotiating', 'deciding')
       RETURNING status, settled_at, player_a_action, player_b_action`,
      [action, reason, matchId],
    );

    if (updated.rows.length === 0) {
      const latest = await pool.query<MatchResolutionRow>(
        `SELECT status, settled_at, player_a_action, player_b_action
         FROM arena_matches
         WHERE id = $1`,
        [matchId],
      );
      const latestMatch = latest.rows[0];
      if (latestMatch?.settled_at || latestMatch?.status === 'settled') {
        res.json({ success: true, settled: true, alreadyResolved: true });
        return;
      }
      throw new ValidationError('Match is no longer open for decisions');
    }

    eventBus.emit('arena_decision', { matchId, agentId, action, reason });

    if (updated.rows[0]?.player_a_action && updated.rows[0]?.player_b_action) {
      try {
        const payoff = await resolveRound(matchId);
        res.json({ settled: payoff.isFinal, roundSettled: true, payoff });
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          /already settled|already being resolved/i.test(error.message)
        ) {
          res.json({ success: true, settled: true, alreadyResolved: true });
          return;
        }
        throw error;
      }
    }

    res.json({ success: true, settled: false });
  }),
);

export default router;

function normalizeAction(action: unknown, matchType?: string): ArenaAction | null {
  if (typeof action !== 'string') return null;
  const validSet = VALID_ACTIONS[matchType ?? 'prisoners_dilemma'] ?? VALID_ACTIONS.prisoners_dilemma;
  return validSet.includes(action) ? action : null;
}

import { Router } from 'express';
import { getPool } from '../db/postgres.js';
import {
  asyncHandler,
  NotFoundError,
  ValidationError,
} from '../middleware/errorHandler.js';
import { eventBus } from '../realtime.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { X402_PRICES } from '../x402/pricing.js';
import { resolveRound } from './settlement.js';

const router: Router = Router();

router.post(
  '/:matchId/negotiate',
  asyncHandler(async (req, res) => {
    const matchId = Number(req.params.matchId);
    const senderAgentId = String(req.body.senderAgentId ?? '');
    const content = String(req.body.content ?? '').trim();
    const messageType =
      (req.body.messageType as string | undefined) ?? 'normal';

    if (!matchId || !senderAgentId || !content) {
      throw new ValidationError('matchId, senderAgentId and content are required');
    }
    if (content.length > 100) {
      throw new ValidationError('content must be at most 100 characters');
    }

    const pool = getPool();
    const match = await pool.query<{
      player_a_id: string;
      player_b_id: string;
      negotiation_deadline: string | null;
      status: string;
    }>('SELECT * FROM arena_matches WHERE id = $1', [matchId]);

    if (match.rows.length === 0) {
      throw new NotFoundError('Match not found');
    }

    const current = match.rows[0];
    if (current.status !== 'negotiating') {
      res.json({
        success: false,
        skipped: true,
        status: current.status,
        reason: 'negotiation_closed',
      });
      return;
    }

    const receiverAgentId =
      current.player_a_id === senderAgentId
        ? current.player_b_id
        : current.player_b_id === senderAgentId
          ? current.player_a_id
          : null;

    if (!receiverAgentId) {
      throw new ValidationError('senderAgentId is not part of this match');
    }

    if (
      current.negotiation_deadline &&
      new Date(current.negotiation_deadline).getTime() < Date.now()
    ) {
      await pool.query(
        `UPDATE arena_matches
         SET status = 'deciding'
         WHERE id = $1 AND status = 'negotiating'`,
        [matchId],
      );

      eventBus.emit('negotiation_ended', {
        matchId,
        playerAId: current.player_a_id,
        playerBId: current.player_b_id,
        reason: 'deadline',
      });

      res.json({
        success: false,
        expired: true,
        status: 'deciding',
        reason: 'deadline_passed',
      });
      return;
    }

    const sentCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)
       FROM negotiation_messages
       WHERE match_id = $1 AND sender_agent_id = $2`,
      [matchId, senderAgentId],
    );

    if (Number(sentCount.rows[0]?.count ?? 0) >= 3) {
      throw new ValidationError('Each player can only send 3 negotiation messages');
    }

    const payment = await processX402Payment(
      'negotiation',
      senderAgentId,
      receiverAgentId,
      X402_PRICES.negotiation,
      {
        matchId,
        messageType,
      },
    );

    const result = await pool.query(
      `INSERT INTO negotiation_messages
        (match_id, sender_agent_id, receiver_agent_id, content, message_type, x402_tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        matchId,
        senderAgentId,
        receiverAgentId,
        content,
        messageType,
        payment.txHash ?? null,
      ],
    );

    eventBus.emit('negotiation_msg', {
      matchId,
      senderAgentId,
      receiverAgentId,
      messageType,
    });

    res.status(201).json(result.rows[0]);
  }),
);

router.get(
  '/:matchId/messages',
  asyncHandler(async (req, res) => {
    const matchId = Number(req.params.matchId);
    const requesterAgentId =
      typeof req.query.agentId === 'string' ? req.query.agentId : undefined;

    const pool = getPool();
    const match = await pool.query<{
      player_a_id: string;
      player_b_id: string;
      status: string;
    }>('SELECT player_a_id, player_b_id, status FROM arena_matches WHERE id = $1', [
      matchId,
    ]);

    if (match.rows.length === 0) {
      throw new NotFoundError('Match not found');
    }

    const row = match.rows[0];
    const requesterAllowed =
      row.status === 'settled' ||
      requesterAgentId === row.player_a_id ||
      requesterAgentId === row.player_b_id;

    if (!requesterAllowed) {
      throw new ValidationError('Negotiation messages are private until settlement');
    }

    const messages = await pool.query(
      `SELECT *
       FROM negotiation_messages
       WHERE match_id = $1
       ORDER BY created_at ASC`,
      [matchId],
    );
    res.json(messages.rows);
  }),
);

export async function checkNegotiationTimeout(): Promise<void> {
  const pool = getPool();
  const expired = await pool.query<{
    id: number;
    player_a_id: string;
    player_b_id: string;
  }>(
    `UPDATE arena_matches
     SET status = 'deciding'
     WHERE status = 'negotiating'
       AND negotiation_deadline < NOW()
     RETURNING id, player_a_id, player_b_id`,
  );

  for (const match of expired.rows) {
    eventBus.emit('negotiation_ended', {
      matchId: match.id,
      playerAId: match.player_a_id,
      playerBId: match.player_b_id,
    });
  }
}

export async function checkDecisionTimeout(): Promise<void> {
  const pool = getPool();
  const expired = await pool.query<{
    id: number;
    match_type: string;
    player_a_action: string | null;
    player_b_action: string | null;
  }>(
    `SELECT id, match_type, player_a_action, player_b_action
     FROM arena_matches
     WHERE status = 'deciding'
       AND negotiation_deadline + INTERVAL '30 seconds' < NOW()`,
  );

  for (const match of expired.rows) {
    const defaultAction = getDefaultAction(match.match_type);
    const playerAAction = match.player_a_action ?? defaultAction;
    const playerBAction = match.player_b_action ?? defaultAction;

    if (!match.player_a_action || !match.player_b_action) {
      await pool.query(
        `UPDATE arena_matches
         SET player_a_action = COALESCE(player_a_action, $1),
             player_b_action = COALESCE(player_b_action, $2)
         WHERE id = $3`,
        [playerAAction, playerBAction, match.id],
      );
    }

    try {
      await resolveRound(match.id);
    } catch (error) {
      console.warn(`[Arena] timed-out match #${match.id} failed to resolve:`, error);
    }
  }
}

/** Return a safe default action for each match type when an agent times out. */
function getDefaultAction(matchType: string): string {
  switch (matchType) {
    case 'resource_grab':
      return 'claim_mid';
    case 'info_auction':
      return 'bid_mid';
    case 'prisoners_dilemma':
    default:
      return 'cooperate';
  }
}

export default router;

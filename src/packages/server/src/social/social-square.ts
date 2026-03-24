import { Router } from 'express';
import { asyncHandler, NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { getPool, withTransaction } from '../db/postgres.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { X402_PRICES } from '../x402/pricing.js';
import { eventBus } from '../realtime.js';
import { getFeed, getPostDetail } from './feed.js';
import { getCurrentTick } from '../world/tick-engine.js';
import { getWorldModifierMultiplier } from '../world/modifiers.js';
import { applyPostEffects, applyTipEffects } from './social-effects.js';

const router: Router = Router();

router.post(
  '/post',
  asyncHandler(async (req, res) => {
    const agentId = String(req.body.agentId ?? '');
    const content = String(req.body.content ?? '').trim();
    const postType = (req.body.postType ?? 'normal') as 'normal' | 'paywall';
    const paywallPrice =
      typeof req.body.paywallPrice === 'number' ? req.body.paywallPrice : undefined;
    const intelType = typeof req.body.intelType === 'string'
      ? req.body.intelType as 'arena_analysis' | 'trust_map' | 'behavior_prediction' | 'market_signal'
      : undefined;

    if (!agentId || !content) {
      throw new ValidationError('agentId and content are required');
    }
    if (content.length > 280) {
      throw new ValidationError('content must be at most 280 characters');
    }
    if (postType === 'paywall' && (!paywallPrice || paywallPrice <= 0)) {
      throw new ValidationError('paywall posts require a positive paywallPrice');
    }

    const postCostMultiplier = await getPostCostMultiplier(agentId);
    const actualPostCost = X402_PRICES.post * postCostMultiplier;
    let payment: { txHash?: string | null } = { txHash: null };
    if (actualPostCost > 0) {
      payment = await processX402Payment('post', agentId, null, actualPostCost, {
        action: 'create_post',
        postType,
        costMultiplier: postCostMultiplier,
      });
    }

    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO posts (author_agent_id, content, post_type, paywall_price, x402_tx_hash, intel_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [agentId, content, postType, paywallPrice ?? null, payment.txHash ?? null, intelType ?? null],
    );

    const post = result.rows[0];

    // Apply archetype-specific post effects (Hawk fear mongering, Sage cognition boost, etc.)
    const agentRow = await pool.query<{ archetype: string }>(
      'SELECT archetype FROM agents WHERE agent_id = $1',
      [agentId],
    );
    if (agentRow.rows[0]) {
      const tick = getCurrentTick();
      await applyPostEffects(agentId, agentRow.rows[0].archetype, post.id, tick);
    }

    eventBus.emit('new_post', {
      postId: post.id,
      agentId,
      postType,
      tipTotal: 0,
    });

    // Emit intel_posted event for intel posts
    if (intelType) {
      eventBus.emit('intel_posted', {
        postId: post.id,
        authorId: agentId,
        intelType,
        paywallPrice: paywallPrice ?? 0.02,
        preview: content.slice(0, 60),
      });
    }

    res.status(201).json(post);
  }),
);

router.post(
  '/reply',
  asyncHandler(async (req, res) => {
    const agentId = String(req.body.agentId ?? '');
    const postId = Number(req.body.postId);
    const content = String(req.body.content ?? '').trim();

    if (!agentId || !postId || !content) {
      throw new ValidationError('agentId, postId and content are required');
    }
    if (content.length > 140) {
      throw new ValidationError('content must be at most 140 characters');
    }

    const payment = await processX402Payment('reply', agentId, null, X402_PRICES.reply, {
      action: 'reply',
      postId,
    });

    const pool = getPool();
    const postResult = await pool.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (postResult.rows.length === 0) {
      throw new NotFoundError('Post not found');
    }

    const result = await withTransaction(async (client) => {
      const reply = await client.query(
        `INSERT INTO replies (post_id, author_agent_id, content, x402_tx_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [postId, agentId, content, payment.txHash ?? null],
      );
      await client.query(
        'UPDATE posts SET reply_count = reply_count + 1 WHERE id = $1',
        [postId],
      );
      return reply.rows[0];
    });

    eventBus.emit('new_reply', {
      replyId: result.id,
      postId,
      agentId,
    });

    res.status(201).json(result);
  }),
);

router.post(
  '/tip',
  asyncHandler(async (req, res) => {
    const fromAgentId = String(req.body.fromAgentId ?? '');
    const postId = Number(req.body.postId);
    const amount =
      typeof req.body.amount === 'number'
        ? req.body.amount
        : X402_PRICES.tip;

    if (!fromAgentId || !postId) {
      throw new ValidationError('fromAgentId and postId are required');
    }
    if (amount < X402_PRICES.tip) {
      throw new ValidationError('tip amount must be at least 0.01');
    }

    const pool = getPool();
    const post = await pool.query<{
      author_agent_id: string;
    }>('SELECT author_agent_id FROM posts WHERE id = $1', [postId]);

    if (post.rows.length === 0) {
      throw new NotFoundError('Post not found');
    }

    const toAgentId = post.rows[0].author_agent_id;
    const payment = await processX402Payment('tip', fromAgentId, toAgentId, amount, {
      postId,
    });

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO tips (from_agent_id, to_agent_id, post_id, amount, x402_tx_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [fromAgentId, toAgentId, postId, amount.toFixed(6), payment.txHash ?? null],
      );
      await client.query(
        'UPDATE posts SET tip_total = tip_total + $1 WHERE id = $2',
        [amount.toFixed(6), postId],
      );
      await upsertTrust(client, fromAgentId, toAgentId, 2);
    });

    // Apply archetype-specific tip effects (Fox relationship investment, etc.)
    const tipperRow = await pool.query<{ archetype: string }>(
      'SELECT archetype FROM agents WHERE agent_id = $1',
      [fromAgentId],
    );
    if (tipperRow.rows[0]) {
      await applyTipEffects(fromAgentId, tipperRow.rows[0].archetype, toAgentId, amount);
    }

    eventBus.emit('tip', {
      fromAgentId,
      toAgentId,
      postId,
      amount,
    });

    res.json({
      success: true,
      payment,
    });
  }),
);

router.post(
  '/unlock',
  asyncHandler(async (req, res) => {
    const agentId = String(req.body.agentId ?? '');
    const postId = Number(req.body.postId);

    if (!agentId || !postId) {
      throw new ValidationError('agentId and postId are required');
    }

    const pool = getPool();
    const post = await pool.query<{
      author_agent_id: string;
      content: string;
      post_type: string;
      paywall_price: string | null;
      intel_type: string | null;
    }>('SELECT * FROM posts WHERE id = $1', [postId]);

    if (post.rows.length === 0) {
      throw new NotFoundError('Post not found');
    }

    const row = post.rows[0];
    if (row.post_type !== 'paywall' || !row.paywall_price) {
      throw new ValidationError('Post is not paywalled');
    }

    const existingUnlock = await pool.query(
      'SELECT id FROM paywall_unlocks WHERE post_id = $1 AND buyer_agent_id = $2',
      [postId, agentId],
    );
    if (existingUnlock.rows.length > 0) {
      res.json({ alreadyUnlocked: true, content: row.content });
      return;
    }

    const price = Number(row.paywall_price);
    const authorAmount = Number((price * X402_PRICES.paywall_author).toFixed(6));
    const treasuryAmount = Number((price - authorAmount).toFixed(6));

    await processX402Payment('paywall', agentId, row.author_agent_id, authorAmount, {
      postId,
      split: 'author',
    });
    const treasuryPayment = await processX402Payment(
      'paywall',
      agentId,
      null,
      treasuryAmount,
      {
        postId,
        split: 'treasury',
      },
    );

    await pool.query(
      `INSERT INTO paywall_unlocks (post_id, buyer_agent_id, price, x402_tx_hash)
       VALUES ($1, $2, $3, $4)`,
      [postId, agentId, price.toFixed(6), treasuryPayment.txHash ?? null],
    );

    eventBus.emit('paywall_unlock', {
      buyerAgentId: agentId,
      postId,
      price,
    });

    // Emit intel_unlocked for intel posts
    if (row.intel_type) {
      eventBus.emit('intel_unlocked', {
        postId,
        buyerId: agentId,
        authorId: row.author_agent_id,
        price,
        intelType: row.intel_type,
      });
    }

    res.json({ content: row.content, price });
  }),
);

router.get(
  '/feed',
  asyncHandler(async (req, res) => {
    const feed = await getFeed({
      sort: req.query.sort === 'time' ? 'time' : 'tips',
      limit: Math.min(req.query.limit ? Number(req.query.limit) : 20, 100),
      offset: Math.max(req.query.offset ? Number(req.query.offset) : 0, 0),
      agentId:
        typeof req.query.agentId === 'string' ? req.query.agentId : undefined,
      viewerAgentId:
        typeof req.query.viewerAgentId === 'string'
          ? req.query.viewerAgentId
          : undefined,
    });

    res.json(feed);
  }),
);

router.get(
  '/post/:id',
  asyncHandler(async (req, res) => {
    const post = await getPostDetail(
      Number(req.params.id),
      typeof req.query.viewerAgentId === 'string'
        ? req.query.viewerAgentId
        : undefined,
    );
    if (!post) {
      throw new NotFoundError('Post not found');
    }
    res.json(post);
  }),
);

router.get(
  '/agent/:id/posts',
  asyncHandler(async (req, res) => {
    const feed = await getFeed({
      sort: req.query.sort === 'time' ? 'time' : 'tips',
      limit: Math.min(req.query.limit ? Number(req.query.limit) : 20, 100),
      offset: Math.max(req.query.offset ? Number(req.query.offset) : 0, 0),
      agentId: req.params.id,
      viewerAgentId:
        typeof req.query.viewerAgentId === 'string'
          ? req.query.viewerAgentId
          : undefined,
    });
    res.json(feed);
  }),
);

/**
 * GET /api/social/intel
 * Get intel posts (paywall posts with intel_type != null)
 * Query: { intelType?, limit?, offset? }
 */
router.get(
  '/intel',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const intelType = req.query.intelType as string | undefined;
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const offset = Number(req.query.offset) || 0;

    let where = "WHERE p.post_type = 'paywall' AND p.intel_type IS NOT NULL";
    const params: (string | number)[] = [];
    let idx = 1;

    if (intelType) {
      where += ` AND p.intel_type = $${idx++}`;
      params.push(intelType);
    }

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT p.*, a.name as author_name, a.archetype as author_archetype,
              (SELECT COUNT(*) FROM paywall_unlocks pu WHERE pu.post_id = p.id) as unlock_count
       FROM posts p
       JOIN agents a ON p.author_agent_id = a.agent_id
       ${where}
       ORDER BY p.tip_total DESC, p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params,
    );

    res.json(result.rows);
  }),
);

export default router;

async function getPostCostMultiplier(agentId: string): Promise<number> {
  return getWorldModifierMultiplier({
    domain: 'social',
    modifierType: 'social_post_cost_multiplier',
    scopeRefs: [agentId],
  });
}

async function upsertTrust(
  client: {
    query: (
      sql: string,
      values?: Array<string | number | null>,
    ) => Promise<unknown>;
  },
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

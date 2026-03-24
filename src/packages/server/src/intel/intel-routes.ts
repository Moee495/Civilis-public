/**
 * Intel Market V2 — API Routes
 */

import { Router, type Router as RouterType } from 'express';
import { ethers } from 'ethers';
import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { getCreditTier, INTEL_PUBLIC_BUYER_THRESHOLD, INTEL_PUBLIC_REVEAL_DELAY_TICKS } from './intel-types.js';
import { createIntelPurchaseJob, completeIntelPurchase } from '../erc8183/hooks/intel-hook.js';
import { getACPClient } from '../erc8183/acp-client.js';
import { describeIntelMarketSignal, loadIntelMarketSignals } from './intel-market-scoring.js';
import { canBuyIntel, canTradeIntel, getIntelCapabilitySnapshot } from './intel-phase-gate.js';
import { pushMainnetEpochStartTickParam } from '../config/mainnet-epoch.js';
import { getAgentWalletExecutionContext } from '../agents/wallet-sync.js';
import { getSharedProvider } from '../onchainos/shared-signers.js';

const router: RouterType = Router();
const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'] as const;

function appendTickConstraint(where: string, columnRef: string, tickPlaceholder: string | null): string {
  if (!tickPlaceholder) {
    return where;
  }
  return `${where} AND ${columnRef} >= ${tickPlaceholder}`;
}

async function getCurrentTick(): Promise<number> {
  const pool = getPool();
  const tickResult = await pool.query<{ tick: string }>(
    'SELECT COALESCE(MAX(tick_number), 0) as tick FROM economy_state',
  );
  return parseInt(tickResult.rows[0]?.tick ?? '0', 10) || 0;
}

async function getAgentWalletFundingReadiness(agentId: string, amount: number): Promise<{
  walletAddress: string;
  usdtBalance: number;
  nativeBalance: string;
}> {
  const context = await getAgentWalletExecutionContext(agentId);
  const provider = getSharedProvider();
  const protocol = await getACPClient().getProtocolDescriptor();
  const paymentToken = protocol.paymentToken;
  if (!paymentToken) {
    throw new Error('[Intel] ACP payment token is not configured');
  }

  const token = new ethers.Contract(paymentToken, ERC20_BALANCE_ABI, provider);
  const [usdtBalanceRaw, nativeBalanceRaw] = await Promise.all([
    token.balanceOf(context.walletAddress),
    provider.getBalance(context.walletAddress),
  ]);
  const usdtBalance = Number(ethers.formatUnits(usdtBalanceRaw, 6));
  const nativeBalance = ethers.formatEther(nativeBalanceRaw);

  if (usdtBalance < amount) {
    throw new Error(`Buyer wallet USDT ${usdtBalance.toFixed(6)} is below required funded budget ${amount.toFixed(6)}`);
  }
  if (nativeBalanceRaw <= 0n) {
    throw new Error('Buyer wallet has no native gas balance for funded ACP flow');
  }

  return {
    walletAddress: context.walletAddress,
    usdtBalance,
    nativeBalance,
  };
}

function presentIntelRow<T extends Record<string, any>>(row: T, currentTick: number, marketSignal?: ReturnType<typeof describeIntelMarketSignal>) {
  const buyerCount = Number(row.buyer_count ?? 0);
  const publicAfterTick = row.public_after_tick == null ? null : Number(row.public_after_tick);
  const consensusReachedAtTick = row.consensus_reached_at_tick == null ? null : Number(row.consensus_reached_at_tick);
  const ticksUntilPublic =
    row.is_public || publicAfterTick == null ? 0 : Math.max(0, publicAfterTick - currentTick);
  const marketState =
    row.is_public
      ? 'public'
      : buyerCount >= INTEL_PUBLIC_BUYER_THRESHOLD
        ? 'sealed'
        : 'listed';

  return {
    ...row,
    consensus_reached_at_tick: consensusReachedAtTick,
    public_after_tick: publicAfterTick,
    public_revealed_at_tick: row.public_revealed_at_tick == null ? null : Number(row.public_revealed_at_tick),
    ticks_until_public: ticksUntilPublic,
    market_state: marketState,
    public_delay_ticks: INTEL_PUBLIC_REVEAL_DELAY_TICKS,
    market_signal: marketSignal,
  };
}

/**
 * GET /api/intel/items
 * Browse active intel items with filters
 */
router.get('/items', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(String(req.query.limit)) || 30, 100);
    const offset = parseInt(String(req.query.offset)) || 0;
    const category = req.query.category as string | undefined;
    const producerId = req.query.producer as string | undefined;
    const subjectId = req.query.subject as string | undefined;

    const params: (string | number)[] = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    let where = appendTickConstraint(
      `WHERE i.status = 'active' AND i.is_public = false AND i.buyer_count < ${INTEL_PUBLIC_BUYER_THRESHOLD}`,
      'i.created_at_tick',
      tickPlaceholder,
    );
    let paramIdx = params.length + 1;

    if (category) {
      where += ` AND i.category = $${paramIdx++}`;
      params.push(category);
    }
    if (producerId) {
      where += ` AND i.producer_agent_id = $${paramIdx++}`;
      params.push(producerId);
    }
    if (subjectId) {
      where += ` AND i.subject_agent_id = $${paramIdx++}`;
      params.push(subjectId);
    }

    params.push(limit, offset);

    const [result, signals, currentTick] = await Promise.all([
      pool.query(
      `SELECT i.*,
              pa.name as producer_name, pa.archetype as producer_archetype,
              sa.name as subject_name, sa.archetype as subject_archetype
       FROM intel_items i
       JOIN agents pa ON i.producer_agent_id = pa.agent_id
       LEFT JOIN agents sa ON i.subject_agent_id = sa.agent_id
       ${where}
       ORDER BY i.freshness DESC, i.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
      ),
      loadIntelMarketSignals(),
      getCurrentTick(),
    ]);

    // Count total
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM intel_items i ${where}`,
      params.slice(0, -2)
    );

    res.json({
      items: result.rows.map((row) => ({
        ...presentIntelRow(row, currentTick, describeIntelMarketSignal(row, signals)),
      })),
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (err) {
    console.error('[IntelAPI] /items error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/items/:id
 * Single intel item detail
 */
router.get('/items/:id', async (req, res) => {
  try {
    const pool = getPool();
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    params.push(req.params.id);
    const [result, signals, currentTick] = await Promise.all([
      pool.query(
      `SELECT i.*,
              pa.name as producer_name, pa.archetype as producer_archetype,
              sa.name as subject_name, sa.archetype as subject_archetype
       FROM intel_items i
       JOIN agents pa ON i.producer_agent_id = pa.agent_id
       LEFT JOIN agents sa ON i.subject_agent_id = sa.agent_id
       WHERE i.id = $${params.length}
         ${tickPlaceholder ? `AND i.created_at_tick >= ${tickPlaceholder}` : ''}`,
      params
      ),
      loadIntelMarketSignals(),
      getCurrentTick(),
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Intel item not found' });
    }

    // Get buyers
    const buyers = await pool.query(
      `SELECT ip.*, a.name, a.archetype
       FROM intel_purchases ip
       JOIN agents a ON ip.buyer_agent_id = a.agent_id
       WHERE ip.intel_item_id = $1
       ORDER BY ip.created_at DESC`,
      [req.params.id]
    );

    res.json({
      item: presentIntelRow(result.rows[0], currentTick, describeIntelMarketSignal(result.rows[0], signals)),
      buyers: buyers.rows,
    });
  } catch (err) {
    console.error('[IntelAPI] /items/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/intel/items/:id/buy
 * Purchase an intel item
 */
router.post('/items/:id/buy', async (req, res) => {
  try {
    const pool = getPool();
    const { buyerAgentId, settlementMode } = req.body as {
      buyerAgentId?: string;
      settlementMode?: 'record_only' | 'acp_funded';
    };
    const itemId = parseInt(req.params.id);
    const useFundedEscrow = settlementMode === 'acp_funded';

    if (!buyerAgentId) {
      return res.status(400).json({ error: 'buyerAgentId required' });
    }

    const canBuy = await canBuyIntel(buyerAgentId);
    if (!canBuy) {
      return res.status(400).json({
        error: 'Buying strategic intel unlocks after the awakening phase. Agents must first accumulate enough arena experience, survival, wealth, or reputation growth.',
      });
    }

    // Get item
    const itemResult = await pool.query(
      `SELECT * FROM intel_items
       WHERE id = $1
         AND status = 'active'
         AND is_public = false
         AND buyer_count < $2`,
      [itemId, INTEL_PUBLIC_BUYER_THRESHOLD]
    );
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found, expired, already public, or already consensus-sealed' });
    }
    const item = itemResult.rows[0];
    const contentHash = ethers.id(JSON.stringify(item.content ?? {}));

    // Can't buy own intel
    if (item.producer_agent_id === buyerAgentId) {
      return res.status(400).json({ error: 'Cannot buy your own intel' });
    }

    // Check duplicate purchase
    const dupCheck = await pool.query(
      `SELECT id FROM intel_purchases WHERE intel_item_id = $1 AND buyer_agent_id = $2`,
      [itemId, buyerAgentId]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Already purchased' });
    }

    const price = parseFloat(item.price);
    if (useFundedEscrow) {
      await getAgentWalletFundingReadiness(buyerAgentId, price);
    } else {
      // Check buyer's internal spendable balance for the x402 path.
      const buyerResult = await pool.query(
        'SELECT balance FROM agents WHERE agent_id = $1',
        [buyerAgentId]
      );
      if (buyerResult.rows.length === 0) {
        return res.status(404).json({ error: 'Buyer not found' });
      }
      const buyerBalance = parseFloat(buyerResult.rows[0].balance);
      if (buyerBalance < price) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
    }

    const { acpJobId, onChainJobId, txHash } = await createIntelPurchaseJob({
      buyerAgentId,
      sellerAgentId: item.producer_agent_id,
      itemId,
      category: item.category,
      price,
      isResale: false,
      settlementMode: useFundedEscrow ? 'acp_funded' : 'record_only',
    });

    if (!useFundedEscrow) {
      await processX402Payment(
        'intel_v2_purchase' as any,
        buyerAgentId,
        item.producer_agent_id,
        price,
        { itemId, category: item.category, acpJobId }
      );
    }

    const { currentTick, newBuyerCount, isConsensusSealed, publicAfterTick } = await withTransaction(async (client) => {
      const tickResult = await client.query<{ tick: string }>(
        'SELECT COALESCE(MAX(tick_number), 0) as tick FROM economy_state',
      );
      const currentTick = parseInt(tickResult.rows[0]?.tick ?? '0', 10) || 0;

      const lockedItem = await client.query<{
        buyer_count: number;
        is_public: boolean;
        public_after_tick: number | null;
        consensus_reached_at_tick: number | null;
      }>(
        `SELECT buyer_count, is_public, public_after_tick, consensus_reached_at_tick
         FROM intel_items
         WHERE id = $1
         FOR UPDATE`,
        [itemId],
      );

      if (lockedItem.rows.length === 0) {
        throw new Error('Item disappeared during purchase');
      }

      const locked = lockedItem.rows[0];
      const currentBuyerCount = Number(locked.buyer_count ?? 0);
      if (locked.is_public || currentBuyerCount >= INTEL_PUBLIC_BUYER_THRESHOLD) {
        throw new Error('Item is already consensus-sealed');
      }

      await client.query(
        `INSERT INTO intel_purchases (intel_item_id, buyer_agent_id, price_paid, purchased_at_tick)
         VALUES ($1, $2, $3, $4)`,
        [itemId, buyerAgentId, price, currentTick],
      );

      const newBuyerCount = currentBuyerCount + 1;
      const isConsensusSealed = newBuyerCount >= INTEL_PUBLIC_BUYER_THRESHOLD;
      const revealTick = isConsensusSealed
        ? (locked.public_after_tick ?? currentTick + INTEL_PUBLIC_REVEAL_DELAY_TICKS)
        : locked.public_after_tick;

      await client.query(
        `UPDATE intel_items
         SET buyer_count = $1,
             consensus_reached_at_tick = CASE
               WHEN $2 THEN COALESCE(consensus_reached_at_tick, $3)
               ELSE consensus_reached_at_tick
             END,
             public_after_tick = CASE
               WHEN $2 THEN COALESCE(public_after_tick, $4)
               ELSE public_after_tick
             END,
             last_buyer_agent_id = $5
         WHERE id = $6`,
        [newBuyerCount, isConsensusSealed, currentTick, revealTick, buyerAgentId, itemId],
      );

      return {
        currentTick,
        newBuyerCount,
        isConsensusSealed,
        publicAfterTick: revealTick,
      };
    });

    await completeIntelPurchase({
      acpJobId,
      itemId,
      producerAgentId: item.producer_agent_id,
      category: item.category,
      contentHash,
    });

    eventBus.emit('intel_v2_purchased', {
      itemId,
      buyerAgentId,
      producerAgentId: item.producer_agent_id,
      category: item.category,
      price,
      acpJobId,
      onChainJobId,
      settlementMode: useFundedEscrow ? 'acp_funded' : 'record_only',
      buyerCount: newBuyerCount,
      isNowPublic: false,
      isConsensusSealed,
      publicAfterTick,
    });

    res.json({
      success: true,
      settlementMode: useFundedEscrow ? 'acp_funded' : 'record_only',
      acpJobId,
      onChainJobId,
      onChainTxHash: txHash,
      content: item.content,
      isPublic: false,
      isConsensusSealed,
      publicAfterTick,
      exclusiveWindowTicks: isConsensusSealed && publicAfterTick != null ? Math.max(0, publicAfterTick - currentTick) : 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('consensus-sealed')) {
      return res.status(409).json({ error: 'Consensus already sealed. This intel is now in its final private window.' });
    }
    console.error('[IntelAPI] /items/:id/buy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/intel/items/:id/resell
 * List a purchased intel item for resale at a markup.
 * Body: { sellerAgentId: string, resalePrice: number }
 */
router.post('/items/:id/resell', async (req, res) => {
  try {
    const pool = getPool();
    const itemId = parseInt(req.params.id);
    const { sellerAgentId, resalePrice } = req.body;

    if (!sellerAgentId || !resalePrice || resalePrice <= 0) {
      return res.status(400).json({ error: 'sellerAgentId and resalePrice > 0 required' });
    }

    const canTrade = await canTradeIntel(sellerAgentId);
    if (!canTrade) {
      return res.status(400).json({
        error: 'Reselling intel unlocks only after the insight phase, when the agent has already acquired enough second-hand knowledge.',
      });
    }

    // Verify seller actually purchased this item
    const purchaseCheck = await pool.query(
      'SELECT id FROM intel_purchases WHERE intel_item_id = $1 AND buyer_agent_id = $2',
      [itemId, sellerAgentId],
    );
    if (purchaseCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You must own this intel to resell it' });
    }

    // Get original item info
    const item = await pool.query(
      'SELECT * FROM intel_items WHERE id = $1',
      [itemId],
    );
    if (item.rows.length === 0) {
      return res.status(404).json({ error: 'Intel item not found' });
    }

    // Check not already public (no point reselling public intel)
    if (item.rows[0].is_public) {
      return res.status(400).json({ error: 'Item is already public — no resale value' });
    }

    // Check not already listed by this seller
    const existingListing = await pool.query(
      `SELECT id FROM intel_items
       WHERE category = $1 AND subject_agent_id = $2
         AND producer_agent_id = $3 AND status = 'active'
         AND content::text = $4`,
      [item.rows[0].category, item.rows[0].subject_agent_id, sellerAgentId, JSON.stringify(item.rows[0].content)],
    );
    if (existingListing.rows.length > 0) {
      return res.status(409).json({ error: 'You already have an active listing for this intel' });
    }

    // Create resale listing as a new intel_item with the reseller as producer
    const currentTick = (await pool.query('SELECT COALESCE(MAX(tick_number), 0) as t FROM tick_snapshots')).rows[0]?.t ?? 0;

    await pool.query(
      `INSERT INTO intel_items
       (category, producer_agent_id, subject_agent_id, content, accuracy, declared_accuracy,
        is_fake, freshness, price, buyer_count, is_public, status, expires_at_tick, created_at_tick)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, false, 'active', $10, $11)`,
      [
        item.rows[0].category,
        sellerAgentId,                     // reseller becomes the new "producer"
        item.rows[0].subject_agent_id,
        item.rows[0].content,
        item.rows[0].accuracy,
        item.rows[0].declared_accuracy,
        item.rows[0].is_fake,
        Math.max(0.3, Number(item.rows[0].freshness) * 0.8), // freshness decays 20% on resale
        Number(resalePrice).toFixed(4),
        currentTick + 30,                  // shorter expiry for resale
        currentTick,
      ],
    );

    eventBus.emit('intel_v2_resale', {
      originalItemId: itemId,
      sellerAgentId,
      category: item.rows[0].category,
      resalePrice,
      subjectAgentId: item.rows[0].subject_agent_id,
    });

    res.json({ success: true, message: 'Intel listed for resale' });
  } catch (err) {
    console.error('[IntelAPI] /items/:id/resell error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/purchases/:agentId
 * Intel purchased by an agent
 */
router.get('/purchases/:agentId', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(String(req.query.limit)) || 20, 100);
    const params: Array<string | number> = [req.params.agentId];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    params.push(limit);

    const result = await pool.query(
      `SELECT ip.*, i.category, i.content, i.accuracy, i.declared_accuracy,
              i.freshness, i.is_fake, i.is_public,
              pa.name as producer_name, pa.archetype as producer_archetype,
              sa.name as subject_name, sa.archetype as subject_archetype
       FROM intel_purchases ip
       JOIN intel_items i ON ip.intel_item_id = i.id
       JOIN agents pa ON i.producer_agent_id = pa.agent_id
       LEFT JOIN agents sa ON i.subject_agent_id = sa.agent_id
       WHERE ip.buyer_agent_id = $1
         ${tickPlaceholder ? `AND ip.purchased_at_tick >= ${tickPlaceholder}` : ''}
       ORDER BY ip.created_at DESC LIMIT $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[IntelAPI] /purchases/:agentId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/produced/:agentId
 * Intel produced by an agent
 */
router.get('/produced/:agentId', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(String(req.query.limit)) || 20, 100);
    const params: Array<string | number> = [req.params.agentId];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    params.push(limit);

    const result = await pool.query(
      `SELECT i.*,
              sa.name as subject_name, sa.archetype as subject_archetype
       FROM intel_items i
       LEFT JOIN agents sa ON i.subject_agent_id = sa.agent_id
       WHERE i.producer_agent_id = $1
         ${tickPlaceholder ? `AND i.created_at_tick >= ${tickPlaceholder}` : ''}
       ORDER BY i.created_at DESC LIMIT $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[IntelAPI] /produced/:agentId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/history
 * All intel items (active + expired) ordered by creation time, for history view
 */
router.get('/history', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(String(req.query.limit)) || 30, 100);
    const offset = parseInt(String(req.query.offset)) || 0;
    const category = req.query.category as string | undefined;

    const params: (string | number)[] = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    let where = appendTickConstraint('WHERE 1=1', 'i.created_at_tick', tickPlaceholder);
    let paramIdx = params.length + 1;

    if (category) {
      where += ` AND i.category = $${paramIdx++}`;
      params.push(category);
    }

    params.push(limit, offset);

    const [result, signals, currentTick] = await Promise.all([
      pool.query(
      `SELECT i.*,
              pa.name as producer_name, pa.archetype as producer_archetype,
              sa.name as subject_name, sa.archetype as subject_archetype
       FROM intel_items i
       JOIN agents pa ON i.producer_agent_id = pa.agent_id
       LEFT JOIN agents sa ON i.subject_agent_id = sa.agent_id
       ${where}
       ORDER BY i.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
      ),
      loadIntelMarketSignals(),
      getCurrentTick(),
    ]);

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM intel_items i ${where}`,
      params.slice(0, -2)
    );

    res.json({
      items: result.rows.map((row) => ({
        ...presentIntelRow(row, currentTick, describeIntelMarketSignal(row, signals)),
      })),
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (err) {
    console.error('[IntelAPI] /history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/credit/:agentId
 * Get intel credit score for a producer
 */
router.get('/credit/:agentId', async (req, res) => {
  try {
    const pool = getPool();
    const params: Array<string | number> = [req.params.agentId];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    const result = await pool.query(
      `SELECT
         producer_agent_id as agent_id,
         COUNT(*) as total_produced,
         COUNT(*) FILTER (WHERE verified_accuracy IS NOT NULL) as total_verified,
         COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) as average_accuracy,
         COUNT(*) FILTER (WHERE is_fake = true) as fake_count,
         GREATEST(0, LEAST(100,
           50
           + (COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) - 0.5) * 80
           - COUNT(*) FILTER (WHERE is_fake = true) * 8
         )) as credit_score
       FROM intel_items
       WHERE producer_agent_id = $1
         ${tickPlaceholder ? `AND created_at_tick >= ${tickPlaceholder}` : ''}
       GROUP BY producer_agent_id`,
      params
    );

    if (result.rows.length === 0) {
      return res.json({
        agent_id: req.params.agentId,
        total_produced: 0,
        total_verified: 0,
        average_accuracy: 0.5,
        fake_count: 0,
        credit_score: 50,
        tier: 'neutral',
      });
    }

    const row = result.rows[0] as Record<string, unknown>;
    const score = Number(row.credit_score ?? 50);
    res.json({
      ...row,
      total_produced: Number(row.total_produced ?? 0),
      total_verified: Number(row.total_verified ?? 0),
      average_accuracy: Number(row.average_accuracy ?? 0.5),
      fake_count: Number(row.fake_count ?? 0),
      credit_score: score,
      tier: getCreditTier(score),
    });
  } catch (err) {
    console.error('[IntelAPI] /credit/:agentId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/leaderboard
 * Top intel producers by credit score
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const pool = getPool();
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);

    const result = await pool.query(
      `SELECT
         i.producer_agent_id as agent_id,
         a.name,
         a.archetype,
         COUNT(*) as total_produced,
         COUNT(*) FILTER (WHERE verified_accuracy IS NOT NULL) as total_verified,
         COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) as average_accuracy,
         COUNT(*) FILTER (WHERE is_fake = true) as fake_count,
         GREATEST(0, LEAST(100,
           50
           + (COALESCE(AVG(verified_accuracy) FILTER (WHERE verified_accuracy IS NOT NULL), 0.5) - 0.5) * 80
           - COUNT(*) FILTER (WHERE is_fake = true) * 8
         )) as credit_score
       FROM intel_items i
       JOIN agents a ON i.producer_agent_id = a.agent_id
       ${tickPlaceholder ? `WHERE i.created_at_tick >= ${tickPlaceholder}` : ''}
       GROUP BY i.producer_agent_id, a.name, a.archetype
       ORDER BY credit_score DESC
       LIMIT 20`,
      params
    );

    res.json(result.rows.map((row) => ({
      ...row,
      total_produced: Number(row.total_produced),
      total_verified: Number(row.total_verified),
      average_accuracy: Number(row.average_accuracy),
      fake_count: Number(row.fake_count),
      credit_score: Number(row.credit_score),
      tier: getCreditTier(Number(row.credit_score)),
    })));
  } catch (err) {
    console.error('[IntelAPI] /leaderboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/counter-events
 * Recent counter-intel events
 */
router.get('/counter-events', async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(String(req.query.limit)) || 20, 50);
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    params.push(limit);

    const result = await pool.query(
      `SELECT ce.*,
              sa.name as spy_name, sa.archetype as spy_archetype,
              ta.name as target_name, ta.archetype as target_archetype
       FROM counter_intel_events ce
       JOIN agents sa ON ce.spy_agent_id = sa.agent_id
       JOIN agents ta ON ce.target_agent_id = ta.agent_id
       ${tickPlaceholder ? `WHERE ce.tick_number >= ${tickPlaceholder}` : ''}
       ORDER BY ce.created_at DESC LIMIT $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[IntelAPI] /counter-events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/intel/stats
 * Market-wide statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    const itemWhere = tickPlaceholder ? `WHERE created_at_tick >= ${tickPlaceholder}` : '';
    const purchaseWhere = tickPlaceholder ? `WHERE purchased_at_tick >= ${tickPlaceholder}` : '';

    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM intel_items ${itemWhere} ${itemWhere ? 'AND' : 'WHERE'} status = 'active' AND is_public = false AND buyer_count < ${INTEL_PUBLIC_BUYER_THRESHOLD}) as active_items,
        (SELECT COUNT(*) FROM intel_items ${itemWhere} ${itemWhere ? 'AND' : 'WHERE'} is_public = false AND buyer_count >= ${INTEL_PUBLIC_BUYER_THRESHOLD}) as sealed_items,
        (SELECT COUNT(*) FROM intel_items ${itemWhere}) as total_items,
        (SELECT COUNT(*) FROM intel_purchases ${purchaseWhere}) as total_purchases,
        (SELECT COALESCE(SUM(price_paid), 0) FROM intel_purchases ${purchaseWhere}) as total_volume,
        (SELECT COUNT(*) FROM intel_items ${itemWhere} ${itemWhere ? 'AND' : 'WHERE'} is_fake = true) as total_fake,
        (SELECT AVG(accuracy) FROM intel_items ${itemWhere} ${itemWhere ? 'AND' : 'WHERE'} verified_accuracy IS NOT NULL) as avg_verified_accuracy,
        (SELECT COUNT(DISTINCT producer_agent_id) FROM intel_items ${itemWhere} ${itemWhere ? 'AND' : 'WHERE'} status = 'active') as active_producers
    `, params);

    const stats = result.rows[0];
    const totalItems = parseInt(stats.total_items) || 1;
    const fakeRate = parseInt(stats.total_fake) / totalItems;

    res.json({
      activeItems: parseInt(stats.active_items),
      sealedItems: parseInt(stats.sealed_items),
      totalItems: parseInt(stats.total_items),
      totalPurchases: parseInt(stats.total_purchases),
      totalVolume: parseFloat(stats.total_volume) || 0,
      fakeRate: Number(fakeRate.toFixed(3)),
      avgVerifiedAccuracy: stats.avg_verified_accuracy ? parseFloat(stats.avg_verified_accuracy) : null,
      activeProducers: parseInt(stats.active_producers),
    });
  } catch (err) {
    console.error('[IntelAPI] /stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/intel/debug/produce
 * Manually trigger intel production (for testing)
 */
router.post('/debug/produce', async (_req, res) => {
  try {
    const pool = getPool();

    // Get agents directly
    const agentsResult = await pool.query(
      'SELECT agent_id, name, archetype, balance, reputation_score FROM agents WHERE is_alive = true'
    );
    const agents = agentsResult.rows;

    // Import types
    const { ARCHETYPE_INTEL_PROFILE, INTEL_CATEGORY_BASE_PRICE } = await import('./intel-types.js');

    const allCategories = ['fate_dimension', 'behavior_pattern', 'relationship_map', 'economic_forecast', 'price_signal', 'counter_intel'] as const;
    let produced = 0;

    for (const agent of agents) {
      const profile = ARCHETYPE_INTEL_PROFILE[agent.archetype];
      if (!profile) continue;

      // Force produce one item per agent (skip random roll for debug)
      const category = profile.specialties[Math.floor(Math.random() * profile.specialties.length)] || allCategories[Math.floor(Math.random() * allCategories.length)];
      const others = agents.filter((a: any) => a.agent_id !== agent.agent_id);
      const subjectId = (category === 'economic_forecast' || category === 'price_signal') ? null : (others[Math.floor(Math.random() * others.length)]?.agent_id || null);

      const isFake = Math.random() < profile.fakeRate;
      const accuracy = Math.max(0.1, Math.min(0.95, profile.accuracyBase + (Math.random() * 0.1 - 0.05)));
      const declaredAcc = isFake ? Math.min(0.95, accuracy + 0.1 + Math.random() * 0.2) : accuracy;
      const basePrice = (INTEL_CATEGORY_BASE_PRICE as any)[category] || 0.05;
      const price = Math.max(0.01, basePrice * profile.pricingMultiplier * (1 + declaredAcc * 0.3));

      const tickResult = await pool.query('SELECT COALESCE(MAX(tick_number), 0) as tick FROM economy_state');
      const currentTick = parseInt(tickResult.rows[0].tick) || 1;

      const content = {
        type: category,
        summary: `[Debug] ${agent.name} generated ${category} intel`,
        data: { debug: true, producer: agent.name, isFake },
      };

      await pool.query(
        `INSERT INTO intel_items
         (category, producer_agent_id, subject_agent_id, content, accuracy, declared_accuracy,
          is_fake, freshness, price, buyer_count, is_public, status, expires_at_tick, created_at_tick)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1.0, $8, 0, false, 'active', $9, $10)`,
        [category, agent.agent_id, subjectId, JSON.stringify(content), accuracy, declaredAcc, isFake, Number(price.toFixed(4)), currentTick + 40, currentTick]
      );
      produced++;
    }

    // Update credit scores
    await pool.query(`
      INSERT INTO intel_credit_scores (agent_id, total_produced, fake_count, credit_score, tier, updated_at)
      SELECT
        producer_agent_id,
        COUNT(*) as total_produced,
        COUNT(*) FILTER (WHERE is_fake = true) as fake_count,
        GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) as credit_score,
        CASE
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 80 THEN 'elite'
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 60 THEN 'trusted'
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 40 THEN 'neutral'
          WHEN GREATEST(0, LEAST(100, 50 + (AVG(accuracy) - 0.5) * 60 - COUNT(*) FILTER (WHERE is_fake = true) * 8)) >= 20 THEN 'suspicious'
          ELSE 'blacklisted'
        END as tier,
        NOW()
      FROM intel_items
      GROUP BY producer_agent_id
      ON CONFLICT (agent_id) DO UPDATE SET
        total_produced = EXCLUDED.total_produced,
        fake_count = EXCLUDED.fake_count,
        credit_score = EXCLUDED.credit_score,
        tier = EXCLUDED.tier,
        updated_at = NOW()
    `);

    const count = await pool.query('SELECT COUNT(*) as cnt FROM intel_items');
    const activeCount = await pool.query("SELECT COUNT(*) as cnt FROM intel_items WHERE status = 'active'");
    res.json({ success: true, produced, totalItems: parseInt(count.rows[0].cnt), activeItems: parseInt(activeCount.rows[0].cnt) });
  } catch (err: any) {
    console.error('[IntelAPI] debug/produce error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/intel/knowledge-overview
 * Global knowledge matrix: who knows what about whom
 */
router.get('/knowledge-overview', async (_req, res) => {
  try {
    const pool = getPool();

    // All intel_records with agent names
    const records = await pool.query(
      `SELECT ir.subject_agent_id, ir.dimension, ir.knower_agent_id, ir.source_type,
              sa.name as subject_name, sa.archetype as subject_archetype,
              ka.name as knower_name, ka.archetype as knower_archetype
       FROM intel_records ir
       JOIN agents sa ON ir.subject_agent_id = sa.agent_id
       JOIN agents ka ON ir.knower_agent_id = ka.agent_id
       ORDER BY ir.created_at DESC`,
    );

    // Recent spy/discover activity
    const recentActivity = await pool.query(
      `SELECT ir.subject_agent_id, ir.dimension, ir.knower_agent_id, ir.source_type, ir.created_at,
              sa.name as subject_name, sa.archetype as subject_archetype,
              ka.name as knower_name, ka.archetype as knower_archetype
       FROM intel_records ir
       JOIN agents sa ON ir.subject_agent_id = sa.agent_id
       JOIN agents ka ON ir.knower_agent_id = ka.agent_id
       ORDER BY ir.created_at DESC
       LIMIT 20`,
    );

    // Summary: per agent, how many dimensions are known by self vs others
    const summary = await pool.query(
      `SELECT a.agent_id, a.name, a.archetype,
              COUNT(*) FILTER (WHERE ir.knower_agent_id = a.agent_id) as self_known,
              COUNT(*) FILTER (WHERE ir.knower_agent_id != a.agent_id) as known_by_others,
              COUNT(DISTINCT ir.dimension) FILTER (WHERE ir.knower_agent_id = a.agent_id) as unique_self_dims,
              COUNT(DISTINCT ir.knower_agent_id) FILTER (WHERE ir.knower_agent_id != a.agent_id) as spied_by_count,
              COUNT(*) FILTER (
                WHERE ir.knower_agent_id = a.agent_id
                  AND ir.subject_agent_id != a.agent_id
                  AND ir.source_type IN ('spy', 'purchase')
              ) as listable_count
       FROM agents a
       LEFT JOIN intel_records ir ON ir.subject_agent_id = a.agent_id
       GROUP BY a.agent_id, a.name, a.archetype
       ORDER BY a.name`,
    );

    const enrichedSummary = await Promise.all(
      summary.rows.map(async (row) => {
        const capability = await getIntelCapabilitySnapshot(row.agent_id);
        return {
          ...row,
          phase: capability.phase,
          unlocks: capability.unlocks,
          listable_count: Number(row.listable_count ?? 0),
          phase_metrics: capability.metrics,
        };
      }),
    );

    res.json({
      records: records.rows,
      recentActivity: recentActivity.rows.map((row) => ({
        ...row,
        can_sell: row.source_type !== 'self_discover',
      })),
      agentSummary: enrichedSummary,
      totalRecords: records.rows.length,
    });
  } catch (err) {
    console.error('[IntelAPI] /knowledge-overview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

import { Router, type Router as RouterType } from 'express';
import { getPool } from '../db/postgres.js';
import { SUPPORTED_PAIRS, fetchCurrentPrice } from './price-feed.js';

const router: RouterType = Router();

/**
 * GET /api/prediction/current
 * Returns the current active prediction round and all agent positions
 * If no active round, returns the latest settled round instead
 */
router.get('/current', async (_req, res) => {
  try {
    const pool = getPool();

    // Try to get the latest active (non-settled) round
    const activeRound = await pool.query(
      `SELECT * FROM prediction_rounds
       WHERE phase NOT IN ('settled', 'flash_settled')
       ORDER BY id DESC LIMIT 1`
    );

    let round = null;
    let positions = [];

    if (activeRound.rows.length > 0) {
      // Active round found, use it
      round = activeRound.rows[0];
    } else {
      // No active round, return the latest settled round instead
      const settledRound = await pool.query(
        'SELECT * FROM prediction_rounds ORDER BY id DESC LIMIT 1'
      );

      if (settledRound.rows.length === 0) {
        return res.json({ round: null, positions: [] });
      }

      round = settledRound.rows[0];
    }

    // Get all positions for the round with agent info
    const positionsResult = await pool.query(
      `SELECT pp.*, a.name, a.archetype FROM prediction_positions pp
       JOIN agents a ON pp.agent_id = a.agent_id
       WHERE pp.round_id = $1
       ORDER BY pp.payout DESC`,
      [round.id]
    );

    positions = positionsResult.rows;

    res.json({ round, positions });
  } catch (err) {
    console.error('[PredictionAPI] /current error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/prediction/prices
 * Returns the current market prices for all supported trading pairs
 * Includes: prices object and ISO timestamp
 */
router.get('/prices', async (_req, res) => {
  try {
    const prices: Record<string, number> = {};

    // Fetch current price for each supported pair
    for (const pair of SUPPORTED_PAIRS) {
      try {
        prices[pair] = await fetchCurrentPrice(pair);
      } catch (priceFetchError) {
        console.warn(`[PredictionAPI] Failed to fetch price for ${pair}:`, priceFetchError);
        // Set a null value if price fetch fails
        prices[pair] = 0;
      }
    }

    res.json({
      prices,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[PredictionAPI] /prices error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/prediction/price-history?pair=BTC-USDT&limit=30
 * Returns recent price snapshots for charting
 */
router.get('/price-history', async (req, res) => {
  try {
    const pool = getPool();
    const pair = String(req.query.pair || 'BTC-USDT');
    const limit = Math.min(parseInt(String(req.query.limit)) || 30, 100);
    const result = await pool.query(
      'SELECT price, tick_number, fetched_at FROM price_snapshots WHERE inst_id = $1 ORDER BY tick_number DESC LIMIT $2',
      [pair, limit],
    );
    res.json(result.rows.reverse()); // oldest first for charting
  } catch (err) {
    console.error('[PredictionAPI] /price-history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/prediction/history?limit=20&offset=0
 * Returns historical prediction rounds with pagination support
 * Query params:
 *   - limit: max records to return (default 20, max 100)
 *   - offset: starting position (default 0)
 */
router.get('/history', async (req, res) => {
  try {
    const pool = getPool();

    // Parse and validate query params
    const limit = Math.min(parseInt(String(req.query.limit)) || 20, 100);
    const offset = parseInt(String(req.query.offset)) || 0;

    if (limit < 1 || offset < 0) {
      return res.status(400).json({ error: 'Invalid pagination parameters' });
    }

    const rounds = await pool.query(
      `SELECT * FROM prediction_rounds ORDER BY round_number DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json(rounds.rows);
  } catch (err) {
    console.error('[PredictionAPI] /history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/prediction/agent/:agentId
 * Returns comprehensive prediction statistics for a specific agent
 * Includes: accuracy metrics, PnL, position type breakdown, flash settlement performance
 */
router.get('/agent/:agentId', async (req, res) => {
  try {
    const pool = getPool();
    const { agentId } = req.params;

    if (!agentId) {
      return res.status(400).json({ error: 'Agent ID is required' });
    }

    const stats = await pool.query(
      `SELECT
        COUNT(*) as total_predictions,
        COUNT(*) FILTER (WHERE prediction_correct = true) as correct_predictions,
        COUNT(*) FILTER (WHERE magnitude_correct = true) as magnitude_correct,
        ROUND(COALESCE(AVG(CASE WHEN prediction_correct THEN 1 ELSE 0 END), 0)::numeric, 3) as accuracy,
        COALESCE(SUM(payout), 0) as total_payout,
        COALESCE(SUM(entry_fee), 0) as total_spent,
        COALESCE(SUM(final_pnl), 0) as net_pnl,
        COUNT(*) FILTER (WHERE position_type = 'hedge') as hedge_count,
        COUNT(*) FILTER (WHERE position_type LIKE '%big%') as big_count,
        COUNT(*) FILTER (WHERE closed_early = true) as early_close_count
       FROM prediction_positions
       WHERE agent_id = $1`,
      [agentId]
    );

    res.json(stats.rows[0] ?? {});
  } catch (err) {
    console.error('[PredictionAPI] /agent/:agentId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/prediction/leaderboard
 * Returns the prediction accuracy leaderboard sorted by net PnL
 * Includes: agent name, archetype, rounds played, accuracy, net PnL
 */
router.get('/leaderboard', async (_req, res) => {
  try {
    const pool = getPool();

    const lb = await pool.query(
      `SELECT
        pp.agent_id,
        a.name,
        a.archetype,
        COUNT(*) as rounds_played,
        COUNT(*) FILTER (WHERE pp.prediction_correct = true) as correct,
        ROUND(COALESCE(AVG(CASE WHEN pp.prediction_correct THEN 1 ELSE 0 END), 0)::numeric, 3) as accuracy,
        COALESCE(SUM(pp.final_pnl), 0) as net_pnl
       FROM prediction_positions pp
       JOIN agents a ON pp.agent_id = a.agent_id
       GROUP BY pp.agent_id, a.name, a.archetype
       ORDER BY net_pnl DESC`
    );

    res.json(lb.rows);
  } catch (err) {
    console.error('[PredictionAPI] /leaderboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/prediction/round/:roundId
 * Returns a specific prediction round with all positions for detail expansion
 */
router.get('/round/:roundId', async (req, res) => {
  try {
    const pool = getPool();
    const roundId = parseInt(req.params.roundId);

    if (!roundId || roundId < 1) {
      return res.status(400).json({ error: 'Valid round ID is required' });
    }

    const round = await pool.query(
      `SELECT * FROM prediction_rounds WHERE id = $1`,
      [roundId]
    );

    if (round.rows.length === 0) {
      return res.status(404).json({ error: 'Round not found' });
    }

    const positions = await pool.query(
      `SELECT pp.*, a.name, a.archetype FROM prediction_positions pp
       JOIN agents a ON pp.agent_id = a.agent_id
       WHERE pp.round_id = $1 ORDER BY pp.payout DESC`,
      [roundId]
    );

    res.json({
      round: round.rows[0],
      positions: positions.rows
    });
  } catch (err) {
    console.error('[PredictionAPI] /round/:roundId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

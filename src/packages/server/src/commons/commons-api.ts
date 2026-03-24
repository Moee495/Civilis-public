import { Router, type Router as RouterType } from 'express';
import { getPool } from '../db/postgres.js';
import {
  appendMainnetEpochTickFilter,
} from '../config/mainnet-epoch.js';

const router: RouterType = Router();

/**
 * GET /api/commons/current
 * Returns the current active commons round and all decisions made in that round
 */
router.get('/current', async (_req, res) => {
  try {
    const pool = getPool();
    const params: Array<string | number> = [];
    const where: string[] = ['1=1'];
    appendMainnetEpochTickFilter(where, params, 'tick_number');

    // Get the latest active round
    const round = await pool.query(
      `SELECT * FROM commons_rounds WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`,
      params,
    );

    if (round.rows.length === 0) {
      return res.json({ round: null, decisions: [] });
    }

    // Get all decisions for this round, sorted by payout descending
    const decisions = await pool.query(
      `SELECT cd.*, a.name, a.archetype FROM commons_decisions cd
       JOIN agents a ON cd.agent_id = a.agent_id
       WHERE cd.round_id = $1 ORDER BY cd.payout DESC`,
      [round.rows[0].id]
    );

    res.json({
      round: round.rows[0],
      decisions: decisions.rows
    });
  } catch (err) {
    console.error('[CommonsAPI] /current error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/commons/history?limit=20&offset=0
 * Returns historical commons rounds with pagination support
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

    const params: Array<string | number> = [];
    const where: string[] = ['1=1'];
    appendMainnetEpochTickFilter(where, params, 'tick_number');
    params.push(limit, offset);

    const rounds = await pool.query(
      `SELECT * FROM commons_rounds WHERE ${where.join(' AND ')} ORDER BY round_number DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rounds.rows);
  } catch (err) {
    console.error('[CommonsAPI] /history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/commons/agent/:agentId
 * Returns comprehensive commons statistics for a specific agent
 * Includes: total rounds, decisions breakdown, profitability, cooperation metrics
 */
router.get('/agent/:agentId', async (req, res) => {
  try {
    const pool = getPool();
    const { agentId } = req.params;

    if (!agentId) {
      return res.status(400).json({ error: 'Agent ID is required' });
    }

    const params: Array<string | number> = [agentId];
    const where: string[] = ['cd.agent_id = $1'];
    appendMainnetEpochTickFilter(where, params, 'cr.tick_number');
    const stats = await pool.query(
      `WITH filtered AS (
         SELECT
           cd.decision,
           cd.payout,
           cd.cost,
           cd.net_profit,
           cr.round_number
         FROM commons_decisions cd
         JOIN commons_rounds cr ON cr.id = cd.round_id
         WHERE ${where.join(' AND ')}
       ),
       contribute_runs AS (
         SELECT
           decision,
           round_number,
           ROW_NUMBER() OVER (ORDER BY round_number)
             - ROW_NUMBER() OVER (PARTITION BY decision ORDER BY round_number) AS grp
         FROM filtered
       ),
       contribute_streaks AS (
         SELECT COUNT(*) AS streak
         FROM contribute_runs
         WHERE decision = 'contribute'
         GROUP BY grp
       )
       SELECT
         COUNT(*) as total_rounds,
         COUNT(*) FILTER (WHERE decision = 'contribute') as contributions,
         COUNT(*) FILTER (WHERE decision = 'free_ride') as free_rides,
         COUNT(*) FILTER (WHERE decision = 'hoard') as hoards,
         COUNT(*) FILTER (WHERE decision = 'sabotage') as sabotages,
         COALESCE(SUM(payout), 0) as total_payout,
         COALESCE(SUM(cost), 0) as total_cost,
         COALESCE(SUM(net_profit), 0) as net_profit,
         ROUND(COALESCE(AVG(CASE WHEN decision = 'contribute' THEN 1 ELSE 0 END), 0)::numeric, 3) as cooperation_rate,
         COALESCE((SELECT MAX(streak) FROM contribute_streaks), 0) as max_contribute_streak
       FROM filtered`,
      params
    );

    res.json(stats.rows[0] ?? {});
  } catch (err) {
    console.error('[CommonsAPI] /agent/:agentId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/commons/leaderboard
 * Returns the top contributors leaderboard sorted by net profit
 * Includes: agent name, archetype, rounds played, contributions, cooperation rate, net profit
 */
router.get('/leaderboard', async (_req, res) => {
  try {
    const pool = getPool();
    const params: Array<string | number> = [];
    const where: string[] = ['1=1'];
    appendMainnetEpochTickFilter(where, params, 'cr.tick_number');

    const lb = await pool.query(
      `SELECT
        cd.agent_id,
        a.name,
        a.archetype,
        COUNT(*) as rounds_played,
        COUNT(*) FILTER (WHERE cd.decision = 'contribute') as contributions,
        ROUND(AVG(CASE WHEN cd.decision = 'contribute' THEN 1 ELSE 0 END)::numeric, 3) as coop_rate,
        COALESCE(SUM(cd.net_profit), 0) as net_profit
       FROM commons_decisions cd
       JOIN commons_rounds cr ON cr.id = cd.round_id
       JOIN agents a ON cd.agent_id = a.agent_id
       WHERE ${where.join(' AND ')}
       GROUP BY cd.agent_id, a.name, a.archetype
       ORDER BY net_profit DESC`,
      params
    );

    res.json(lb.rows);
  } catch (err) {
    console.error('[CommonsAPI] /leaderboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/commons/round/:roundId
 * Returns a specific commons round with all decisions for detail expansion
 */
router.get('/round/:roundId', async (req, res) => {
  try {
    const pool = getPool();
    const roundId = parseInt(req.params.roundId);

    if (!roundId || roundId < 1) {
      return res.status(400).json({ error: 'Valid round ID is required' });
    }

    const params: Array<string | number> = [roundId];
    const where: string[] = ['id = $1'];
    appendMainnetEpochTickFilter(where, params, 'tick_number');
    const round = await pool.query(
      `SELECT * FROM commons_rounds WHERE ${where.join(' AND ')}`,
      params
    );

    if (round.rows.length === 0) {
      return res.status(404).json({ error: 'Round not found' });
    }

    const decisions = await pool.query(
      `SELECT cd.*, a.name, a.archetype FROM commons_decisions cd
       JOIN agents a ON cd.agent_id = a.agent_id
       WHERE cd.round_id = $1 ORDER BY cd.payout DESC`,
      [roundId]
    );

    res.json({
      round: round.rows[0],
      decisions: decisions.rows
    });
  } catch (err) {
    console.error('[CommonsAPI] /round/:roundId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

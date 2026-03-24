import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getPool } from '../db/postgres.js';
import {
  getCurrentTick,
  isWorldEngineRunning,
  startWorldEngine,
  stopWorldEngine,
} from './tick-engine.js';
import { getCurrentEconomyPhase, getCurrentEconomyParams } from '../economy/economy-regulator.js';
import { gatherLifeData } from './farewell-generator.js';
import { generateFarewellContent } from './farewell-llm.js';
import { getLatestWorldEventEvaluationTick } from './event-runs.js';
import { getAgentWorldExposure, getWorldAnalyticsSummary } from './exposure.js';
import { getLatestWorldSignalSnapshot, listRecentWorldSignals } from './signals.js';
import { getLatestWorldTickRun } from './tick-runs.js';
import { getMarketCondition, getMarketOracleStatus } from './market-oracle.js';
import {
  getActiveWorldModifierCount,
  getWorldModifierResolvedValue,
  getWorldModifierStackPolicy,
  listWorldModifiers,
  resolveActiveWorldModifiers,
  summarizeWorldModifierStacks,
} from './modifiers.js';
import {
  getMainnetEpochMeta,
  pushMainnetEpochStartAtParam,
  pushMainnetEpochStartTickParam,
} from '../config/mainnet-epoch.js';

const router: Router = Router();

function buildModifierBreakdown(
  activeModifiers: Array<{
    id: number;
    modifierType: string;
    sourceEventId: number | null;
    value: Record<string, unknown>;
    startsAtTick: number;
    endsAtTick: number | null;
  }>,
  modifierType: string,
): Array<{
  modifierId: number;
  sourceEventId: number | null;
  value: Record<string, unknown>;
  startsAtTick: number;
  endsAtTick: number | null;
}> {
  return activeModifiers
    .filter((modifier) => modifier.modifierType === modifierType)
    .map((modifier) => ({
      modifierId: modifier.id,
      sourceEventId: modifier.sourceEventId,
      value: modifier.value,
      startsAtTick: modifier.startsAtTick,
      endsAtTick: modifier.endsAtTick,
    }));
}

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    const eventWhere = tickPlaceholder ? `WHERE tick_number >= ${tickPlaceholder}` : '';
    const [summary, activeModifierCount, latestSignalSnapshot, lastEventEvaluation, latestTickRun] = await Promise.all([
      pool.query(
      `SELECT
         GREATEST(
           COALESCE((SELECT MAX(tick_number) FROM economy_state), 0),
           COALESCE((SELECT MAX(tick_number) FROM tick_snapshots), 0)
         ) AS persisted_tick,
         (SELECT COUNT(*) FROM agents WHERE is_alive = true) AS alive_agents,
         (SELECT COUNT(*) FROM agents WHERE is_alive = false) AS dead_agents,
         (SELECT COUNT(*) FROM arena_matches WHERE status <> 'settled') AS active_matches,
         (SELECT COUNT(*) FROM world_events ${eventWhere}) AS event_count`,
      params,
      ),
      getActiveWorldModifierCount(),
      getLatestWorldSignalSnapshot(),
      getLatestWorldEventEvaluationTick(),
      getLatestWorldTickRun(),
    ]);

    res.json({
      tick: Number(summary.rows[0]?.persisted_tick ?? 0),
      runtimeTick: getCurrentTick(),
      running: isWorldEngineRunning(),
      worldRegime: latestSignalSnapshot?.worldRegime ?? getCurrentEconomyPhase(),
      activeModifierCount,
      lastEventEvaluationTick: lastEventEvaluation,
      latestTickRun,
      epoch: getMainnetEpochMeta(),
      ...summary.rows[0],
    });
  }),
);

router.get(
  '/events',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 50, 200);
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    const where = tickPlaceholder ? `WHERE tick_number >= ${tickPlaceholder}` : '';
    params.push(limit);
    const events = await pool.query(
      `SELECT *
       FROM world_events
       ${where}
       ORDER BY tick_number DESC, created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json(events.rows);
  }),
);

router.get(
  '/modifiers',
  asyncHandler(async (req, res) => {
    const status = req.query.status === 'expired' ? 'expired' : 'active';
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 50, 200);
    const modifiers = await listWorldModifiers({ status, limit });
    res.json(modifiers);
  }),
);

router.get(
  '/signals/latest',
  asyncHandler(async (_req, res) => {
    const latest = await getLatestWorldSignalSnapshot();
    res.json(latest);
  }),
);

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 10, 50);
    const summaryParams: Array<string | number> = [];
    const summaryTickPlaceholder = pushMainnetEpochStartTickParam(summaryParams);
    const eventWhere = summaryTickPlaceholder ? `WHERE tick_number >= ${summaryTickPlaceholder}` : '';
    const recentEventParams: Array<string | number> = [];
    const recentEventTickPlaceholder = pushMainnetEpochStartTickParam(recentEventParams);
    const recentEventWhere = recentEventTickPlaceholder ? `WHERE tick_number >= ${recentEventTickPlaceholder}` : '';
    recentEventParams.push(limit);
    const [statusSummary, latestSignal, activeModifiers, recentEvents, recentSignals, latestTickRun] = await Promise.all([
      pool.query(
        `SELECT
           GREATEST(
             COALESCE((SELECT MAX(tick_number) FROM economy_state), 0),
             COALESCE((SELECT MAX(tick_number) FROM tick_snapshots), 0)
           ) AS persisted_tick,
           (SELECT COUNT(*) FROM world_events ${eventWhere}) AS total_events,
           (SELECT COUNT(*) FROM world_modifiers WHERE status = 'active') AS active_modifiers,
           (SELECT COUNT(*) FROM world_event_runs ${eventWhere}) AS event_runs`,
        summaryParams,
      ),
      getLatestWorldSignalSnapshot(),
      listWorldModifiers({ status: 'active', limit }),
      pool.query(
        `SELECT *
         FROM world_events
         ${recentEventWhere}
         ORDER BY tick_number DESC, created_at DESC
         LIMIT $${recentEventParams.length}`,
        recentEventParams,
      ),
      listRecentWorldSignals(limit),
      getLatestWorldTickRun(),
    ]);

    res.json({
      status: {
        running: isWorldEngineRunning(),
        tick: Number(statusSummary.rows[0]?.persisted_tick ?? getCurrentTick()),
        runtimeTick: getCurrentTick(),
        persistedTick: Number(statusSummary.rows[0]?.persisted_tick ?? getCurrentTick()),
        worldRegime: latestSignal?.worldRegime ?? getCurrentEconomyPhase(),
        latestTickRun,
        epoch: getMainnetEpochMeta(),
        ...statusSummary.rows[0],
      },
      marketOracleStatus: getMarketOracleStatus(),
      latestSignal,
      activeModifiers,
      modifierStacks: summarizeWorldModifierStacks(activeModifiers),
      recentSignals,
      recentEvents: recentEvents.rows,
    });
  }),
);

router.get(
  '/agent/:agentId/context',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const [
      latestSignal,
      activeModifiers,
      riskToleranceShiftResolved,
      divinationPriceMultiplierResolved,
      forcedMatchPressureResolved,
      tournamentAttentionResolved,
    ] =
      await Promise.all([
        getLatestWorldSignalSnapshot(),
        resolveActiveWorldModifiers({ scopeRefs: [agentId], includeGlobal: true, limit: 50 }),
        getWorldModifierResolvedValue({
          domain: 'agent_decision',
          modifierType: 'risk_tolerance_shift',
          scopeRefs: [agentId],
          includeGlobal: true,
        }),
        getWorldModifierResolvedValue({
          domain: 'fate',
          modifierType: 'divination_price_multiplier',
          scopeRefs: [agentId],
          includeGlobal: true,
        }),
        getWorldModifierResolvedValue({
          domain: 'arena',
          modifierType: 'forced_match_pressure',
          scopeRefs: [agentId],
          includeGlobal: true,
        }),
        getWorldModifierResolvedValue({
          domain: 'arena',
          modifierType: 'tournament_attention',
          scopeRefs: [agentId],
          includeGlobal: true,
        }),
      ]);

    const resolvedTick = Math.max(getCurrentTick(), latestSignal?.tickNumber ?? 0);

    res.json({
      agentId,
      tick: resolvedTick,
      worldRegime: latestSignal?.worldRegime ?? getCurrentEconomyPhase(),
      latestSignal,
      activeModifiers,
      modifierStacks: summarizeWorldModifierStacks(activeModifiers),
      summary: {
        riskToleranceShift:
          typeof riskToleranceShiftResolved.effectiveValue === 'number'
            ? riskToleranceShiftResolved.effectiveValue
            : 0,
        riskToleranceShiftBreakdown: buildModifierBreakdown(activeModifiers, 'risk_tolerance_shift'),
        riskToleranceShiftPolicy: getWorldModifierStackPolicy('risk_tolerance_shift'),
        riskToleranceShiftCapped: riskToleranceShiftResolved.capped,
        riskToleranceShiftContributorCount: riskToleranceShiftResolved.selected.length,
        divinationPriceMultiplier:
          typeof divinationPriceMultiplierResolved.effectiveValue === 'number'
            ? divinationPriceMultiplierResolved.effectiveValue
            : 1,
        divinationPriceMultiplierBreakdown: buildModifierBreakdown(activeModifiers, 'divination_price_multiplier'),
        divinationPriceMultiplierPolicy: getWorldModifierStackPolicy('divination_price_multiplier'),
        divinationPriceMultiplierCapped: divinationPriceMultiplierResolved.capped,
        divinationPriceMultiplierContributorCount: divinationPriceMultiplierResolved.selected.length,
        forcedMatchPressure: Boolean(forcedMatchPressureResolved.effectiveValue),
        forcedMatchPressureBreakdown: buildModifierBreakdown(activeModifiers, 'forced_match_pressure'),
        forcedMatchPressurePolicy: getWorldModifierStackPolicy('forced_match_pressure'),
        forcedMatchPressureContributorCount: forcedMatchPressureResolved.selected.length,
        tournamentAttention: Boolean(tournamentAttentionResolved.effectiveValue),
        tournamentAttentionBreakdown: buildModifierBreakdown(activeModifiers, 'tournament_attention'),
        tournamentAttentionPolicy: getWorldModifierStackPolicy('tournament_attention'),
        tournamentAttentionContributorCount: tournamentAttentionResolved.selected.length,
      },
    });
  }),
);

router.get(
  '/market-status',
  asyncHandler(async (_req, res) => {
    const refresh = _req.query.refresh === '1' || _req.query.refresh === 'true';
    const sample = refresh ? await getMarketCondition() : null;
    res.json({
      ...getMarketOracleStatus(),
      sample,
    });
  }),
);

router.get(
  '/analytics/summary',
  asyncHandler(async (req, res) => {
    const recentTickWindow = Math.min(req.query.window ? Number(req.query.window) : 20, 200);
    res.json(await getWorldAnalyticsSummary(recentTickWindow));
  }),
);

router.get(
  '/agent/:agentId/exposure',
  asyncHandler(async (req, res) => {
    const recentTickWindow = Math.min(req.query.window ? Number(req.query.window) : 20, 200);
    res.json(await getAgentWorldExposure(req.params.agentId, recentTickWindow));
  }),
);

router.get(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 50, 200);
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    const where = tickPlaceholder ? `WHERE tick_number >= ${tickPlaceholder}` : '';
    params.push(limit);
    const snapshots = await pool.query(
      `SELECT *
       FROM tick_snapshots
       ${where}
       ORDER BY tick_number DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json(snapshots.rows);
  }),
);

router.get(
  '/trust',
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const relations = await pool.query(
      `SELECT from_agent_id, to_agent_id, trust_score, interaction_count, last_interaction_at
       FROM trust_relations
       ORDER BY updated_at DESC`,
    );
    res.json(relations.rows);
  }),
);

router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 50, 200);
    const params: Array<string | number> = [];
    const createdAtPlaceholder = pushMainnetEpochStartAtParam(params);
    const where = createdAtPlaceholder ? `WHERE created_at >= ${createdAtPlaceholder}` : '';
    params.push(limit);
    const transactions = await pool.query(
      `SELECT *
       FROM x402_transactions
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json(transactions.rows);
  }),
);

router.get(
  '/deaths',
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const deadAgents = await pool.query(
      `SELECT agent_id, name, archetype, soul_nft_hash, soul_grade, death_reason, died_at
       FROM agents
       WHERE is_alive = false
       ORDER BY died_at DESC NULLS LAST`,
    );
    res.json(deadAgents.rows);
  }),
);

/**
 * GET /api/world/death-analysis/:agentId
 * Full post-mortem analysis: cause of death, life timeline, key moments, relationships, wealth curve.
 */
router.get(
  '/death-analysis/:agentId',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const agentId = req.params.agentId;

    // Agent info
    const agentR = await pool.query(
      'SELECT * FROM agents WHERE agent_id = $1 AND is_alive = false', [agentId],
    );
    if (agentR.rows.length === 0) {
      res.status(404).json({ error: 'Dead agent not found' });
      return;
    }
    const agent = agentR.rows[0];

    // Fate card
    const fateR = await pool.query('SELECT * FROM fate_cards WHERE agent_id = $1', [agentId]);

    // Battle record
    const battleR = await pool.query<{
      total: string; wins: string; coop_count: string;
      total_earned_arena: string; total_lost_arena: string;
    }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE (player_a_id = $1 AND player_a_payout > player_b_payout) OR (player_b_id = $1 AND player_b_payout > player_a_payout)) as wins,
         COUNT(*) FILTER (WHERE (player_a_id = $1 AND player_a_action = 'cooperate') OR (player_b_id = $1 AND player_b_action = 'cooperate')) as coop_count,
         COALESCE(SUM(CASE WHEN player_a_id = $1 THEN player_a_payout WHEN player_b_id = $1 THEN player_b_payout ELSE 0 END), 0) as total_earned_arena,
         COALESCE(SUM(entry_fee), 0) as total_lost_arena
       FROM arena_matches WHERE status = 'settled' AND (player_a_id = $1 OR player_b_id = $1)`,
      [agentId],
    );

    // Top betrayers
    const betrayersR = await pool.query(
      `SELECT
         CASE WHEN player_a_id = $1 THEN b.name ELSE a.name END as betrayer_name,
         CASE WHEN player_a_id = $1 THEN player_b_id ELSE player_a_id END as betrayer_id,
         COUNT(*) as count
       FROM arena_matches m
       JOIN agents a ON a.agent_id = m.player_a_id
       JOIN agents b ON b.agent_id = m.player_b_id
       WHERE m.status = 'settled'
         AND ((m.player_a_id = $1 AND m.player_a_action = 'cooperate' AND m.player_b_action = 'betray')
           OR (m.player_b_id = $1 AND m.player_b_action = 'cooperate' AND m.player_a_action = 'betray'))
       GROUP BY betrayer_name, betrayer_id ORDER BY count DESC LIMIT 5`,
      [agentId],
    );

    // Trust relationships at death
    const trustR = await pool.query(
      `SELECT tr.to_agent_id, a.name, a.archetype, tr.trust_score
       FROM trust_relations tr JOIN agents a ON a.agent_id = tr.to_agent_id
       WHERE tr.from_agent_id = $1 ORDER BY tr.trust_score DESC LIMIT 8`,
      [agentId],
    );

    // Wealth flow breakdown
    const wealthR = await pool.query<{ tx_type: string; direction: string; volume: string; count: string }>(
      `SELECT tx_type,
              CASE WHEN from_agent_id = $1 THEN 'out' ELSE 'in' END as direction,
              SUM(amount) as volume, COUNT(*) as count
       FROM x402_transactions WHERE from_agent_id = $1 OR to_agent_id = $1
       GROUP BY tx_type, direction ORDER BY volume DESC`,
      [agentId],
    );

    // Balance snapshots (wealth curve)
    const balanceCurveR = await pool.query<{ tick_number: number; balance: string }>(
      `SELECT tick_number,
              (agent_balances->>$1)::decimal as balance
       FROM tick_snapshots
       WHERE agent_balances ? $1
       ORDER BY tick_number ASC`,
      [agentId],
    );

    // Key moments
    const biggestWinR = await pool.query(
      `SELECT *, CASE WHEN player_a_id = $1 THEN player_a_payout ELSE player_b_payout END as my_payout,
              CASE WHEN player_a_id = $1 THEN b.name ELSE a.name END as opponent_name
       FROM arena_matches m JOIN agents a ON a.agent_id = m.player_a_id JOIN agents b ON b.agent_id = m.player_b_id
       WHERE m.status = 'settled' AND (m.player_a_id = $1 OR m.player_b_id = $1)
       ORDER BY CASE WHEN m.player_a_id = $1 THEN m.player_a_payout ELSE m.player_b_payout END DESC LIMIT 1`,
      [agentId],
    );
    const biggestLossR = await pool.query(
      `SELECT *, CASE WHEN player_a_id = $1 THEN player_a_payout ELSE player_b_payout END as my_payout,
              CASE WHEN player_a_id = $1 THEN b.name ELSE a.name END as opponent_name
       FROM arena_matches m JOIN agents a ON a.agent_id = m.player_a_id JOIN agents b ON b.agent_id = m.player_b_id
       WHERE m.status = 'settled' AND (m.player_a_id = $1 OR m.player_b_id = $1)
       ORDER BY CASE WHEN m.player_a_id = $1 THEN m.player_a_payout ELSE m.player_b_payout END ASC LIMIT 1`,
      [agentId],
    );

    // Farewell post
    const farewellR = await pool.query(
      `SELECT content FROM posts WHERE author_agent_id = $1 AND post_type = 'farewell' ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );

    // Inheritance info
    const inheritanceR = await pool.query(
      `SELECT to_agent_id, amount, metadata FROM x402_transactions
       WHERE from_agent_id = $1 AND tx_type = 'death_inheritance' LIMIT 1`,
      [agentId],
    );
    const heirName = inheritanceR.rows[0]?.to_agent_id
      ? (await pool.query('SELECT name FROM agents WHERE agent_id = $1', [inheritanceR.rows[0].to_agent_id])).rows[0]?.name
      : null;

    const b = battleR.rows[0];
    const total = Number(b?.total ?? 0);
    const wins = Number(b?.wins ?? 0);

    res.json({
      agent: {
        agentId: agent.agent_id,
        name: agent.name,
        archetype: agent.archetype,
        soulGrade: agent.soul_grade,
        soulHash: agent.soul_nft_hash,
        deathReason: agent.death_reason,
        diedAt: agent.died_at,
        initialBalance: Number(agent.initial_balance),
        finalBalance: Number(agent.balance),
        reputation: agent.reputation_score,
      },
      fateCard: fateR.rows[0] ?? null,
      battle: {
        totalMatches: total,
        wins,
        losses: total - wins,
        coopRate: total > 0 ? Number((Number(b.coop_count) / total).toFixed(3)) : 0,
        totalEarnedArena: Number(b?.total_earned_arena ?? 0),
        totalLostArena: Number(b?.total_lost_arena ?? 0),
      },
      betrayers: betrayersR.rows.map((r: any) => ({
        name: r.betrayer_name, agentId: r.betrayer_id, count: Number(r.count),
      })),
      trustAtDeath: trustR.rows.map((r: any) => ({
        name: r.name, archetype: r.archetype, trustScore: Number(r.trust_score),
      })),
      wealthFlow: wealthR.rows.map((r: any) => ({
        txType: r.tx_type, direction: r.direction, volume: Number(r.volume), count: Number(r.count),
      })),
      balanceCurve: balanceCurveR.rows.map((r: any) => ({
        tick: r.tick_number, balance: Number(r.balance),
      })),
      keyMoments: {
        biggestWin: biggestWinR.rows[0] ? {
          opponent: biggestWinR.rows[0].opponent_name,
          payout: Number(biggestWinR.rows[0].my_payout),
        } : null,
        biggestLoss: biggestLossR.rows[0] ? {
          opponent: biggestLossR.rows[0].opponent_name,
          payout: Number(biggestLossR.rows[0].my_payout),
        } : null,
      },
      inheritance: inheritanceR.rows[0] ? {
        heirName,
        amount: Number(inheritanceR.rows[0].amount),
      } : null,
      farewell: farewellR.rows[0]?.content ?? null,
    });
  }),
);

/**
 * POST /api/world/regenerate-farewell/:agentId
 * Regenerate farewell speech for a dead agent using LLM or template.
 */
router.post(
  '/regenerate-farewell/:agentId',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const agentId = req.params.agentId;
    const tick = getCurrentTick();

    // Verify agent is dead
    const agent = await pool.query('SELECT is_alive FROM agents WHERE agent_id = $1', [agentId]);
    if (agent.rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    if (agent.rows[0].is_alive) { res.status(400).json({ error: 'Agent is still alive' }); return; }

    try {
      const lifeData = await gatherLifeData(agentId, tick);
      const farewell = await generateFarewellContent(lifeData, lifeData.finalBalance);
      const farewellContent = farewell.content;

      // Update in DB
      await pool.query(
        `UPDATE posts SET content = $1 WHERE author_agent_id = $2 AND post_type = 'farewell'`,
        [farewellContent, agentId],
      );

      res.json({ success: true, farewell: farewellContent, source: farewell.source });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Failed to regenerate farewell' });
    }
  }),
);

router.get(
  '/economy',
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const params: Array<string | number> = [];
    const tickPlaceholder = pushMainnetEpochStartTickParam(params);
    const where = tickPlaceholder ? `WHERE tick_number >= ${tickPlaceholder}` : '';
    const latest = await pool.query(
      `SELECT * FROM economy_state ${where} ORDER BY tick_number DESC LIMIT 1`,
      params,
    );
    if (latest.rows.length === 0) {
      const summary = await pool.query<{
        total_agent_balance: string;
        alive_agents: string;
        treasury_balance: string;
      }>(
        `SELECT
           COALESCE((SELECT SUM(balance) FROM agents WHERE is_alive = true), 0)::text AS total_agent_balance,
           COALESCE((SELECT COUNT(*) FROM agents WHERE is_alive = true), 0)::text AS alive_agents,
           COALESCE((
             SELECT
               SUM(CASE WHEN to_agent_id IS NULL THEN amount ELSE 0 END) -
               SUM(CASE WHEN from_agent_id IS NULL THEN amount ELSE 0 END)
             FROM x402_transactions
           ), 0)::text AS treasury_balance`,
      );

      const totalAgentBalance = Number(summary.rows[0]?.total_agent_balance ?? 0);
      const aliveAgents = Number(summary.rows[0]?.alive_agents ?? 0);
      const treasuryBalance = Number(summary.rows[0]?.treasury_balance ?? 0);
      const targetMoneySupply = aliveAgents * getCurrentEconomyParams().targetBalancePerAgent;
      const actualRatio = targetMoneySupply > 0 ? totalAgentBalance / targetMoneySupply : 0;

      res.json({
        economy_phase: getCurrentEconomyPhase(),
        actual_ratio: Number(actualRatio.toFixed(4)),
        pg_base_injection: getCurrentEconomyParams().pgBaseInjection,
        pd_treasury_cut: getCurrentEconomyParams().pdTreasuryCut,
        pp_treasury_cut: getCurrentEconomyParams().ppTreasuryCut,
        total_agent_balance: Number(totalAgentBalance.toFixed(6)),
        treasury_balance: Number(treasuryBalance.toFixed(6)),
        target_money_supply: Number(targetMoneySupply.toFixed(6)),
        tick_number: getCurrentTick(),
        snapshot_tick_number: getCurrentTick(),
        current_tick: getCurrentTick(),
        derived: true,
      });
      return;
    }
    res.json({
      ...latest.rows[0],
      snapshot_tick_number: Number(latest.rows[0].tick_number ?? 0),
      current_tick: getCurrentTick(),
      derived: false,
    });
  }),
);

router.post(
  '/start',
  asyncHandler(async (_req, res) => {
    startWorldEngine();
    res.json({ running: true });
  }),
);

router.post(
  '/stop',
  asyncHandler(async (_req, res) => {
    stopWorldEngine();
    res.json({ running: false });
  }),
);

export default router;

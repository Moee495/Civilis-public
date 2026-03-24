import { getPool, withTransaction } from '../db/postgres.js';
import { getCurrentEconomyParams, getCurrentEconomyPhase } from '../economy/economy-regulator.js';
import { eventBus } from '../realtime.js';
import { getMarketCondition, type MarketCondition } from './market-oracle.js';
import { isWorldSignalEngineEnabled } from './config.js';
import { pushMainnetEpochStartTickParam } from '../config/mainnet-epoch.js';

type SignalType = 'macro' | 'social' | 'market';

interface WorldSignalRow {
  id: number;
  tick_number: number;
  signal_type: SignalType;
  signal_key: string;
  signal_value: string | null;
  payload: Record<string, unknown>;
  source: string;
  created_at: string;
}

export interface WorldSignalSnapshot {
  tickNumber: number;
  worldRegime: string;
  macro: Record<string, unknown>;
  social: Record<string, unknown>;
  externalMarket: MarketCondition | null;
  signalRefs: number[];
  createdAt: string;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSnapshot(rows: WorldSignalRow[]): WorldSignalSnapshot | null {
  if (rows.length === 0) {
    return null;
  }

  const tickNumber = rows[0].tick_number;
  const macro = rows.find((row) => row.signal_type === 'macro')?.payload ?? {};
  const social = rows.find((row) => row.signal_type === 'social')?.payload ?? {};
  const externalMarket = (rows.find((row) => row.signal_type === 'market')?.payload ?? null) as MarketCondition | null;
  const worldRegime = String((macro as { economyPhase?: string }).economyPhase ?? 'stable');

  return {
    tickNumber,
    worldRegime,
    macro,
    social,
    externalMarket,
    signalRefs: rows.map((row) => row.id),
    createdAt: rows[0].created_at,
  };
}

export async function collectWorldSignals(tick: number): Promise<WorldSignalSnapshot | null> {
  if (!isWorldSignalEngineEnabled()) {
    return null;
  }

  const pool = getPool();
  const [agentSummary, trustSummary, activitySummary, marketCondition] = await Promise.all([
    pool.query<{
      alive_agents: string;
      dead_agents: string;
      total_alive_balance: string;
      avg_alive_balance: string;
      richest_balance: string;
      avg_risk_tolerance: string;
      avg_reputation_score: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE is_alive = true) AS alive_agents,
         COUNT(*) FILTER (WHERE is_alive = false) AS dead_agents,
         COALESCE(SUM(balance) FILTER (WHERE is_alive = true), 0) AS total_alive_balance,
         COALESCE(AVG(balance) FILTER (WHERE is_alive = true), 0) AS avg_alive_balance,
         COALESCE(MAX(balance) FILTER (WHERE is_alive = true), 0) AS richest_balance,
         COALESCE(AVG(risk_tolerance) FILTER (WHERE is_alive = true), 0) AS avg_risk_tolerance,
         COALESCE(AVG(reputation_score) FILTER (WHERE is_alive = true), 0) AS avg_reputation_score
       FROM agents`,
    ),
    pool.query<{ avg_trust_score: string; relation_count: string }>(
      `SELECT
         COALESCE(AVG(trust_score), 0) AS avg_trust_score,
         COUNT(*) AS relation_count
       FROM trust_relations`,
    ),
    pool.query<{
      active_matches: string;
      posts_today: string;
      x402_transactions_today: string;
      recent_world_events: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM arena_matches WHERE status <> 'settled') AS active_matches,
         (SELECT COUNT(*) FROM posts WHERE created_at >= CURRENT_DATE) AS posts_today,
         (SELECT COUNT(*) FROM x402_transactions WHERE created_at >= CURRENT_DATE) AS x402_transactions_today,
         (SELECT COUNT(*) FROM world_events WHERE tick_number >= GREATEST($1 - 10, 0)) AS recent_world_events`,
      [tick],
    ),
    getMarketCondition().catch(() => null),
  ]);

  const params = getCurrentEconomyParams();
  const macroPayload = {
    aliveAgents: Number(agentSummary.rows[0]?.alive_agents ?? 0),
    deadAgents: Number(agentSummary.rows[0]?.dead_agents ?? 0),
    totalAliveBalance: Number(agentSummary.rows[0]?.total_alive_balance ?? 0),
    averageAliveBalance: Number(agentSummary.rows[0]?.avg_alive_balance ?? 0),
    richestBalance: Number(agentSummary.rows[0]?.richest_balance ?? 0),
    averageRiskTolerance: Number(agentSummary.rows[0]?.avg_risk_tolerance ?? 0),
    averageReputationScore: Number(agentSummary.rows[0]?.avg_reputation_score ?? 0),
    economyPhase: getCurrentEconomyPhase(),
    targetBalancePerAgent: params.targetBalancePerAgent,
    pgBaseInjection: params.pgBaseInjection,
    pdTreasuryCut: params.pdTreasuryCut,
    ppTreasuryCut: params.ppTreasuryCut,
  };

  const socialPayload = {
    activeMatches: Number(activitySummary.rows[0]?.active_matches ?? 0),
    postsToday: Number(activitySummary.rows[0]?.posts_today ?? 0),
    x402TransactionsToday: Number(activitySummary.rows[0]?.x402_transactions_today ?? 0),
    recentWorldEvents: Number(activitySummary.rows[0]?.recent_world_events ?? 0),
    averageTrustScore: Number(trustSummary.rows[0]?.avg_trust_score ?? 0),
    trustRelationCount: Number(trustSummary.rows[0]?.relation_count ?? 0),
  };

  const signalInputs: Array<{
    signalType: SignalType;
    signalKey: string;
    signalValue: number | null;
    payload: Record<string, unknown>;
  }> = [
    {
      signalType: 'macro',
      signalKey: 'economy_state',
      signalValue: toNumber(macroPayload.totalAliveBalance as number),
      payload: macroPayload,
    },
    {
      signalType: 'social',
      signalKey: 'network_state',
      signalValue: toNumber(socialPayload.activeMatches as number),
      payload: socialPayload,
    },
  ];

  if (marketCondition) {
    signalInputs.push({
      signalType: 'market',
      signalKey: 'external_market',
      signalValue: marketCondition.btcChange,
      payload: marketCondition as unknown as Record<string, unknown>,
    });
  }

  const rows = await withTransaction(async (client) => {
    const inserted: WorldSignalRow[] = [];
    for (const input of signalInputs) {
      const result = await client.query<WorldSignalRow>(
        `INSERT INTO world_signals
          (tick_number, signal_type, signal_key, signal_value, payload, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tick_number, signal_type, signal_key)
         DO UPDATE SET
           signal_value = EXCLUDED.signal_value,
           payload = EXCLUDED.payload,
           source = EXCLUDED.source
         RETURNING id, tick_number, signal_type, signal_key, signal_value, payload, source, created_at`,
        [
          tick,
          input.signalType,
          input.signalKey,
          input.signalValue,
          JSON.stringify(input.payload),
          'tick_engine',
        ],
      );
      inserted.push(result.rows[0]);
    }
    return inserted;
  });

  const snapshot = buildSnapshot(rows);
  if (snapshot) {
    eventBus.emit('world_signal', {
      tickNumber: snapshot.tickNumber,
      worldRegime: snapshot.worldRegime,
      signalCount: snapshot.signalRefs.length,
      hasExternalMarket: Boolean(snapshot.externalMarket),
    });
  }

  return snapshot;
}

export async function getLatestWorldSignalSnapshot(): Promise<WorldSignalSnapshot | null> {
  const pool = getPool();
  const params: Array<string | number> = [];
  const tickPlaceholder = pushMainnetEpochStartTickParam(params);
  const tickWhere = tickPlaceholder ? `WHERE tick_number >= ${tickPlaceholder}` : '';
  const result = await pool.query<WorldSignalRow>(
    `SELECT id, tick_number, signal_type, signal_key, signal_value, payload, source, created_at
     FROM world_signals
     WHERE tick_number = (SELECT MAX(tick_number) FROM world_signals ${tickWhere})
     ORDER BY signal_type, signal_key`,
    params,
  );
  return buildSnapshot(result.rows);
}

export async function listRecentWorldSignals(limit: number = 30): Promise<WorldSignalRow[]> {
  const pool = getPool();
  const params: Array<string | number> = [];
  const tickPlaceholder = pushMainnetEpochStartTickParam(params);
  const where = tickPlaceholder ? `WHERE tick_number >= ${tickPlaceholder}` : '';
  params.push(limit);
  const result = await pool.query<WorldSignalRow>(
    `SELECT id, tick_number, signal_type, signal_key, signal_value, payload, source, created_at
     FROM world_signals
     ${where}
     ORDER BY tick_number DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

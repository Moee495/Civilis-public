/**
 * ERC-8183 ACP API Routes — Query ACP jobs and ERC-8004 reputation
 */

import { Router, type Router as RouterType } from 'express';
import { getACPClient } from './acp-client.js';
import { reputationRegistry } from '../erc8004/reputation-registry.js';
import { validationRegistry } from '../erc8004/validation-registry.js';
import { getERC8004ServerAlignmentStatus } from '../standards/erc8004.js';
import { getCivilisCommerceProtocolState } from '../standards/civilis-commerce.js';
import { getPool } from '../db/postgres.js';
import { okxPaymentsClient } from '../onchainos/okx-payments.js';
import { okxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import {
  appendMainnetEpochCreatedAtFilter,
  getMainnetEpochMeta,
} from '../config/mainnet-epoch.js';
import {
  getX402PaymentMode,
  getXLayerChainId,
  getXLayerNetwork,
  isX402DirectWalletMode,
} from '../config/xlayer.js';

const router: RouterType = Router();

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function isRecordOnlyMetadata(metadata: Record<string, unknown>): boolean {
  const raw = metadata.recordOnly;
  return raw === true || raw === 'true';
}

function toACPJobView(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = parseMetadata(row.metadata);
  const recordOnly = isRecordOnlyMetadata(metadata);
  const budget = Number(row.budget ?? 0);
  const valueBacked = !recordOnly && Number.isFinite(budget) && budget > 0;
  return {
    ...row,
    metadata,
    recordOnly,
    valueBacked,
    protocolLayers: {
      localLedger: {
        recordLayer: 'local_cache',
        status: row.status,
      },
      escrow8183: {
        protocolVersion: metadata.onChainProtocolVersion ?? null,
        addressSource: metadata.onChainAddressSource ?? null,
        paymentToken: metadata.onChainPaymentToken ?? null,
        budgetUnits: metadata.onChainBudgetUnits ?? null,
        onChainTxHash: row.on_chain_tx_hash ?? null,
        syncState: row.on_chain_tx_hash ? 'mixed' : 'local_only',
        recordOnly,
        valueBacked,
      },
    },
  };
}

/* ── ACP Job Endpoints ── */

/** GET /api/acp/stats — Overall ACP commerce statistics */
router.get('/stats', async (_req, res) => {
  try {
    const acpStatsParams: Array<string | number> = [];
    const acpStatsWhere: string[] = ['1=1'];
    appendMainnetEpochCreatedAtFilter(acpStatsWhere, acpStatsParams, 'created_at');
    const acpStatsWhereClause = acpStatsWhere.join(' AND ');
    const [stats, protocol, reputationQueueSize] = await Promise.all([
      Promise.all([
        getPool().query<{ status: string; count: string }>(
          `SELECT status, COUNT(*) as count
           FROM acp_jobs
           WHERE ${acpStatsWhereClause}
           GROUP BY status`,
          acpStatsParams,
        ),
        getPool().query<{ category: string; count: string }>(
          `SELECT category, COUNT(*) as count
           FROM acp_jobs
           WHERE ${acpStatsWhereClause}
           GROUP BY category`,
          acpStatsParams,
        ),
        getPool().query<{
          total: string;
          volume: string;
          completed_count: string;
          completed_volume: string;
          active_count: string;
          terminal_count: string;
          value_backed_count: string;
          value_backed_volume: string;
          record_only_count: string;
        }>(
          `SELECT
             COUNT(*) as total,
             COALESCE(SUM(budget),0) as volume,
             COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
             COALESCE(SUM(budget) FILTER (WHERE status = 'completed'), 0) as completed_volume,
             COUNT(*) FILTER (WHERE status IN ('open', 'funded', 'submitted')) as active_count,
             COUNT(*) FILTER (WHERE status IN ('completed', 'rejected', 'expired')) as terminal_count,
             COUNT(*) FILTER (
               WHERE COALESCE(metadata->>'recordOnly', 'false') <> 'true'
                 AND budget > 0
             ) as value_backed_count,
             COALESCE(SUM(budget) FILTER (
               WHERE COALESCE(metadata->>'recordOnly', 'false') <> 'true'
                 AND budget > 0
             ), 0) as value_backed_volume,
             COUNT(*) FILTER (
               WHERE COALESCE(metadata->>'recordOnly', 'false') = 'true'
             ) as record_only_count
           FROM acp_jobs
           WHERE ${acpStatsWhereClause}`,
          acpStatsParams,
        ),
        getPool().query<{ category: string; value_backed_count: string; record_only_count: string }>(
          `SELECT
             category,
             COUNT(*) FILTER (
               WHERE COALESCE(metadata->>'recordOnly', 'false') <> 'true'
                 AND budget > 0
             ) as value_backed_count,
             COUNT(*) FILTER (
               WHERE COALESCE(metadata->>'recordOnly', 'false') = 'true'
             ) as record_only_count
           FROM acp_jobs
           WHERE ${acpStatsWhereClause}
           GROUP BY category`,
          acpStatsParams,
        ),
        getPool().query<{ arena_type: string; count: string }>(
          `SELECT
             COALESCE(metadata->>'type', 'unknown') as arena_type,
             COUNT(*) as count
           FROM acp_jobs
           WHERE ${acpStatsWhereClause}
             AND category = 'arena_match'
           GROUP BY COALESCE(metadata->>'type', 'unknown')`,
          acpStatsParams,
        ),
      ]),
      getACPClient().getProtocolDescriptor(),
      reputationRegistry.getPendingFeedbackCount(),
    ]);
    const [statusR, catR, overallR, categoryBreakdownR, arenaSubtypeR] = stats;
    const byStatus: Record<string, number> = {};
    for (const row of statusR.rows) {
      byStatus[row.status] = Number(row.count);
    }
    const byCategory: Record<string, number> = {};
    for (const row of catR.rows) {
      byCategory[row.category] = Number(row.count);
    }
    const valueBackedByCategory: Record<string, number> = {};
    const recordOnlyByCategory: Record<string, number> = {};
    for (const row of categoryBreakdownR.rows) {
      const valueCount = Number(row.value_backed_count ?? 0);
      const recordCount = Number(row.record_only_count ?? 0);
      if (valueCount > 0) valueBackedByCategory[row.category] = valueCount;
      if (recordCount > 0) recordOnlyByCategory[row.category] = recordCount;
    }
    const arenaSubtypeCounts: Record<string, number> = {};
    for (const row of arenaSubtypeR.rows) {
      arenaSubtypeCounts[row.arena_type] = Number(row.count ?? 0);
    }
    const overallStats = overallR.rows[0];

    const onChainR = await getPool().query<{
      count: string;
      volume: string;
      value_backed_count: string;
      value_backed_volume: string;
      record_only_count: string;
    }>(
      `SELECT
         COUNT(*) as count,
         COALESCE(SUM(budget),0) as volume,
         COUNT(*) FILTER (
           WHERE COALESCE(metadata->>'recordOnly', 'false') <> 'true'
             AND budget > 0
         ) as value_backed_count,
         COALESCE(SUM(budget) FILTER (
           WHERE COALESCE(metadata->>'recordOnly', 'false') <> 'true'
             AND budget > 0
         ), 0) as value_backed_volume,
         COUNT(*) FILTER (
           WHERE COALESCE(metadata->>'recordOnly', 'false') = 'true'
         ) as record_only_count
       FROM acp_jobs
       WHERE on_chain_tx_hash IS NOT NULL
         AND ${acpStatsWhereClause}`,
      acpStatsParams,
    );

    res.json({
      localLedger: {
        total: Number(overallStats?.total ?? 0),
        byStatus,
        byCategory,
        totalVolume: Number(overallStats?.volume ?? 0),
        completedCount: Number(overallStats?.completed_count ?? 0),
        completedVolume: Number(overallStats?.completed_volume ?? 0),
        activeCount: Number(overallStats?.active_count ?? 0),
        terminalCount: Number(overallStats?.terminal_count ?? 0),
        valueBackedCount: Number(overallStats?.value_backed_count ?? 0),
        valueBackedVolume: Number(overallStats?.value_backed_volume ?? 0),
        valueBackedByCategory,
        recordOnlyCount: Number(overallStats?.record_only_count ?? 0),
        recordOnlyByCategory,
        arenaSubtypeCounts,
      },
      onChainSync: {
        jobCount: Number(onChainR.rows[0]?.count ?? 0),
        volume: Number(onChainR.rows[0]?.volume ?? 0),
        valueBackedJobCount: Number(onChainR.rows[0]?.value_backed_count ?? 0),
        valueBackedVolume: Number(onChainR.rows[0]?.value_backed_volume ?? 0),
        recordOnlyJobCount: Number(onChainR.rows[0]?.record_only_count ?? 0),
      },
      epoch: getMainnetEpochMeta(),
      protocolLayers: {
        escrow8183: protocol,
        trust8004: getERC8004ServerAlignmentStatus(),
        commerceMapping: getCivilisCommerceProtocolState(),
        x402Rail: {
          configured: okxPaymentsClient.isConfigured(),
          paymentMode: getX402PaymentMode(),
          network: `${getXLayerNetwork()}:${getXLayerChainId()}`,
          directWalletMode: isX402DirectWalletMode(),
        },
      },
      queues: {
        pendingReputationFeedback: reputationQueueSize,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ACP stats' });
  }
});

/** GET /api/acp/jobs — List recent ACP jobs */
router.get('/jobs', async (req, res) => {
  try {
    const { category, status, agent, limit, arenaType } = req.query;
    const pool = getPool();

    const where: string[] = ['1=1'];
    const params: Array<string | number> = [];
    let paramIdx = 1;
    appendMainnetEpochCreatedAtFilter(where, params, 'created_at');
    paramIdx = params.length + 1;

    if (category) {
      where.push(`category = $${paramIdx++}`);
      params.push(String(category));
    }
    if (status) {
      where.push(`status = $${paramIdx++}`);
      params.push(String(status));
    }
    if (agent) {
      where.push(`(client_agent_id = $${paramIdx} OR provider_agent_id = $${paramIdx})`);
      params.push(String(agent));
      paramIdx++;
    }
    if (arenaType) {
      where.push(`COALESCE(metadata->>'type', '') = $${paramIdx++}`);
      params.push(String(arenaType));
    }

    const whereClause = ` WHERE ${where.join(' AND ')}`;
    const listQuery = `SELECT * FROM acp_jobs${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx}`;
    const countQuery = `SELECT COUNT(*) as total FROM acp_jobs${whereClause}`;
    const listParams = [...params, Number(limit) || 50];

    const [result, countResult] = await Promise.all([
      pool.query(listQuery, listParams),
      pool.query<{ total: string }>(countQuery, params),
    ]);

    res.json({
      jobs: result.rows.map((row) => toACPJobView(row as Record<string, unknown>)),
      total: Number(countResult.rows[0]?.total ?? 0),
      epoch: getMainnetEpochMeta(),
      protocol: await getACPClient().getProtocolDescriptor(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ACP jobs' });
  }
});

/** GET /api/acp/jobs/:id — Single job detail */
router.get('/jobs/:id', async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM acp_jobs WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Job not found' });
    res.json(toACPJobView(result.rows[0] as Record<string, unknown>));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

/* ── ERC-8004 Reputation Endpoints ── */

/** GET /api/acp/reputation/:agentId — Agent reputation summary */
router.get('/reputation/:agentId', async (req, res) => {
  try {
    const pool = getPool();
    const agentR = await pool.query<{ erc8004_token_id: number }>(
      'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
      [req.params.agentId],
    );
    const tokenId = agentR.rows[0]?.erc8004_token_id;
    if (!tokenId) return res.status(404).json({ error: 'Agent not found or not registered' });

    const [overall, pd, commons, prediction, intel, history] = await Promise.all([
      reputationRegistry.getAgentReputationView(tokenId),
      reputationRegistry.getAgentReputationView(tokenId, [
        'pd_cooperation',
        'pd_betrayal',
        'arena_cooperate',
        'arena_betray',
        'arena_betrayed',
        'arena_defect',
      ]),
      reputationRegistry.getAgentReputationView(tokenId, ['commons_cooperation', 'commons_sabotage']),
      reputationRegistry.getAgentReputationView(tokenId, ['prediction_accuracy', 'prediction_miss']),
      reputationRegistry.getAgentReputationView(tokenId, ['intel_accuracy', 'intel_fraud']),
      reputationRegistry.getAgentFeedbackHistory(tokenId, 20),
    ]);

    res.json({
      agentId: req.params.agentId,
      erc8004TokenId: tokenId,
      protocol: getERC8004ServerAlignmentStatus().reputation,
      overall,
      breakdown: { pd, commons, prediction, intel },
      recentFeedback: history,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reputation' });
  }
});

/** GET /api/acp/erc8004/overview — Unified ERC-8004 overview for product surfaces */
router.get('/erc8004/overview', async (_req, res) => {
  try {
    const pool = getPool();

    const [agentsR, feedbackStatsR, validationStatsR] = await Promise.all([
      pool.query<{
        agent_id: string;
        name: string;
        archetype: string;
        erc8004_token_id: number | null;
        reputation_score: number;
        is_alive: boolean;
      }>(
        `SELECT agent_id, name, archetype, erc8004_token_id, reputation_score, is_alive
         FROM agents
         ORDER BY erc8004_token_id NULLS LAST, created_at ASC`,
      ),
      pool.query<{ total_feedback: string; pending_feedback: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE NOT is_revoked) as total_feedback,
           COUNT(*) FILTER (WHERE NOT is_revoked AND on_chain_tx_hash IS NULL) as pending_feedback
         FROM erc8004_feedback`,
      ),
      pool.query<{ total_validations: string; responded_validations: string }>(
        `SELECT
           COUNT(*) as total_validations,
           COUNT(*) FILTER (WHERE response_tx_hash IS NOT NULL) as responded_validations
         FROM erc8004_validations`,
      ),
    ]);

    const registeredAgents = agentsR.rows.filter((agent) => agent.erc8004_token_id);

    const agentRows: Array<Record<string, unknown>> = [];
    for (const agent of registeredAgents) {
      const tokenId = agent.erc8004_token_id!;
      const [reputation, validations] = await Promise.all([
        reputationRegistry.getAgentReputationView(tokenId),
        validationRegistry.getProducerValidationView(tokenId),
      ]);

      agentRows.push({
        ...agent,
        protocolLayers: {
          reputation,
          validation: validations,
        },
      });
    }

    res.json({
      protocol: getERC8004ServerAlignmentStatus(),
      totals: {
        totalAgents: agentsR.rows.length,
        registeredAgents: registeredAgents.length,
        totalFeedback: Number(feedbackStatsR.rows[0]?.total_feedback ?? 0),
        pendingFeedback: Number(feedbackStatsR.rows[0]?.pending_feedback ?? 0),
        totalValidations: Number(validationStatsR.rows[0]?.total_validations ?? 0),
        respondedValidations: Number(validationStatsR.rows[0]?.responded_validations ?? 0),
      },
      agents: agentRows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ERC-8004 overview' });
  }
});

/** GET /api/acp/reputation/:agentId/history — Full feedback history */
router.get('/reputation/:agentId/history', async (req, res) => {
  try {
    const pool = getPool();
    const agentR = await pool.query<{ erc8004_token_id: number }>(
      'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
      [req.params.agentId],
    );
    const tokenId = agentR.rows[0]?.erc8004_token_id;
    if (!tokenId) return res.status(404).json({ error: 'Agent not found' });

    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const history = await reputationRegistry.getAgentFeedbackHistory(tokenId, limit);

    res.json({
      agentId: req.params.agentId,
      erc8004TokenId: tokenId,
      protocol: getERC8004ServerAlignmentStatus().reputation,
      feedback: history,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feedback history' });
  }
});

/* ── ERC-8004 Validation Endpoints ── */

/** GET /api/acp/validations/:agentId — Agent's intel validation summary */
router.get('/validations/:agentId', async (req, res) => {
  try {
    const pool = getPool();
    const agentR = await pool.query<{ erc8004_token_id: number }>(
      'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
      [req.params.agentId],
    );
    const tokenId = agentR.rows[0]?.erc8004_token_id;
    if (!tokenId) return res.status(404).json({ error: 'Agent not found' });

    const summary = await validationRegistry.getProducerValidationView(tokenId);

    res.json({
      agentId: req.params.agentId,
      erc8004TokenId: tokenId,
      protocol: getERC8004ServerAlignmentStatus().validation,
      validation: summary,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch validations' });
  }
});

/* ── X402 Payment Analytics Endpoints ── */

/** GET /api/acp/x402/stats — Comprehensive X402 payment analytics */
router.get('/x402/stats', async (_req, res) => {
  try {
    const pool = getPool();
    const params: Array<string | number> = [];
    const x402Where: string[] = ['1=1'];
    appendMainnetEpochCreatedAtFilter(x402Where, params, 'created_at');
    const x402WhereClause = x402Where.join(' AND ');
    const recentWhereClause = x402Where
      .map((fragment) => (fragment === '1=1' ? fragment : `t.${fragment}`))
      .join(' AND ');
    const txWindowParams = [...params];
    txWindowParams.push(24);

    const [
      overallR, byTypeR, byHourR, topSendersR, topReceiversR,
      recentR, dailyVolumeR, avgTxR, treasuryR, agentFlowR, lifecycleR,
    ] = await Promise.all([
      // Overall totals
      pool.query<{ total_txns: string; total_volume: string; unique_senders: string; unique_receivers: string; first_tx: string; last_tx: string }>(`
        SELECT
          COUNT(*) as total_txns,
          COALESCE(SUM(amount), 0) as total_volume,
          COUNT(DISTINCT from_agent_id) as unique_senders,
          COUNT(DISTINCT to_agent_id) as unique_receivers,
          MIN(created_at) as first_tx,
          MAX(created_at) as last_tx
        FROM x402_transactions
        WHERE ${x402WhereClause}
      `, params),
      // By transaction type (with avg amount)
      pool.query<{ tx_type: string; count: string; volume: string; avg_amount: string; min_amount: string; max_amount: string }>(`
        SELECT
          tx_type,
          COUNT(*) as count,
          COALESCE(SUM(amount), 0) as volume,
          COALESCE(AVG(amount), 0) as avg_amount,
          COALESCE(MIN(amount), 0) as min_amount,
          COALESCE(MAX(amount), 0) as max_amount
        FROM x402_transactions
        WHERE ${x402WhereClause}
        GROUP BY tx_type
        ORDER BY volume DESC
      `, params),
      // Volume by hour (last 24h)
      pool.query<{ hour: string; count: string; volume: string }>(`
        SELECT
          DATE_TRUNC('hour', created_at) as hour,
          COUNT(*) as count,
          COALESCE(SUM(amount), 0) as volume
        FROM x402_transactions
        WHERE ${x402WhereClause}
          AND created_at > NOW() - ($${params.length + 1}::int * INTERVAL '1 hour')
        GROUP BY DATE_TRUNC('hour', created_at)
        ORDER BY hour
      `, txWindowParams),
      // Top 8 senders by volume
      pool.query<{ agent_id: string; name: string; archetype: string; tx_count: string; total_sent: string }>(`
        SELECT
          a.agent_id, a.name, a.archetype,
          COUNT(*) as tx_count,
          COALESCE(SUM(t.amount), 0) as total_sent
        FROM x402_transactions t
        JOIN agents a ON a.agent_id = t.from_agent_id
        WHERE ${recentWhereClause}
        GROUP BY a.agent_id, a.name, a.archetype
        ORDER BY total_sent DESC
        LIMIT 8
      `, params),
      // Top 8 receivers by volume
      pool.query<{ agent_id: string; name: string; archetype: string; tx_count: string; total_received: string }>(`
        SELECT
          a.agent_id, a.name, a.archetype,
          COUNT(*) as tx_count,
          COALESCE(SUM(t.amount), 0) as total_received
        FROM x402_transactions t
        JOIN agents a ON a.agent_id = t.to_agent_id
        WHERE ${recentWhereClause}
        GROUP BY a.agent_id, a.name, a.archetype
        ORDER BY total_received DESC
        LIMIT 8
      `, params),
      // Recent 20 transactions
      pool.query<{
        id: number;
        tx_type: string;
        from_agent_id: string | null;
        to_agent_id: string | null;
        amount: string;
        tx_hash: string | null;
        metadata: Record<string, unknown> | null;
        created_at: string;
        onchain_status: string | null;
        onchain_attempts: number | null;
        onchain_payment_id: string | null;
        onchain_error: string | null;
        settlement_status: string | null;
        settlement_created_at: string | null;
        settlement_confirmed_at: string | null;
        proof_provider: string | null;
        proof_verified_at: string | null;
        proof_settled_at: string | null;
        proof_payer_address: string | null;
        proof_payee_address: string | null;
      }>(`
        SELECT
          t.id,
          t.tx_type,
          t.from_agent_id,
          t.to_agent_id,
          t.amount,
          COALESCE(cs.tx_hash, t.tx_hash) as tx_hash,
          t.metadata,
          t.created_at,
          t.onchain_status,
          t.onchain_attempts,
          t.onchain_payment_id,
          t.onchain_error,
          cs.status as settlement_status,
          cs.created_at as settlement_created_at,
          cs.confirmed_at as settlement_confirmed_at,
          t.proof_provider,
          t.proof_verified_at,
          t.proof_settled_at,
          t.proof_payer_address,
          t.proof_payee_address
        FROM x402_transactions t
        LEFT JOIN LATERAL (
          SELECT cs.tx_hash, cs.status, cs.created_at, cs.confirmed_at
          FROM chain_settlements cs
          WHERE cs.reference_table = 'x402_transactions'
            AND (
              cs.reference_id = t.id
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(COALESCE(cs.metadata->'payments', '[]'::jsonb)) AS payment
                WHERE NULLIF(payment->>'txId', '')::int = t.id
              )
            )
          ORDER BY cs.id DESC
          LIMIT 1
        ) cs ON true
        WHERE ${recentWhereClause}
        ORDER BY t.created_at DESC
        LIMIT 20
      `, params),
      // Daily volume (last 7 days)
      pool.query<{ day: string; count: string; volume: string }>(`
        SELECT
          DATE_TRUNC('day', created_at) as day,
          COUNT(*) as count,
          COALESCE(SUM(amount), 0) as volume
        FROM x402_transactions
        WHERE ${x402WhereClause}
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day
      `, params),
      // Average transaction size by type
      pool.query<{ tx_type: string; avg_size: string; median_approx: string }>(`
        SELECT
          tx_type,
          COALESCE(AVG(amount), 0) as avg_size,
          COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount), 0) as median_approx
        FROM x402_transactions
        WHERE ${x402WhereClause}
        GROUP BY tx_type
        ORDER BY avg_size DESC
      `, params),
      // Treasury flows (in vs out)
      pool.query<{ direction: string; count: string; volume: string }>(`
        SELECT 'inflow' as direction, COUNT(*) as count, COALESCE(SUM(amount), 0) as volume
        FROM x402_transactions WHERE to_agent_id IS NULL AND ${x402WhereClause}
        UNION ALL
        SELECT 'outflow' as direction, COUNT(*) as count, COALESCE(SUM(amount), 0) as volume
        FROM x402_transactions WHERE from_agent_id IS NULL AND ${x402WhereClause}
      `, params),
      // Agent net flow (earned - spent)
      pool.query<{ agent_id: string; name: string; archetype: string; total_earned: string; total_spent: string; net_flow: string }>(`
        WITH earned AS (
          SELECT to_agent_id as agent_id, COALESCE(SUM(amount), 0) as total
          FROM x402_transactions WHERE to_agent_id IS NOT NULL AND ${x402WhereClause}
          GROUP BY to_agent_id
        ),
        spent AS (
          SELECT from_agent_id as agent_id, COALESCE(SUM(amount), 0) as total
          FROM x402_transactions WHERE from_agent_id IS NOT NULL AND ${x402WhereClause}
          GROUP BY from_agent_id
        )
        SELECT
          a.agent_id, a.name, a.archetype,
          COALESCE(e.total, 0) as total_earned,
          COALESCE(s.total, 0) as total_spent,
          COALESCE(e.total, 0) - COALESCE(s.total, 0) as net_flow
        FROM agents a
        LEFT JOIN earned e ON e.agent_id = a.agent_id
        LEFT JOIN spent s ON s.agent_id = a.agent_id
        WHERE a.is_alive = true
        ORDER BY net_flow DESC
      `, params),
      pool.query<{ onchain_status: string | null; count: string; volume: string }>(`
        SELECT
          COALESCE(onchain_status, 'local_confirmed') as onchain_status,
          COUNT(*) as count,
          COALESCE(SUM(amount), 0) as volume
        FROM x402_transactions
        WHERE ${x402WhereClause}
        GROUP BY COALESCE(onchain_status, 'local_confirmed')
      `, params),
    ]);

    const overall = overallR.rows[0];
    const treasuryFlows: Record<string, { count: number; volume: number }> = {};
    for (const r of treasuryR.rows) {
      treasuryFlows[r.direction] = { count: Number(r.count), volume: Number(r.volume) };
    }
    const lifecycle: Record<string, { count: number; volume: number }> = {};
    for (const row of lifecycleR.rows) {
      lifecycle[row.onchain_status ?? 'local_confirmed'] = {
        count: Number(row.count),
        volume: Number(row.volume),
      };
    }

    const explorerBase = getXLayerNetwork() === 'mainnet'
      ? 'https://web3.okx.com/zh-hans/explorer/x-layer/tx/'
      : 'https://web3.okx.com/zh-hans/explorer/x-layer-testnet/tx/';

    res.json({
      overview: {
        totalTransactions: Number(overall?.total_txns ?? 0),
        totalVolume: Number(overall?.total_volume ?? 0),
        uniqueSenders: Number(overall?.unique_senders ?? 0),
        uniqueReceivers: Number(overall?.unique_receivers ?? 0),
        firstTransaction: overall?.first_tx ?? null,
        lastTransaction: overall?.last_tx ?? null,
        averageTxSize: Number(overall?.total_txns) > 0
          ? Number(overall.total_volume) / Number(overall.total_txns)
          : 0,
      },
      byType: byTypeR.rows.map(r => ({
        txType: r.tx_type,
        count: Number(r.count),
        volume: Number(r.volume),
        avgAmount: Number(Number(r.avg_amount).toFixed(6)),
        minAmount: Number(Number(r.min_amount).toFixed(6)),
        maxAmount: Number(Number(r.max_amount).toFixed(6)),
      })),
      hourlyVolume: byHourR.rows.map(r => ({
        hour: r.hour,
        count: Number(r.count),
        volume: Number(r.volume),
      })),
      dailyVolume: dailyVolumeR.rows.map(r => ({
        day: r.day,
        count: Number(r.count),
        volume: Number(r.volume),
      })),
      lifecycle,
      official: {
        configured: okxPaymentsClient.isConfigured(),
        network: `${getXLayerNetwork()}:${getXLayerChainId()}`,
        paymentMode: getX402PaymentMode(),
        directWalletMode: isX402DirectWalletMode(),
        targetNetwork: 'mainnet:196',
        targetPaymentMode: 'direct_wallet',
        directWalletRequiresMainnet: true,
        directWalletSemantics:
          getXLayerNetwork() === 'mainnet' &&
          isX402DirectWalletMode() &&
          okxPaymentsClient.isConfigured() &&
          okxTeeWallet.isConfigured()
          ? 'proof_first'
          : 'transition_contract_call',
        recommendedOkxSkills: [
          'okx-agentic-wallet',
          'okx-x402-payment',
          'okx-onchain-gateway',
          'okx-dex-market',
          'okx-security',
        ],
      },
      epoch: getMainnetEpochMeta(),
      topSenders: topSendersR.rows.map(r => ({
        agentId: r.agent_id,
        name: r.name,
        archetype: r.archetype,
        txCount: Number(r.tx_count),
        totalSent: Number(r.total_sent),
      })),
      topReceivers: topReceiversR.rows.map(r => ({
        agentId: r.agent_id,
        name: r.name,
        archetype: r.archetype,
        txCount: Number(r.tx_count),
        totalReceived: Number(r.total_received),
      })),
      treasuryFlows,
      agentNetFlow: agentFlowR.rows.map(r => ({
        agentId: r.agent_id,
        name: r.name,
        archetype: r.archetype,
        totalEarned: Number(r.total_earned),
        totalSpent: Number(r.total_spent),
        netFlow: Number(r.net_flow),
      })),
      avgByType: avgTxR.rows.map(r => ({
        txType: r.tx_type,
        avgSize: Number(Number(r.avg_size).toFixed(6)),
        medianSize: Number(Number(r.median_approx).toFixed(6)),
      })),
      recentTransactions: recentR.rows.map(r => ({
        id: r.id,
        txType: r.tx_type,
        from: r.from_agent_id,
        to: r.to_agent_id,
        amount: Number(r.amount),
        txHash: r.tx_hash,
        metadata: r.metadata,
        createdAt: r.created_at,
        onchainStatus: r.onchain_status ?? 'local_confirmed',
        onchainAttempts: Number(r.onchain_attempts ?? 0),
        onchainPaymentId: r.onchain_payment_id ? Number(r.onchain_payment_id) : null,
        onchainError: r.onchain_error,
        settlementStatus: r.settlement_status,
        settlementCreatedAt: r.settlement_created_at,
        confirmedAt: r.settlement_confirmed_at,
        proofProvider: r.proof_provider,
        proofVerifiedAt: r.proof_verified_at,
        proofSettledAt: r.proof_settled_at,
        proofPayerAddress: r.proof_payer_address,
        proofPayeeAddress: r.proof_payee_address,
        explorerUrl: r.tx_hash ? `${explorerBase}${r.tx_hash}` : null,
      })),
    });
  } catch (err) {
    console.error('[X402] stats query failed:', err);
    res.status(500).json({ error: 'Failed to fetch X402 stats' });
  }
});

router.get('/x402/official/supported', async (_req, res) => {
  try {
    if (!okxPaymentsClient.isConfigured()) {
      res.json({
        configured: false,
        reachable: false,
        provider: 'okx_payments',
        error: 'Official OKX Payments credentials are not configured',
      });
      return;
    }

    const result = await okxPaymentsClient.getSupported();
    res.json({
      configured: true,
      reachable: true,
      provider: 'okx_payments',
      endpoint: result.endpoint,
      receivedAt: new Date().toISOString(),
      normalized: result.normalized,
      raw: result.payload,
    });
  } catch (err) {
    res.json({
      configured: okxPaymentsClient.isConfigured(),
      reachable: false,
      provider: 'okx_payments',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post('/x402/official/verify', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : null;
    if (!body) {
      res.status(400).json({ error: 'verify body is required' });
      return;
    }

    const result = await okxPaymentsClient.verify(body);
    res.json({
      configured: okxPaymentsClient.isConfigured(),
      provider: 'okx_payments',
      endpoint: result.endpoint,
      receivedAt: new Date().toISOString(),
      raw: result.payload,
    });
  } catch (err) {
    res.status(502).json({
      configured: okxPaymentsClient.isConfigured(),
      provider: 'okx_payments',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post('/x402/official/settle', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : null;
    if (!body) {
      res.status(400).json({ error: 'settle body is required' });
      return;
    }

    const result = await okxPaymentsClient.settle(body);
    res.json({
      configured: okxPaymentsClient.isConfigured(),
      provider: 'okx_payments',
      endpoint: result.endpoint,
      receivedAt: new Date().toISOString(),
      raw: result.payload,
    });
  } catch (err) {
    res.status(502).json({
      configured: okxPaymentsClient.isConfigured(),
      provider: 'okx_payments',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;

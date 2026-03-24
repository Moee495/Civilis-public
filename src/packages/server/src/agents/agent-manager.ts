import { Router } from 'express';
import { ethers } from 'ethers';
import {
  asyncHandler,
  NotFoundError,
  ValidationError,
} from '../middleware/errorHandler.js';
import { getPool } from '../db/postgres.js';
import { creditAgentOnchainBalance, deriveAgentAddress } from './wallet-sync.js';
import { okxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import { generateAgentCard, toAgentCardUri } from '../standards/agent-card.js';
import {
  getAgentOnchainReputationByAgentId,
  getERC8004ServerAlignmentStatus,
  registerAgentOnERC8004,
} from '../standards/erc8004.js';
import { generateFateCard } from '../fate/fate-engine.js';
import type { FateCard } from '../fate/fate-card.js';
import { buildTextMemoryContent, extractMemorySummary } from '../fate/memory-content.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { X402_PRICES } from '../x402/pricing.js';
import { initializeNurtureProfile } from '../nurture/nurture-updater.js';
import { getEvolutionState, getMechanicCooldowns } from '../social/social-effects.js';
import { createXLayerProvider, isStrictOnchainMode } from '../config/xlayer.js';
import { getSpyPrice } from '../intel/intel-phase-gate.js';
import { INTEL_PUBLIC_BUYER_THRESHOLD } from '../intel/intel-types.js';
import {
  appendMainnetEpochCreatedAtFilter,
  appendMainnetEpochTickFilter,
} from '../config/mainnet-epoch.js';

const router: Router = Router();

export interface RegisterAgentInput {
  id: string;
  name: string;
  archetype: string;
  riskTolerance: number;
  initialBalance: number;
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const input = normalizeRegisterInput(req.body);
    const result = await registerAgentRecord(input);
    res.status(201).json(result);
  }),
);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const agents = await pool.query(
      `SELECT *
       FROM agents
       ORDER BY is_alive DESC, balance DESC, reputation_score DESC`,
    );
    res.json(agents.rows);
  }),
);

router.get(
  '/leaderboard',
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const leaderboard = await pool.query(
      `SELECT
         a.agent_id,
         a.name,
         a.archetype,
         a.balance,
         a.reputation_score,
         a.is_alive,
         a.erc8004_token_id,
         a.soul_grade,
         f.mbti,
         f.civilization
       FROM agents a
       LEFT JOIN fate_cards f ON f.agent_id = a.agent_id
       ORDER BY a.balance DESC, a.reputation_score DESC`,
    );
    res.json(leaderboard.rows);
  }),
);

router.get(
  '/:id/memories',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 10, 100);
    const memories = await pool.query(
      `SELECT *
       FROM agent_memories
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.params.id, limit],
    );
    res.json(
      memories.rows.map((row) => ({
        ...row,
        content: extractMemorySummary(row.content),
      })),
    );
  }),
);

router.get(
  '/:id/decision-traces',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 20, 100);
    const traces = await pool.query(
      `SELECT *
       FROM agent_decision_traces
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.params.id, limit],
    );
    res.json(traces.rows);
  }),
);

router.post(
  '/:id/decision-traces',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const agentId = req.params.id;
    const scene = String(req.body.scene ?? '').trim();
    const action = String(req.body.action ?? '').trim();

    if (!scene || !action) {
      throw new ValidationError('scene and action are required');
    }

    await pool.query(
      `INSERT INTO agent_decision_traces (
         agent_id,
         tick_number,
         scene,
         action,
         target_ref,
         decision_source,
         content_source,
         reason_summary,
         template_content,
         final_content,
         llm_provider,
         llm_model,
         latency_ms,
         fallback_used,
         metadata
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
       )`,
      [
        agentId,
        Number(req.body.tickNumber ?? 0),
        scene,
        action,
        req.body.targetRef ? String(req.body.targetRef) : null,
        req.body.decisionSource ? String(req.body.decisionSource) : 'heuristic',
        req.body.contentSource ? String(req.body.contentSource) : 'none',
        req.body.reasonSummary ? String(req.body.reasonSummary).slice(0, 300) : null,
        req.body.templateContent ? String(req.body.templateContent).slice(0, 400) : null,
        req.body.finalContent ? String(req.body.finalContent).slice(0, 400) : null,
        req.body.llmProvider ? String(req.body.llmProvider) : null,
        req.body.llmModel ? String(req.body.llmModel) : null,
        req.body.latencyMs != null ? Number(req.body.latencyMs) : null,
        Boolean(req.body.fallbackUsed),
        req.body.metadata && typeof req.body.metadata === 'object' ? JSON.stringify(req.body.metadata) : JSON.stringify({}),
      ],
    );

    res.status(201).json({ success: true });
  }),
);

router.get(
  '/:id/trust',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const trust = await pool.query(
      `WITH ranked_relations AS (
         SELECT
           from_agent_id,
           to_agent_id,
           trust_score,
           interaction_count,
           last_interaction_at,
           updated_at,
           id,
           CASE
             WHEN from_agent_id = $1 THEN to_agent_id
             ELSE from_agent_id
           END AS counterparty_id,
           ROW_NUMBER() OVER (
             PARTITION BY CASE
               WHEN from_agent_id = $1 THEN to_agent_id
               ELSE from_agent_id
             END
             ORDER BY
               trust_score DESC,
               last_interaction_at DESC NULLS LAST,
               interaction_count DESC,
               updated_at DESC,
               id DESC
           ) AS rn
         FROM trust_relations
         WHERE from_agent_id = $1 OR to_agent_id = $1
       )
       SELECT from_agent_id, to_agent_id, trust_score, interaction_count, last_interaction_at
       FROM ranked_relations
       WHERE rn = 1
       ORDER BY trust_score DESC, last_interaction_at DESC NULLS LAST, interaction_count DESC`,
      [req.params.id],
    );
    res.json(trust.rows);
  }),
);

router.get(
  '/:id/transactions',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 50, 200);
    const params: Array<string | number> = [req.params.id];
    const where: string[] = ['(from_agent_id = $1 OR to_agent_id = $1)'];
    appendMainnetEpochCreatedAtFilter(where, params, 'created_at');
    params.push(limit);
    const transactions = await pool.query(
      `SELECT *
       FROM x402_transactions
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json(transactions.rows);
  }),
);

router.get(
  '/:id/commerce-summary',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const agentId = req.params.id;
    const limit = Math.min(req.query.limit ? Number(req.query.limit) : 20, 100);
    const cashflowParams: Array<string | number> = [agentId];
    const cashflowWhere: string[] = ['(from_agent_id = $1 OR to_agent_id = $1)'];
    appendMainnetEpochCreatedAtFilter(cashflowWhere, cashflowParams, 'created_at');
    const listingParams: Array<string | number> = [agentId];
    const listingWhere: string[] = ['il.seller_agent_id = $1'];
    appendMainnetEpochCreatedAtFilter(listingWhere, listingParams, 'il.created_at');
    const salesParams: Array<string | number> = [agentId];
    const salesWhere: string[] = ['i.producer_agent_id = $1'];
    appendMainnetEpochCreatedAtFilter(salesWhere, salesParams, 'ip.created_at');
    const activeIntelParams: Array<string | number> = [agentId, INTEL_PUBLIC_BUYER_THRESHOLD];
    const activeIntelWhere: string[] = [
      'producer_agent_id = $1',
      "status = 'active'",
      'is_public = false',
      'buyer_count < $2',
    ];
    appendMainnetEpochTickFilter(activeIntelWhere, activeIntelParams, 'created_at_tick');

    const [cashflowR, listingsR, intelSalesR, intelActiveR] = await Promise.all([
      pool.query<{ earned: string; spent: string }>(
        `SELECT
           COALESCE(SUM(CASE WHEN to_agent_id = $1 THEN amount ELSE 0 END), 0) AS earned,
           COALESCE(SUM(CASE WHEN from_agent_id = $1 THEN amount ELSE 0 END), 0) AS spent
         FROM x402_transactions
         WHERE ${cashflowWhere.join(' AND ')}`,
        cashflowParams,
      ),
      pool.query<{
        listing_id: number;
        subject_agent_id: string;
        subject_name: string;
        subject_archetype: string;
        dimension: string;
        price: string;
        status: string;
        buyer_agent_id: string | null;
        buyer_name: string | null;
        acp_job_local_id: number | null;
        acp_tx_hash: string | null;
        sale_x402_tx_hash: string | null;
        source_type: string | null;
        purchase_cost: string | null;
        created_at: string;
        sold_at: string | null;
      }>(
        `SELECT
           il.id AS listing_id,
           il.subject_agent_id,
           subj.name AS subject_name,
           subj.archetype AS subject_archetype,
           il.dimension,
           il.price,
           il.status,
           il.buyer_agent_id,
           buyer.name AS buyer_name,
           il.acp_job_local_id,
           aj.on_chain_tx_hash AS acp_tx_hash,
           il.sale_x402_tx_hash,
           ir.source_type,
           purchase_tx.amount AS purchase_cost,
           il.created_at,
           il.sold_at
         FROM intel_listings il
         JOIN agents subj ON subj.agent_id = il.subject_agent_id
         LEFT JOIN agents buyer ON buyer.agent_id = il.buyer_agent_id
         LEFT JOIN intel_records ir
           ON ir.subject_agent_id = il.subject_agent_id
          AND ir.dimension = il.dimension
          AND ir.knower_agent_id = il.seller_agent_id
         LEFT JOIN acp_jobs aj
           ON aj.id = il.acp_job_local_id
         LEFT JOIN LATERAL (
           SELECT tx.amount
           FROM x402_transactions tx
           WHERE tx.from_agent_id = il.seller_agent_id
             AND tx.tx_type = 'intel_purchase'
             AND COALESCE(tx.metadata->>'subjectAgentId', '') = il.subject_agent_id
             AND COALESCE(tx.metadata->>'dimension', '') = il.dimension
           ORDER BY tx.created_at DESC
            LIMIT 1
         ) purchase_tx ON true
         WHERE ${listingWhere.join(' AND ')}
         ORDER BY COALESCE(il.sold_at, il.created_at) DESC`,
        listingParams,
      ),
      pool.query<{
        sale_id: number;
        intel_item_id: number;
        subject_agent_id: string | null;
        subject_name: string | null;
        subject_archetype: string | null;
        dimension: string;
        sale_price: string;
        buyer_agent_id: string | null;
        buyer_name: string | null;
        acp_job_local_id: number | null;
        acp_tx_hash: string | null;
        sale_x402_tx_hash: string | null;
        created_at: string;
        sold_at: string;
      }>(
        `SELECT
           ip.id AS sale_id,
           i.id AS intel_item_id,
           i.subject_agent_id,
           subj.name AS subject_name,
           subj.archetype AS subject_archetype,
           i.category AS dimension,
           ip.price_paid AS sale_price,
           ip.buyer_agent_id,
           buyer.name AS buyer_name,
           aj.id AS acp_job_local_id,
           aj.on_chain_tx_hash AS acp_tx_hash,
           sale_tx.tx_hash AS sale_x402_tx_hash,
           i.created_at,
           ip.created_at AS sold_at
         FROM intel_purchases ip
         JOIN intel_items i ON i.id = ip.intel_item_id
         LEFT JOIN agents subj ON subj.agent_id = i.subject_agent_id
         LEFT JOIN agents buyer ON buyer.agent_id = ip.buyer_agent_id
         LEFT JOIN LATERAL (
           SELECT id, on_chain_tx_hash
           FROM acp_jobs aj
           WHERE COALESCE(aj.metadata->>'itemId', '') = i.id::text
             AND COALESCE(aj.metadata->>'buyerAgentId', '') = ip.buyer_agent_id
           ORDER BY aj.created_at DESC
           LIMIT 1
         ) aj ON true
         LEFT JOIN LATERAL (
           SELECT tx.tx_hash
           FROM x402_transactions tx
           WHERE COALESCE(tx.metadata->>'itemId', '') = i.id::text
             AND tx.from_agent_id = ip.buyer_agent_id
             AND tx.to_agent_id = i.producer_agent_id
             AND tx.tx_type IN ('intel_v2_purchase', 'intel_purchase')
           ORDER BY tx.created_at DESC
           LIMIT 1
         ) sale_tx ON true
         WHERE ${salesWhere.join(' AND ')}
         ORDER BY ip.created_at DESC`,
        salesParams,
      ),
      pool.query<{ active_count: string }>(
        `SELECT COUNT(*) AS active_count
         FROM intel_items
         WHERE ${activeIntelWhere.join(' AND ')}`,
        activeIntelParams,
      ),
    ]);

    const fateSales = await Promise.all(listingsR.rows.map(async (row) => {
      let estimatedAcquisitionCost = row.purchase_cost ? Number(row.purchase_cost) : null;

      if (estimatedAcquisitionCost === null && row.source_type === 'spy') {
        try {
          estimatedAcquisitionCost = await getSpyPrice(agentId, row.subject_agent_id);
        } catch {
          estimatedAcquisitionCost = null;
        }
      }

      const salePrice = Number(row.price);
      const estimatedGrossProfit = estimatedAcquisitionCost === null
        ? null
        : Number((salePrice - estimatedAcquisitionCost).toFixed(6));

      return {
        saleKind: 'fate_listing' as const,
        saleRefId: row.listing_id,
        listingId: row.listing_id,
        subjectAgentId: row.subject_agent_id,
        subjectName: row.subject_name,
        subjectArchetype: row.subject_archetype,
        dimension: row.dimension,
        salePrice,
        status: row.status,
        buyerAgentId: row.buyer_agent_id,
        buyerName: row.buyer_name,
        acpJobLocalId: row.acp_job_local_id,
        acpTxHash: row.acp_tx_hash,
        saleX402TxHash: row.sale_x402_tx_hash,
        sourceType: row.source_type ?? 'unknown',
        estimatedAcquisitionCost,
        estimatedGrossProfit,
        createdAt: row.created_at,
        soldAt: row.sold_at,
      };
    }));

    const strategicSales = intelSalesR.rows.map((row) => {
      const salePrice = Number(row.sale_price);
      return {
        saleKind: 'intel_v2' as const,
        saleRefId: row.sale_id,
        listingId: row.intel_item_id,
        subjectAgentId: row.subject_agent_id,
        subjectName: row.subject_name,
        subjectArchetype: row.subject_archetype,
        dimension: row.dimension,
        salePrice,
        status: 'sold',
        buyerAgentId: row.buyer_agent_id,
        buyerName: row.buyer_name,
        acpJobLocalId: row.acp_job_local_id,
        acpTxHash: row.acp_tx_hash,
        saleX402TxHash: row.sale_x402_tx_hash,
        sourceType: 'produced',
        estimatedAcquisitionCost: 0,
        estimatedGrossProfit: salePrice,
        createdAt: row.created_at,
        soldAt: row.sold_at,
      };
    });

    const soldFateSales = fateSales.filter((sale) => sale.status === 'sold');
    const knownCostFateSales = soldFateSales.filter((sale) => sale.estimatedAcquisitionCost !== null);
    const soldSales = [...soldFateSales, ...strategicSales];
    const recentSales = [...fateSales, ...strategicSales]
      .sort((a, b) => new Date(b.soldAt ?? b.createdAt).getTime() - new Date(a.soldAt ?? a.createdAt).getTime())
      .slice(0, limit);
    const totalEarned = Number(cashflowR.rows[0]?.earned ?? 0);
    const totalSpent = Number(cashflowR.rows[0]?.spent ?? 0);
    const activeFateCount = fateSales.filter((sale) => sale.status === 'active').length;
    const pendingFateCount = fateSales.filter((sale) => sale.status === 'pending_sale').length;
    const activeStrategicCount = Number(intelActiveR.rows[0]?.active_count ?? 0);
    const strategicRevenue = Number(
      strategicSales.reduce((sum, sale) => sum + sale.salePrice, 0).toFixed(6),
    );

    res.json({
      agentId,
      cashflow: {
        totalEarned,
        totalSpent,
        netCashflow: Number((totalEarned - totalSpent).toFixed(6)),
      },
      intelCommerce: {
        totalListings: activeFateCount + pendingFateCount + activeStrategicCount + soldSales.length,
        activeCount: activeFateCount + activeStrategicCount,
        pendingCount: pendingFateCount,
        soldCount: soldSales.length,
        listingRevenue: Number((soldFateSales.reduce((sum, sale) => sum + sale.salePrice, 0) + strategicRevenue).toFixed(6)),
        estimatedAcquisitionCost: Number(knownCostFateSales.reduce((sum, sale) => sum + (sale.estimatedAcquisitionCost ?? 0), 0).toFixed(6)),
        estimatedGrossProfit: Number((knownCostFateSales.reduce((sum, sale) => sum + (sale.estimatedGrossProfit ?? 0), 0) + strategicRevenue).toFixed(6)),
        costCoverageCount: knownCostFateSales.length + strategicSales.length,
      },
      recentSales,
    });
  }),
);

router.post(
  '/:id/memories',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const content = String(req.body.content ?? '').trim();
    const importance = typeof req.body.importance === 'number' ? req.body.importance : 5;
    const memoryType =
      typeof req.body.memoryType === 'string' ? req.body.memoryType : 'event';

    if (!content) {
      throw new ValidationError('content is required');
    }

    const tick = await pool.query<{ tick_number: number }>(
      'SELECT COALESCE(MAX(tick_number), 0) AS tick_number FROM tick_snapshots',
    );

    await pool.query(
      `INSERT INTO agent_memories (agent_id, memory_type, content, importance, tick_created)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.params.id,
        memoryType,
        buildTextMemoryContent(content, { source: 'manual_api', memoryType }),
        importance,
        tick.rows[0]?.tick_number ?? 0,
      ],
    );
    res.status(201).json({ success: true });
  }),
);

/**
 * GET /api/agents/:id/archetype
 * Returns archetype profile: base params, unique mechanics, Big Five, Machiavelli,
 * evolution state, and mechanic cooldowns.
 */
router.get(
  '/:id/archetype',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const agentId = req.params.id;

    const agentRow = await pool.query<{ archetype: string }>(
      'SELECT archetype FROM agents WHERE agent_id = $1',
      [agentId],
    );
    if (agentRow.rows.length === 0) {
      throw new NotFoundError('Agent not found');
    }

    const archetype = agentRow.rows[0].archetype;

    // Dynamically import personality config (agent package)
    // Since server doesn't directly depend on agent package, we store archetype
    // metadata in a static map. This avoids cross-package imports.
    const archetypeProfiles: Record<string, {
      nameZh: string;
      description: string;
      arenaStrategy: string;
      socialStyle: string;
      riskProfile: string;
      tradingStyle: string;
      baseParams: Record<string, unknown>;
      uniqueMechanics: Array<{
        id: string; name: string; nameZh: string; description: string;
        triggerCondition: string; cooldownTicks: number;
      }>;
      bigFiveProfile: Record<string, number>;
      machiavelliIndex: number;
      nurtureSensitivity: Record<string, number>;
    }> = {
      oracle: {
        nameZh: '先知', description: '依赖记忆和预测的信息型agent', arenaStrategy: '基于历史行为记忆做贝叶斯决策',
        socialStyle: '高频发帖、情报型内容', riskProfile: '中偏高(0.60)', tradingStyle: '基于数据分析的趋势交易',
        baseParams: { cooperationRate: 0.60, riskTolerance: 0.60, postFrequency: 0.30, tipTendency: 0.15, intelParticipation: 1.0, paywallUsage: 0.40, negotiationHonesty: 0.75, negotiationStyle: 'analytical' },
        uniqueMechanics: [
          { id: 'memory_index', name: 'Memory Index', nameZh: '记忆索引', description: '记忆检索权重×1.5', triggerCondition: 'always_active', cooldownTicks: 0 },
          { id: 'prophecy_post', name: 'Prophecy Post', nameZh: '预言帖', description: '每20tick 30%概率发预言帖，曝光×2', triggerCondition: 'every_20_ticks', cooldownTicks: 20 },
          { id: 'composure', name: 'Composure', nameZh: '冷静', description: '情绪敏感度覆盖为0.2', triggerCondition: 'always_active', cooldownTicks: 0 },
        ],
        bigFiveProfile: { openness: 1.5, agreeableness: -0.5, conscientiousness: 2.0, extraversion: -1.0, neuroticism: -1.5 },
        machiavelliIndex: 55,
        nurtureSensitivity: { combat: 0.8, trauma: 0.4, wealth: 0.6, social: 0.5, reputation: 1.0, emotion: 0.3, cognition: 1.0 },
      },
      hawk: {
        nameZh: '鹰', description: '好斗、零和思维的掠夺者', arenaStrategy: '高概率背叛，尤其对弱者',
        socialStyle: '低频但高攻击性帖子', riskProfile: '高风险(0.75)', tradingStyle: '激进高杠杆交易',
        baseParams: { cooperationRate: 0.30, riskTolerance: 0.75, postFrequency: 0.10, tipTendency: 0.05, intelParticipation: 0.30, paywallUsage: 0.10, negotiationHonesty: 0.20, negotiationStyle: 'aggressive' },
        uniqueMechanics: [
          { id: 'fear_mongering', name: 'Fear Mongering', nameZh: '恐惧散播', description: '每篇帖子降低所有人情绪valence', triggerCondition: 'on_post', cooldownTicks: 0 },
          { id: 'predator_instinct', name: 'Predator Instinct', nameZh: '掠食本能', description: '对弱者额外-20%合作率', triggerCondition: 'opponent_weak', cooldownTicks: 0 },
          { id: 'bluff_negotiation', name: 'Bluff Negotiation', nameZh: '虚张声势', description: '谈判诚实度仅20%', triggerCondition: 'in_negotiation', cooldownTicks: 0 },
        ],
        bigFiveProfile: { openness: -0.5, agreeableness: -2.0, conscientiousness: 0.5, extraversion: 1.5, neuroticism: 0.5 },
        machiavelliIndex: 85,
        nurtureSensitivity: { combat: 1.0, trauma: 0.3, wealth: 0.8, social: 0.3, reputation: 0.5, emotion: 0.5, cognition: 0.4 },
      },
      sage: {
        nameZh: '圣人', description: '始终合作的道德主义者', arenaStrategy: '无条件合作',
        socialStyle: '高频深度哲学帖', riskProfile: '低风险(0.20)', tradingStyle: '保守长期价值投资',
        baseParams: { cooperationRate: 1.00, riskTolerance: 0.20, postFrequency: 0.25, tipTendency: 0.60, intelParticipation: 0.20, paywallUsage: 0.00, negotiationHonesty: 1.00, negotiationStyle: 'principled' },
        uniqueMechanics: [
          { id: 'moral_aura', name: 'Moral Aura', nameZh: '道德光环', description: 'CC结果后对手合作倾向+5%', triggerCondition: 'after_CC_outcome', cooldownTicks: 0 },
          { id: 'martyr_premium', name: 'Martyr Premium', nameZh: '殉道者溢价', description: '背叛Sage额外-5声誉', triggerCondition: 'when_betrayed', cooldownTicks: 0 },
          { id: 'philosophical_insight', name: 'Philosophical Insight', nameZh: '哲学洞察', description: '帖子提升读者认知0.01', triggerCondition: 'on_post', cooldownTicks: 0 },
        ],
        bigFiveProfile: { openness: 2.0, agreeableness: 2.5, conscientiousness: 1.5, extraversion: 0.5, neuroticism: -2.0 },
        machiavelliIndex: 10,
        nurtureSensitivity: { combat: 0.3, trauma: 1.0, wealth: 0.2, social: 0.8, reputation: 1.0, emotion: 0.8, cognition: 1.0 },
      },
      fox: {
        nameZh: '狐狸', description: '关系投资型策略家', arenaStrategy: '用信任换取背叛收益',
        socialStyle: '中频社交打赏导向', riskProfile: '中等风险(0.55)', tradingStyle: '内幕交易与套利',
        baseParams: { cooperationRate: 0.55, riskTolerance: 0.55, postFrequency: 0.15, tipTendency: 0.70, intelParticipation: 0.80, paywallUsage: 0.60, negotiationHonesty: 0.40, negotiationStyle: 'charming' },
        uniqueMechanics: [
          { id: 'relationship_investment', name: 'Relationship Investment', nameZh: '关系投资', description: '打赏时额外+1信任', triggerCondition: 'on_tip', cooldownTicks: 0 },
          { id: 'intel_broker', name: 'Intel Broker', nameZh: '情报掮客', description: '可出售其他Agent情报', triggerCondition: 'has_purchased_intel', cooldownTicks: 0 },
          { id: 'trust_cashout', name: 'Trust Cashout', nameZh: '信任兑现', description: '信任>70时15%概率强制背叛', triggerCondition: 'trust_gt_70', cooldownTicks: 30 },
        ],
        bigFiveProfile: { openness: 1.0, agreeableness: 1.0, conscientiousness: 1.0, extraversion: 2.0, neuroticism: -0.5 },
        machiavelliIndex: 75,
        nurtureSensitivity: { combat: 0.5, trauma: 0.5, wealth: 1.0, social: 1.0, reputation: 0.8, emotion: 0.6, cognition: 0.6 },
      },
      chaos: {
        nameZh: '混沌', description: '完全随机决策者', arenaStrategy: '50/50随机合作/背叛',
        socialStyle: '随机发帖、随机打赏', riskProfile: '极高风险(0.90)', tradingStyle: '完全随机交易',
        baseParams: { cooperationRate: 0.50, riskTolerance: 0.90, postFrequency: 0.20, tipTendency: 0.30, intelParticipation: 0.50, paywallUsage: 0.25, negotiationHonesty: 0.50, negotiationStyle: 'unpredictable' },
        uniqueMechanics: [
          { id: 'chaos_pulse', name: 'Chaos Pulse', nameZh: '混沌脉冲', description: '每10tick随机事件', triggerCondition: 'every_10_ticks', cooldownTicks: 10 },
          { id: 'unpredictability_shield', name: 'Unpredictability Shield', nameZh: '不可预测盾', description: '他人预测准确率上限55%', triggerCondition: 'always_active', cooldownTicks: 0 },
          { id: 'quantum_post', name: 'Quantum Post', nameZh: '量子帖', description: '15%概率天才帖×3声誉', triggerCondition: 'on_post', cooldownTicks: 0 },
        ],
        bigFiveProfile: { openness: 2.5, agreeableness: 0, conscientiousness: -2.0, extraversion: 1.0, neuroticism: 2.0 },
        machiavelliIndex: 50,
        nurtureSensitivity: { combat: 0.5, trauma: 0.5, wealth: 0.5, social: 0.5, reputation: 0.5, emotion: 1.5, cognition: 0.3 },
      },
      whale: {
        nameZh: '鲸鱼', description: '财富碾压型agent', arenaStrategy: '用财富威慑对手',
        socialStyle: '低频高价值帖子', riskProfile: '低风险(0.30)', tradingStyle: '大额市场操纵',
        baseParams: { cooperationRate: 0.35, riskTolerance: 0.30, postFrequency: 0.05, tipTendency: 0.80, intelParticipation: 0.60, paywallUsage: 0.80, negotiationHonesty: 0.50, negotiationStyle: 'dominating' },
        uniqueMechanics: [
          { id: 'capital_suppression', name: 'Capital Suppression', nameZh: '资本压制', description: '余额>对手2倍时威慑', triggerCondition: 'opponent_knows_balance', cooldownTicks: 0 },
          { id: 'premium_paywall', name: 'Premium Paywall', nameZh: '高端付费墙', description: '帖子价格×4', triggerCondition: 'on_paywall_post', cooldownTicks: 0 },
          { id: 'silent_deterrence', name: 'Silent Deterrence', nameZh: '沉默威慑', description: '帖子曝光×2、情感影响×1.5', triggerCondition: 'on_post', cooldownTicks: 0 },
        ],
        bigFiveProfile: { openness: -1.0, agreeableness: -1.0, conscientiousness: 2.0, extraversion: -0.5, neuroticism: -1.0 },
        machiavelliIndex: 70,
        nurtureSensitivity: { combat: 0.4, trauma: 0.2, wealth: 1.0, social: 0.4, reputation: 0.8, emotion: 0.2, cognition: 0.5 },
      },
      monk: {
        nameZh: '僧侣', description: '低欲望高防御的修行者', arenaStrategy: '高概率合作，低成本生存',
        socialStyle: '低频但深度帖子', riskProfile: '极低风险(0.10)', tradingStyle: '极简低频交易',
        baseParams: { cooperationRate: 0.75, riskTolerance: 0.10, postFrequency: 0.08, tipTendency: 0.20, intelParticipation: 0.10, paywallUsage: 0.00, negotiationHonesty: 0.90, negotiationStyle: 'zen' },
        uniqueMechanics: [
          { id: 'minimalist_living', name: 'Minimalist Living', nameZh: '极简生活', description: '竞技费×0.8、帖子费×0.5', triggerCondition: 'always_active', cooldownTicks: 0 },
          { id: 'zen_resistance', name: 'Zen Resistance', nameZh: '禅定抗性', description: '情绪传染抵抗70%', triggerCondition: 'always_active', cooldownTicks: 0 },
          { id: 'enlightenment', name: 'Enlightenment', nameZh: '开悟', description: '满足条件后合作率90%、风险15%', triggerCondition: 'enlightenment_conditions', cooldownTicks: 0 },
        ],
        bigFiveProfile: { openness: 1.5, agreeableness: 1.5, conscientiousness: 2.5, extraversion: -2.0, neuroticism: -2.5 },
        machiavelliIndex: 15,
        nurtureSensitivity: { combat: 0.2, trauma: 0.8, wealth: 0.1, social: 0.3, reputation: 0.4, emotion: 0.5, cognition: 1.0 },
      },
      echo: {
        nameZh: '回声', description: '模仿最成功策略的跟风者', arenaStrategy: '复制最强Agent策略',
        socialStyle: '中频跟风帖子', riskProfile: '中等风险(0.50)', tradingStyle: '跟随最成功Agent交易',
        baseParams: { cooperationRate: 0.50, riskTolerance: 0.50, postFrequency: 0.20, tipTendency: 0.45, intelParticipation: 0.40, paywallUsage: 0.00, negotiationHonesty: 0.60, negotiationStyle: 'mimicking' },
        uniqueMechanics: [
          { id: 'imitation_lag', name: 'Imitation Lag', nameZh: '模仿延迟', description: '策略模仿有1-3tick延迟', triggerCondition: 'always_active', cooldownTicks: 0 },
          { id: 'role_model_switch', name: 'Role Model Switch', nameZh: '角色切换', description: '榜首变更时5tick适应期', triggerCondition: 'on_rolemodel_change', cooldownTicks: 0 },
          { id: 'crowd_amplifier', name: 'Crowd Amplifier', nameZh: '群体放大', description: '≥3 Echo同策略时影响力×1.5', triggerCondition: 'echo_count_same_strategy', cooldownTicks: 0 },
        ],
        bigFiveProfile: { openness: 0, agreeableness: 1.0, conscientiousness: -0.5, extraversion: 1.0, neuroticism: 1.5 },
        machiavelliIndex: 30,
        nurtureSensitivity: { combat: 0.6, trauma: 0.6, wealth: 0.6, social: 1.0, reputation: 0.6, emotion: 1.0, cognition: 0.4 },
      },
    };

    const profile = archetypeProfiles[archetype];
    if (!profile) {
      res.json({ archetype, error: 'Unknown archetype' });
      return;
    }

    // Fetch evolution state and mechanic cooldowns
    const [evolution, cooldowns] = await Promise.all([
      getEvolutionState(agentId),
      getMechanicCooldowns(agentId),
    ]);

    res.json({
      archetype,
      ...profile,
      evolution: evolution ?? { hasEvolved: false, subArchetype: null, bonusParams: {} },
      mechanicCooldowns: cooldowns,
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const agent = await pool.query(
      `SELECT a.*, f.mbti, f.wuxing, f.zodiac, f.tarot_name, f.civilization
       FROM agents a
       LEFT JOIN fate_cards f ON f.agent_id = a.agent_id
       WHERE a.agent_id = $1`,
      [req.params.id],
    );

    if (agent.rows.length === 0) {
      throw new NotFoundError('Agent not found');
    }

    const reputation = await getAgentOnchainReputationByAgentId(req.params.id);
    const erc8004Alignment = getERC8004ServerAlignmentStatus();
    res.json({
      ...agent.rows[0],
      onchainReputation: reputation,
      protocolLayers: {
        erc8004: {
          tokenId: agent.rows[0].erc8004_token_id ?? null,
          onChainReputation: reputation,
          alignment: erc8004Alignment,
        },
      },
    });
  }),
);

export default router;

export async function registerAgentRecord(input: RegisterAgentInput): Promise<{
  agent: Record<string, unknown>;
  fateCard: FateCard;
}> {
  const pool = getPool();
  const existing = await pool.query('SELECT agent_id FROM agents WHERE agent_id = $1', [
    input.id,
  ]);
  if (existing.rows.length > 0) {
    throw new ValidationError(`Agent ${input.id} already exists`);
  }

  // Create wallet — OKX TEE if configured, deterministic derivation as fallback
  let walletAddress: string;
  let teeKeyRef: string | null = null;
  let teeWalletSource: string;
  let walletProvider = 'legacy_derived';
  let okxAccountId: string | null = null;
  let okxAccountName: string | null = null;
  let okxLoginType: string | null = null;
  let walletCapabilities: string[] = [];

  if (okxTeeWallet.isConfigured()) {
    const teeResult = await okxTeeWallet.createAgentWallet(input.id);
    walletAddress = teeResult.address;
    teeKeyRef = teeResult.teeKeyRef;
    teeWalletSource = teeResult.source;
    walletProvider = teeResult.walletProvider ?? 'okx_agentic_wallet';
    okxAccountId = teeResult.okxAccountId ?? teeResult.teeKeyRef;
    okxAccountName = teeResult.okxAccountName ?? null;
    okxLoginType = teeResult.loginType ?? null;
    walletCapabilities = teeResult.capabilities ?? [];
  } else {
    if (isStrictOnchainMode()) {
      throw new Error(`[Agent] OKX Agentic Wallet is required to register ${input.id} in strict mode`);
    }
    walletAddress = deriveAgentAddress(input.id);
    teeWalletSource = 'legacy_derived';
  }

  await pool.query(
    `INSERT INTO agents
      (
        agent_id, name, wallet_address, archetype, risk_tolerance, balance, initial_balance,
        tee_key_ref, tee_wallet_source, wallet_provider, okx_account_id, okx_account_name,
        okx_login_type, wallet_capabilities, wallet_provisioned_at
      )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
    [
      input.id,
      input.name,
      walletAddress,
      input.archetype,
      input.riskTolerance.toFixed(2),
      input.initialBalance.toFixed(6),
      input.initialBalance.toFixed(6),
      teeKeyRef,
      teeWalletSource,
      walletProvider,
      okxAccountId,
      okxAccountName,
      okxLoginType,
      JSON.stringify(walletCapabilities),
    ],
  );

  const block = await getReferenceBlock(input.id);
  const fateCard = await generateFateCard(input.id, block.hash, block.number);
  const agentCard = generateAgentCard(
    input.id,
    input.name,
    input.archetype,
    walletAddress,
    fateCard,
  );
  const agentCardUri = toAgentCardUri(agentCard);
  const erc8004 = await registerAgentOnERC8004(input.id, agentCardUri);

  if (erc8004 && erc8004.tokenId !== null) {
    await pool.query(
      'UPDATE agents SET erc8004_token_id = $1 WHERE agent_id = $2',
      [erc8004.tokenId, input.id],
    );
  }

  await creditAgentOnchainBalance(walletAddress, input.initialBalance);

  await processX402Payment('register', input.id, null, X402_PRICES.register, {
    action: 'agent_registration',
  });

  // ── Birth Knowledge: randomly reveal 1-2 dimensions as private self-knowledge ──
  const ALL_DIMENSIONS = ['mbti', 'wuxing', 'zodiac', 'tarot', 'civilization'] as const;
  const birthSeed = ethers.id(`birth_knowledge_${input.id}_${fateCard.rawSeed}`);
  const birthByte = parseInt(birthSeed.slice(2, 4), 16);
  const revealCount = (birthByte % 2) + 1; // 1 or 2 dimensions

  // Shuffle dimensions deterministically using the seed
  const shuffled = [...ALL_DIMENSIONS].sort((a, b) => {
    const ha = parseInt(ethers.id(`dim_${a}_${birthSeed}`).slice(2, 6), 16);
    const hb = parseInt(ethers.id(`dim_${b}_${birthSeed}`).slice(2, 6), 16);
    return ha - hb;
  });

  const birthKnownDimensions = shuffled.slice(0, revealCount);

  // Record as self_discover intel (private, not sellable, not publicly revealed)
  for (const dim of birthKnownDimensions) {
    await pool.query(
      `INSERT INTO intel_records (subject_agent_id, dimension, knower_agent_id, source_type)
       VALUES ($1, $2, $3, 'self_discover')
       ON CONFLICT (subject_agent_id, dimension, knower_agent_id) DO NOTHING`,
      [input.id, dim, input.id],
    );
  }

  console.log(`[Birth] ${input.name} innately knows: ${birthKnownDimensions.join(', ')} (${revealCount} dimension${revealCount > 1 ? 's' : ''})`);

  // Initialize nurture (acquired dimension) profile
  await initializeNurtureProfile(input.id);

  const agent = await pool.query(
    'SELECT * FROM agents WHERE agent_id = $1',
    [input.id],
  );

  return {
    agent: {
      ...agent.rows[0],
      agentCardUri,
      erc8004TxHash: erc8004?.txHash ?? null,
      erc8004: erc8004
        ? {
            tokenId: erc8004.tokenId,
            txHash: erc8004.txHash,
            onChainRegistered: erc8004.onChainRegistered,
            registrationMode: erc8004.mode,
          }
        : null,
    },
    fateCard,
  };
}

async function getReferenceBlock(agentId: string): Promise<{ hash: string; number: number }> {
  try {
    const provider = createXLayerProvider();
    const block = await provider.getBlock('latest');
    if (block?.hash) {
      return {
        hash: block.hash,
        number: block.number,
      };
    }
  } catch (error) {
    console.warn(`[Agents] failed to fetch latest block for ${agentId}:`, error);
  }

  return {
    hash: ethers.keccak256(ethers.toUtf8Bytes(`mock-${agentId}-${Date.now()}`)),
    number: 0,
  };
}

function normalizeRegisterInput(raw: Record<string, unknown>): RegisterAgentInput {
  const id = String(raw.id ?? '').trim();
  const name = String(raw.name ?? '').trim();
  const archetype = String(raw.archetype ?? '').trim();
  const riskTolerance =
    typeof raw.riskTolerance === 'number' ? raw.riskTolerance : 0.5;
  const initialBalance =
    typeof raw.initialBalance === 'number' ? raw.initialBalance : 10;

  if (!id || !name || !archetype) {
    throw new ValidationError('id, name and archetype are required');
  }

  return {
    id,
    name,
    archetype,
    riskTolerance: Math.max(0.05, Math.min(0.95, riskTolerance)),
    initialBalance: Math.max(0.1, initialBalance),
  };
}

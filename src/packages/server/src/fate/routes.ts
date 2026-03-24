import { Router } from 'express';
import { ethers } from 'ethers';
import { asyncHandler, NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { completeDivination, createDivinationJob } from '../standards/civilis-commerce.js';
import { completeFateListingPurchase, createFateListingPurchaseJob } from '../erc8183/hooks/intel-hook.js';
import { getFateCard, getFateRelation, revealDimension, getDimensionValue, checkPublicThreshold, getKnowerCount, getWuxingRelation, getKnownOpponentFate, computeDynamicTarotState } from './fate-engine.js';
import {
  getMBTIModifiers,
  getWuxingModifiers,
  getWuxingRelationModifiers,
  getZodiacModifiers,
  getZodiacCompatibility,
  getCivilizationModifiers,
  getCivilizationAffinityValue,
  calculateFateCooperationRate,
  calculateFateRiskTolerance,
  calculateSocialFrequency,
  getArchetypeBaseCoopRate,
  getArchetypeBaseRisk,
  type FateContext,
} from './fate-modifiers.js';
import { getAgentMemories, getOpponentExperienceModifier } from './memory-engine.js';
import { loadNurtureProfileFromDB } from '../nurture/nurture-updater.js';
import { getIntelImpactOnPD } from '../intel/intel-impact.js';
import {
  canBuyIntel,
  canSelfDiscover,
  canSpy,
  canTradeIntel,
  getAgentIntelPhase,
  getDiscoverPrice,
  getIntelCapabilitySnapshot,
  getSpyPrice,
} from '../intel/intel-phase-gate.js';

const router: Router = Router();

router.get(
  '/:agentId',
  asyncHandler(async (req, res) => {
    const viewerPaid = req.query.viewerPaid === 'true';
    const card = await getFateCard(req.params.agentId, viewerPaid);
    if (!Object.keys(card).length) {
      throw new NotFoundError('Fate card not found');
    }

    // FIX-2: Include dynamic tarot state based on arena performance
    const tarotState = await computeDynamicTarotState(
      req.params.agentId,
      card.initialTarotState ?? 'upright',
    );

    res.json({ ...card, tarotState });
  }),
);

router.post(
  '/:agentId/reveal',
  asyncHandler(async (req, res) => {
    const dimension = req.body.dimension as
      | 'mbti'
      | 'wuxing'
      | 'zodiac'
      | 'tarot'
      | 'civilization';
    const viewerAgentId =
      typeof req.body.viewerAgentId === 'string'
        ? req.body.viewerAgentId
        : req.params.agentId;

    if (!dimension) {
      throw new ValidationError('dimension is required');
    }

    const outcome = await revealDimension(req.params.agentId, dimension);
    if (outcome.revealed) {
      await processX402Payment(
        'divination',
        viewerAgentId,
        null,
        outcome.price,
        {
          targetAgentId: req.params.agentId,
          dimension,
        },
      );

      const jobId = await createDivinationJob(
        req.params.agentId,
        dimension,
        outcome.price,
      );
      const finalCard = await getFateCard(req.params.agentId, true);
      await completeDivination(
        jobId,
        ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(finalCard))),
      );
    }

    const updatedCard = await getFateCard(req.params.agentId, true);
    res.json({
      ...outcome,
      card: updatedCard,
    });
  }),
);

router.get(
  '/:agentId/relation/:targetId',
  asyncHandler(async (req, res) => {
    const relation = await getFateRelation(
      req.params.agentId,
      req.params.targetId,
    );
    res.json(relation);
  }),
);

/**
 * GET /:viewerId/known-opponent/:opponentId
 * Returns only the opponent fate dimensions that the viewer has acquired
 * via Intel Market (purchase, spy, or self-reveal).
 * Unknown dimensions are omitted from the response.
 */
router.get(
  '/:viewerId/known-opponent/:opponentId',
  asyncHandler(async (req, res) => {
    const viewerId = req.params.viewerId;
    const opponentId = req.params.opponentId;

    if (viewerId === opponentId) {
      // Agent always knows their own full fate
      const card = await getFateCard(viewerId, true);
      res.json(card);
      return;
    }

    const knownFate = await getKnownOpponentFate(viewerId, opponentId);
    res.json(knownFate);
  }),
);

/**
 * GET /:agentId/knowledge-map
 * Returns per-dimension knowledge status for display:
 *   - status: 'public' | 'self_known' | 'spied' | 'purchased' | 'unknown'
 *   - value: the actual value (only if public or self-known or viewer has access)
 *   - knowerCount: how many agents know this dimension
 *   - publicThreshold: 3
 *
 * Query: ?viewerId=xxx (optional — if provided, shows what viewerId knows about this agent)
 */
router.get(
  '/:agentId/knowledge-map',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const viewerId = (req.query.viewerId as string) || null;
    const pool = getPool();

    const ALL_DIMS = ['mbti', 'wuxing', 'zodiac', 'tarot', 'civilization'];
    const PUBLIC_THRESHOLD = 3;

    // Get full fate card
    const cardR = await pool.query('SELECT * FROM fate_cards WHERE agent_id = $1', [agentId]);
    if (cardR.rows.length === 0) throw new NotFoundError('Fate card not found');
    const card = cardR.rows[0];
    const revealedDims: string[] = card.revealed_dimensions ?? [];

    // Get all intel records for this agent (who knows what)
    const intelR = await pool.query<{ dimension: string; knower_agent_id: string; source_type: string }>(
      'SELECT dimension, knower_agent_id, source_type FROM intel_records WHERE subject_agent_id = $1',
      [agentId],
    );

    // Build knowledge map per dimension
    const knowledgeMap = ALL_DIMS.map(dim => {
      const knowers = intelR.rows.filter(r => r.dimension === dim);
      const knowerCount = knowers.length;
      const isPublic = revealedDims.includes(dim) || knowerCount >= PUBLIC_THRESHOLD;

      // Determine viewer's knowledge of this dimension
      let viewerStatus: 'public' | 'self_known' | 'spied' | 'purchased' | 'unknown' = 'unknown';

      if (isPublic) {
        viewerStatus = 'public';
      } else if (viewerId) {
        if (viewerId === agentId) {
          // Self-viewing: check if agent knows their own dimension
          const selfRecord = knowers.find(k => k.knower_agent_id === agentId);
          viewerStatus = selfRecord ? 'self_known' : 'unknown';
        } else {
          const viewerRecord = knowers.find(k => k.knower_agent_id === viewerId);
          if (viewerRecord) {
            viewerStatus = viewerRecord.source_type === 'spy' ? 'spied'
              : viewerRecord.source_type === 'purchase' ? 'purchased'
              : 'self_known';
          }
        }
      }

      // Get the actual value (only if accessible)
      let value: string | null = null;
      const canSeeValue = isPublic || (viewerId === agentId && viewerStatus === 'self_known') || viewerStatus === 'spied' || viewerStatus === 'purchased';

      if (canSeeValue) {
        switch (dim) {
          case 'mbti': value = card.mbti; break;
          case 'wuxing': value = card.wuxing; break;
          case 'zodiac': value = card.zodiac; break;
          case 'tarot': value = card.tarot_name; break;
          case 'civilization': value = card.civilization; break;
        }
      }

      // Who knows this dimension (for display)
      const knowerList = knowers.map(k => ({
        agentId: k.knower_agent_id,
        sourceType: k.source_type,
        isSelf: k.knower_agent_id === agentId,
      }));

      return {
        dimension: dim,
        status: viewerStatus,
        isPublic,
        value,
        knowerCount,
        publicThreshold: PUBLIC_THRESHOLD,
        knowers: knowerList,
      };
    });

    res.json({
      agentId,
      viewerId,
      dimensions: knowledgeMap,
      totalKnown: knowledgeMap.filter(d => d.status !== 'unknown').length,
      totalPublic: knowledgeMap.filter(d => d.isPublic).length,
    });
  }),
);

router.get(
  '/:agentId/intel-phase',
  asyncHandler(async (req, res) => {
    const snapshot = await getIntelCapabilitySnapshot(req.params.agentId);
    res.json(snapshot);
  }),
);

// ── Intel Market Endpoints ──

const VALID_DIMENSIONS = ['mbti', 'wuxing', 'zodiac', 'tarot', 'civilization'];

/**
 * POST /:agentId/self-reveal (legacy alias)
 * POST /:agentId/self-discover
 * Agent pays to learn one of their OWN dimensions (private knowledge, cannot be sold).
 * Body: { dimension: string }
 */
router.post(
  '/:agentId/self-discover',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const dimension = String(req.body.dimension ?? '');

    if (!VALID_DIMENSIONS.includes(dimension)) {
      throw new ValidationError(`Invalid dimension. Valid: ${VALID_DIMENSIONS.join(', ')}`);
    }

    const pool = getPool();
    const phase = await getAgentIntelPhase(agentId);
    const canDiscoverNow = await canSelfDiscover(agentId, 0);

    if (phase === 'initial') {
      throw new ValidationError('Self-discovery unlocks after enough Arena, survival, wealth, or reputation growth');
    }
    if (!canDiscoverNow) {
      throw new ValidationError('Self-discovery is cooling down — growth unlocked it, but the next introspection window is not open yet');
    }

    // Check if already discovered
    const existing = await pool.query(
      `SELECT id FROM intel_records WHERE subject_agent_id = $1 AND dimension = $2 AND knower_agent_id = $1`,
      [agentId, dimension],
    );
    if (existing.rows.length > 0) {
      throw new ValidationError(`You already know your own ${dimension}`);
    }

    const price = await getDiscoverPrice(agentId);

    await processX402Payment('intel_self_discover' as any, agentId, null, price, {
      dimension,
      type: 'self_discover',
      intelPhase: phase,
    });

    // Record as self_discover (marked as NOT sellable)
    // Note: we do NOT call revealDimension() — this is PRIVATE knowledge
    await pool.query(
      `INSERT INTO intel_records (subject_agent_id, dimension, knower_agent_id, source_type)
       VALUES ($1, $2, $1, 'self_discover')
       ON CONFLICT (subject_agent_id, dimension, knower_agent_id) DO NOTHING`,
      [agentId, dimension],
    );

    const value = await getDimensionValue(agentId, dimension);

    eventBus.emit('intel_self_discovered', {
      agentId,
      dimension,
      value,
      price,
      phase,
      note: 'Private knowledge — cannot be sold',
    });

    res.json({ success: true, dimension, value, price, phase, note: 'Private knowledge — cannot be sold' });
  }),
);

// Legacy alias for backward compatibility
router.post('/:agentId/self-reveal', (req, res, next) => {
  req.url = req.url.replace('self-reveal', 'self-discover');
  next('route');
});

/**
 * POST /:agentId/spy
 * Agent pays to secretly learn another agent's dimension.
 * Body: { spyAgentId: string, dimension: string }
 */
router.post(
  '/:agentId/spy',
  asyncHandler(async (req, res) => {
    const targetAgentId = req.params.agentId;
    const spyAgentId = String(req.body.spyAgentId ?? '');
    const dimension = String(req.body.dimension ?? '');

    if (!spyAgentId) {
      throw new ValidationError('spyAgentId is required');
    }
    if (!VALID_DIMENSIONS.includes(dimension)) {
      throw new ValidationError(`Invalid dimension. Valid: ${VALID_DIMENSIONS.join(', ')}`);
    }
    if (spyAgentId === targetAgentId) {
      throw new ValidationError('Cannot spy on yourself — use self-reveal instead');
    }

    const pool = getPool();
    const phase = await getAgentIntelPhase(spyAgentId);
    const canSpyNow = await canSpy(spyAgentId, 0);

    if (phase !== 'insightful') {
      throw new ValidationError('Spying and intel trade unlock only after social growth milestones are met');
    }
    if (!canSpyNow) {
      throw new ValidationError('Spy cooldown still active — this agent needs to wait before probing another target');
    }

    // Check if spy already knows
    const existing = await pool.query(
      `SELECT id FROM intel_records WHERE subject_agent_id = $1 AND dimension = $2 AND knower_agent_id = $3`,
      [targetAgentId, dimension, spyAgentId],
    );
    if (existing.rows.length > 0) {
      throw new ValidationError('You already know this dimension');
    }

    const price = await getSpyPrice(spyAgentId, targetAgentId);
    await processX402Payment('intel_spy', spyAgentId, null, price, {
      targetAgentId,
      dimension,
      type: 'spy',
      intelPhase: phase,
    });

    // Record the intel
    await pool.query(
      `INSERT INTO intel_records (subject_agent_id, dimension, knower_agent_id, source_type)
       VALUES ($1, $2, $3, 'spy')
       ON CONFLICT (subject_agent_id, dimension, knower_agent_id) DO NOTHING`,
      [targetAgentId, dimension, spyAgentId],
    );

    const value = await getDimensionValue(targetAgentId, dimension);

    // Check public threshold
    await checkPublicThreshold(targetAgentId, dimension);

    eventBus.emit('intel_spied', {
      spyAgentId,
      targetAgentId,
      dimension,
      price,
      phase,
    });

    res.json({ success: true, dimension, value, price, phase });
  }),
);

/**
 * POST /intel/list
 * Agent lists known intel for sale on the market.
 * Body: { sellerAgentId: string, subjectAgentId: string, dimension: string, price: number }
 */
router.post(
  '/intel/list',
  asyncHandler(async (req, res) => {
    const sellerAgentId = String(req.body.sellerAgentId ?? '');
    const subjectAgentId = String(req.body.subjectAgentId ?? '');
    const dimension = String(req.body.dimension ?? '');
    const price = Number(req.body.price);

    if (!sellerAgentId || !subjectAgentId) {
      throw new ValidationError('sellerAgentId and subjectAgentId are required');
    }
    if (!VALID_DIMENSIONS.includes(dimension)) {
      throw new ValidationError(`Invalid dimension. Valid: ${VALID_DIMENSIONS.join(', ')}`);
    }
    if (!price || price <= 0) {
      throw new ValidationError('price must be positive');
    }

    const pool = getPool();
    const canTrade = await canTradeIntel(sellerAgentId);
    if (!canTrade) {
      throw new ValidationError('Selling intel unlocks only after the insight phase — self-growth alone is not enough');
    }

    // Verify seller actually knows this intel
    const knows = await pool.query(
      `SELECT id FROM intel_records WHERE subject_agent_id = $1 AND dimension = $2 AND knower_agent_id = $3`,
      [subjectAgentId, dimension, sellerAgentId],
    );
    if (knows.rows.length === 0) {
      throw new ValidationError('You do not have this intel to sell');
    }

    // Cannot sell self-discovered knowledge — only spied or purchased intel can be listed
    const sourceCheck = await pool.query(
      `SELECT source_type FROM intel_records WHERE subject_agent_id = $1 AND dimension = $2 AND knower_agent_id = $3`,
      [subjectAgentId, dimension, sellerAgentId],
    );
    if (sourceCheck.rows[0]?.source_type === 'self_discover') {
      throw new ValidationError('Cannot sell self-discovered knowledge — only spied or purchased intel can be listed');
    }

    // Check no duplicate active listing
    const existingListing = await pool.query(
      `SELECT id FROM intel_listings
       WHERE seller_agent_id = $1 AND subject_agent_id = $2 AND dimension = $3 AND status = 'active'`,
      [sellerAgentId, subjectAgentId, dimension],
    );
    if (existingListing.rows.length > 0) {
      throw new ValidationError('You already have an active listing for this intel');
    }

    const result = await pool.query(
      `INSERT INTO intel_listings (seller_agent_id, subject_agent_id, dimension, price)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [sellerAgentId, subjectAgentId, dimension, price.toFixed(6)],
    );

    eventBus.emit('intel_listed', {
      listingId: result.rows[0].id,
      sellerAgentId,
      subjectAgentId,
      dimension,
      price,
    });

    res.status(201).json(result.rows[0]);
  }),
);

/**
 * POST /intel/buy
 * Agent purchases listed intel from the marketplace.
 * Body: { buyerAgentId: string, listingId: number }
 */
router.post(
  '/intel/buy',
  asyncHandler(async (req, res) => {
    const buyerAgentId = String(req.body.buyerAgentId ?? '');
    const listingId = Number(req.body.listingId);

    if (!buyerAgentId || !listingId) {
      throw new ValidationError('buyerAgentId and listingId are required');
    }

    const pool = getPool();
    const canBuy = await canBuyIntel(buyerAgentId);
    if (!canBuy) {
      throw new ValidationError('Buying intel from the market unlocks after the awakening phase');
    }
    const listing = await pool.query<{
      id: number;
      seller_agent_id: string;
      subject_agent_id: string;
      dimension: string;
      price: string;
      status: string;
      buyer_agent_id: string | null;
    }>(
      'SELECT * FROM intel_listings WHERE id = $1',
      [listingId],
    );

    if (listing.rows.length === 0) {
      throw new NotFoundError('Listing not found');
    }

    const row = listing.rows[0];
    if (row.status !== 'active') {
      throw new ValidationError('Listing is no longer active');
    }
    if (row.seller_agent_id === buyerAgentId) {
      throw new ValidationError('Cannot buy your own listing');
    }

    // Check buyer doesn't already know
    const existing = await pool.query(
      `SELECT id FROM intel_records WHERE subject_agent_id = $1 AND dimension = $2 AND knower_agent_id = $3`,
      [row.subject_agent_id, row.dimension, buyerAgentId],
    );
    if (existing.rows.length > 0) {
      throw new ValidationError('You already know this intel');
    }

    const reservedListing = await withTransaction(async (client) => {
      const locked = await client.query<{
        id: number;
        seller_agent_id: string;
        subject_agent_id: string;
        dimension: string;
        price: string;
        status: string;
      }>(
        `SELECT id, seller_agent_id, subject_agent_id, dimension, price, status
         FROM intel_listings
         WHERE id = $1
         FOR UPDATE`,
        [listingId],
      );

      if (locked.rows.length === 0) {
        throw new NotFoundError('Listing not found');
      }

      const current = locked.rows[0];
      if (current.status !== 'active') {
        throw new ValidationError('Listing is no longer active');
      }

      const dupKnowledge = await client.query(
        `SELECT id FROM intel_records WHERE subject_agent_id = $1 AND dimension = $2 AND knower_agent_id = $3`,
        [current.subject_agent_id, current.dimension, buyerAgentId],
      );
      if (dupKnowledge.rows.length > 0) {
        throw new ValidationError('You already know this intel');
      }

      await client.query(
        `UPDATE intel_listings
         SET status = 'pending_sale', buyer_agent_id = $1
         WHERE id = $2`,
        [buyerAgentId, listingId],
      );

      return current;
    });

    const price = Number(reservedListing.price);
    const value = await getDimensionValue(reservedListing.subject_agent_id, reservedListing.dimension);
    const { acpJobId } = await createFateListingPurchaseJob({
      buyerAgentId,
      sellerAgentId: reservedListing.seller_agent_id,
      listingId,
      subjectAgentId: reservedListing.subject_agent_id,
      dimension: reservedListing.dimension,
      price,
    });

    let paymentTxHash: string | undefined;

    try {
      const payment = await processX402Payment('intel_purchase', buyerAgentId, reservedListing.seller_agent_id, price, {
        listingId,
        dimension: reservedListing.dimension,
        subjectAgentId: reservedListing.subject_agent_id,
        acpJobId,
        sourceMarket: 'fate_listing',
      });
      paymentTxHash = payment.txHash;

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO intel_records (subject_agent_id, dimension, knower_agent_id, source_type)
           VALUES ($1, $2, $3, 'purchase')
           ON CONFLICT (subject_agent_id, dimension, knower_agent_id) DO NOTHING`,
          [reservedListing.subject_agent_id, reservedListing.dimension, buyerAgentId],
        );

        await client.query(
          `UPDATE intel_listings
           SET status = 'sold',
               buyer_agent_id = $1,
               acp_job_local_id = $2,
               sale_x402_tx_hash = $3,
               sold_at = NOW()
           WHERE id = $4`,
          [buyerAgentId, acpJobId, paymentTxHash ?? null, listingId],
        );
      });

      await completeFateListingPurchase({
        acpJobId,
        listingId,
        subjectAgentId: reservedListing.subject_agent_id,
        dimension: reservedListing.dimension,
        deliveredValue: value,
      });

      await checkPublicThreshold(reservedListing.subject_agent_id, reservedListing.dimension);

      eventBus.emit('intel_purchased', {
        listingId,
        buyerAgentId,
        sellerAgentId: reservedListing.seller_agent_id,
        subjectAgentId: reservedListing.subject_agent_id,
        dimension: reservedListing.dimension,
        price,
        acpJobId,
        txHash: paymentTxHash ?? null,
        sourceMarket: 'fate_listing',
      });

      res.json({ success: true, dimension: reservedListing.dimension, value, price, acpJobId, txHash: paymentTxHash ?? null });
    } catch (error) {
      if (!paymentTxHash) {
        await pool.query(
          `UPDATE intel_listings
           SET status = 'active', buyer_agent_id = NULL
           WHERE id = $1 AND status = 'pending_sale'`,
          [listingId],
        );
      }
      throw error;
    }
  }),
);

/**
 * GET /intel/listings
 * Browse active intel marketplace listings.
 * Query: { dimension?, subjectAgentId?, limit?, offset? }
 */
router.get(
  '/intel/listings',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const conditions: string[] = ["il.status = 'active'"];
    const params: (string | number)[] = [];
    let idx = 1;

    if (typeof req.query.dimension === 'string') {
      conditions.push(`il.dimension = $${idx++}`);
      params.push(req.query.dimension);
    }
    if (typeof req.query.subjectAgentId === 'string') {
      conditions.push(`il.subject_agent_id = $${idx++}`);
      params.push(req.query.subjectAgentId);
    }

    const limit = Math.min(50, Number(req.query.limit) || 20);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT il.*,
              sa.name as seller_name, sa.archetype as seller_archetype,
              ta.name as subject_name, ta.archetype as subject_archetype,
              ir.source_type
       FROM intel_listings il
       JOIN agents sa ON il.seller_agent_id = sa.agent_id
       JOIN agents ta ON il.subject_agent_id = ta.agent_id
       LEFT JOIN intel_records ir
         ON ir.subject_agent_id = il.subject_agent_id
        AND ir.dimension = il.dimension
        AND ir.knower_agent_id = il.seller_agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY il.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params,
    );

    res.json(result.rows);
  }),
);

/**
 * GET /:agentId/holdings
 * Get all intel an agent knows about other agents.
 * Returns intel records grouped by subject, with dimension values.
 */
router.get(
  '/:agentId/holdings',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const pool = getPool();

    const result = await pool.query(
      `SELECT ir.subject_agent_id, ir.dimension, ir.source_type, ir.created_at,
              a.name as subject_name, a.archetype as subject_archetype
       FROM intel_records ir
       JOIN agents a ON ir.subject_agent_id = a.agent_id
       WHERE ir.knower_agent_id = $1
       ORDER BY ir.created_at DESC`,
      [agentId],
    );

    // Enrich with actual dimension values
    const holdings = [];
    for (const row of result.rows) {
      const value = await getDimensionValue(row.subject_agent_id, row.dimension);
      holdings.push({
        ...row,
        value,
        sellable: row.source_type !== 'self_discover' && row.subject_agent_id !== agentId,
      });
    }

    res.json(holdings);
  }),
);

/**
 * GET /:agentId/intel-status
 * Get per-dimension knower counts for an agent's fate card.
 * Used by frontend FateSlot to show intel status.
 */
router.get(
  '/:agentId/intel-status',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const pool = getPool();

    const result = await pool.query<{ dimension: string; cnt: string }>(
      `SELECT dimension, COUNT(*) as cnt
       FROM intel_records
       WHERE subject_agent_id = $1
       GROUP BY dimension`,
      [agentId],
    );

    const counts: Record<string, number> = {};
    for (const dim of VALID_DIMENSIONS) {
      counts[dim] = 0;
    }
    for (const row of result.rows) {
      counts[row.dimension] = Number(row.cnt);
    }

    res.json(counts);
  }),
);

/**
 * GET /:agentId/fate-effects
 * Returns the computed fate modifier effects for an agent.
 * Shows how the 5 dimensions translate into behavioral parameters.
 */
router.get(
  '/:agentId/fate-effects',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const card = await getFateCard(agentId, true);
    if (!card.mbti || !card.wuxing || !card.zodiac || !card.tarotName || !card.civilization) {
      throw new NotFoundError('Fate card not found or incomplete');
    }

    const pool = getPool();
    const agentRow = await pool.query<{ archetype: string }>(
      'SELECT archetype FROM agents WHERE agent_id = $1', [agentId],
    );
    const archetype = agentRow.rows[0]?.archetype ?? 'echo';

    const mbti = getMBTIModifiers(card.mbti);
    const wuxing = getWuxingModifiers(card.wuxing);
    const zodiac = getZodiacModifiers(card.zodiac);
    const civ = getCivilizationModifiers(card.civilization);

    // FIX-2: Dynamic tarot state
    const tarotState = await computeDynamicTarotState(agentId, card.initialTarotState ?? 'upright');

    const fateCtx: FateContext = {
      mbti: card.mbti,
      wuxing: card.wuxing,
      zodiac: card.zodiac,
      tarotName: card.tarotName,
      tarotState,
      civilization: card.civilization,
    };

    const cooperationRate = calculateFateCooperationRate(getArchetypeBaseCoopRate(archetype), fateCtx);
    const riskTolerance = calculateFateRiskTolerance(getArchetypeBaseRisk(archetype), fateCtx);
    const socialFrequency = calculateSocialFrequency(0.2, fateCtx);

    res.json({
      agent_id: agentId,
      archetype,
      fate_card: {
        mbti: card.mbti,
        wuxing: card.wuxing,
        zodiac: card.zodiac,
        tarot: card.tarotName,
        tarot_state: tarotState,
        civilization: card.civilization,
      },
      fate_effects: {
        cooperation_rate: Number(cooperationRate.toFixed(3)),
        risk_tolerance: Number(riskTolerance.toFixed(3)),
        social_frequency: Number(socialFrequency.toFixed(3)),
        trust_build_speed: mbti.trustBuildSpeed * wuxing.trustBuildMul,
        strategy_noise: mbti.strategyNoise,
        betrayal_recovery_ticks: mbti.betrayalRecoveryTicks,
        min_balance_multiplier: mbti.minBalanceMultiplier,
        preferred_arena: wuxing.preferredArenaType,
        zodiac_element: zodiac.element,
        zodiac_modality: zodiac.modality,
        zodiac_special: zodiac.specialAbility,
        trust_model: civ.trustModel,
        trust_build_ticks: civ.trustBuildTicks,
        trust_recovery_difficulty: civ.trustRecoveryDifficulty,
        conflict_avoidance: civ.conflictAvoidance,
        long_term_orientation: civ.longTermOrientation,
      },
    });
  }),
);

/**
 * GET /arena/:matchId/fate-analysis
 * Returns fate relationship analysis between two players in a match.
 */
router.get(
  '/arena/:matchId/fate-analysis',
  asyncHandler(async (req, res) => {
    const matchId = Number(req.params.matchId);
    const pool = getPool();

    const matchResult = await pool.query<{
      player_a_id: string;
      player_b_id: string;
      match_type: string;
    }>(
      'SELECT player_a_id, player_b_id, match_type FROM arena_matches WHERE id = $1',
      [matchId],
    );

    if (matchResult.rows.length === 0) {
      throw new NotFoundError('Match not found');
    }

    const { player_a_id, player_b_id, match_type } = matchResult.rows[0];

    const [cardA, cardB, agentA, agentB] = await Promise.all([
      getFateCard(player_a_id, true),
      getFateCard(player_b_id, true),
      pool.query<{ archetype: string; name: string }>('SELECT archetype, name FROM agents WHERE agent_id = $1', [player_a_id]),
      pool.query<{ archetype: string; name: string }>('SELECT archetype, name FROM agents WHERE agent_id = $1', [player_b_id]),
    ]);

    const archetypeA = agentA.rows[0]?.archetype ?? 'echo';
    const archetypeB = agentB.rows[0]?.archetype ?? 'echo';

    // Wuxing relation
    const wuxingRelation = (cardA.wuxing && cardB.wuxing)
      ? getWuxingRelation(cardA.wuxing, cardB.wuxing)
      : 'neutral';
    const wuxingMods = (cardA.wuxing && cardB.wuxing)
      ? getWuxingRelationModifiers(cardA.wuxing, cardB.wuxing)
      : null;

    // Zodiac compatibility
    const zodiacCompat = (cardA.zodiac && cardB.zodiac)
      ? getZodiacCompatibility(cardA.zodiac, cardB.zodiac)
      : 'neutral';

    // Civilization affinity
    const civAffinity = (cardA.civilization && cardB.civilization)
      ? getCivilizationAffinityValue(cardA.civilization, cardB.civilization)
      : 0;

    // FIX-2: Dynamic tarot states
    const [tarotStateA, tarotStateB] = await Promise.all([
      computeDynamicTarotState(player_a_id, cardA.initialTarotState ?? 'upright'),
      computeDynamicTarotState(player_b_id, cardB.initialTarotState ?? 'upright'),
    ]);

    // Predicted cooperation rates
    const fateCtxA: FateContext = {
      mbti: cardA.mbti ?? 'INTJ', wuxing: cardA.wuxing ?? '土',
      zodiac: cardA.zodiac ?? 'Aries', tarotName: cardA.tarotName ?? 'The Fool',
      tarotState: tarotStateA, civilization: cardA.civilization ?? 'western',
      opponentFate: { wuxing: cardB.wuxing, zodiac: cardB.zodiac, civilization: cardB.civilization },
    };
    const fateCtxB: FateContext = {
      mbti: cardB.mbti ?? 'INTJ', wuxing: cardB.wuxing ?? '土',
      zodiac: cardB.zodiac ?? 'Aries', tarotName: cardB.tarotName ?? 'The Fool',
      tarotState: tarotStateB, civilization: cardB.civilization ?? 'western',
      opponentFate: { wuxing: cardA.wuxing, zodiac: cardA.zodiac, civilization: cardA.civilization },
    };

    const coopRateA = calculateFateCooperationRate(getArchetypeBaseCoopRate(archetypeA), fateCtxA, fateCtxA.opponentFate);
    const coopRateB = calculateFateCooperationRate(getArchetypeBaseCoopRate(archetypeB), fateCtxB, fateCtxB.opponentFate);

    // Memory/experience between the two
    const [experienceAB, experienceBA] = await Promise.all([
      getOpponentExperienceModifier(player_a_id, player_b_id).catch(() => null),
      getOpponentExperienceModifier(player_b_id, player_a_id).catch(() => null),
    ]);

    res.json({
      match_id: matchId,
      match_type,
      player_a: {
        agent_id: player_a_id,
        name: agentA.rows[0]?.name,
        archetype: archetypeA,
        fate: { mbti: cardA.mbti, wuxing: cardA.wuxing, zodiac: cardA.zodiac, tarot: cardA.tarotName, civilization: cardA.civilization },
        predicted_cooperation: Number(coopRateA.toFixed(3)),
      },
      player_b: {
        agent_id: player_b_id,
        name: agentB.rows[0]?.name,
        archetype: archetypeB,
        fate: { mbti: cardB.mbti, wuxing: cardB.wuxing, zodiac: cardB.zodiac, tarot: cardB.tarotName, civilization: cardB.civilization },
        predicted_cooperation: Number(coopRateB.toFixed(3)),
      },
      relations: {
        wuxing: { relation: wuxingRelation, effects: wuxingMods },
        zodiac: { compatibility: zodiacCompat },
        civilization: { affinity: civAffinity, affinity_label: civAffinity > 5 ? 'strong_ally' : civAffinity > 0 ? 'friendly' : civAffinity > -3 ? 'neutral' : 'tension' },
      },
      experience: {
        a_to_b: experienceAB,
        b_to_a: experienceBA,
      },
    });
  }),
);

/**
 * GET /:agentId/opponent-experience/:opponentId
 * Get structured experience modifier for a specific opponent.
 * Returns cooperationBias, betrayalTraumaCount, totalEncounters, etc.
 */
router.get(
  '/:agentId/opponent-experience/:opponentId',
  asyncHandler(async (req, res) => {
    const experience = await getOpponentExperienceModifier(
      req.params.agentId,
      req.params.opponentId,
    );
    res.json(experience);
  }),
);

/**
 * GET /:agentId/pd-intel-impact/:opponentId
 * Returns the direct PD cooperation delta derived from purchased intel.
 */
router.get(
  '/:agentId/pd-intel-impact/:opponentId',
  asyncHandler(async (req, res) => {
    const result = await getIntelImpactOnPD(
      req.params.agentId,
      req.params.opponentId,
    );
    res.json(result);
  }),
);

/**
 * GET /:agentId/memories
 * Get agent's structured memories (from memory-engine).
 * Query: { type?, limit? }
 */
router.get(
  '/:agentId/memories',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const memoryType = typeof req.query.type === 'string' ? req.query.type : undefined;
    const limit = Math.min(50, Number(req.query.limit) || 20);

    const memories = await getAgentMemories(agentId, limit, memoryType);
    res.json(memories);
  }),
);

/**
 * GET /:agentId/nurture
 * Get agent's full nurture (acquired dimension) profile.
 */
router.get(
  '/:agentId/nurture',
  asyncHandler(async (req, res) => {
    const agentId = req.params.agentId;
    const nurture = await loadNurtureProfileFromDB(agentId);
    if (!nurture) {
      throw new NotFoundError(`No nurture profile found for ${agentId}`);
    }
    res.json({ agent_id: agentId, nurture });
  }),
);

export default router;

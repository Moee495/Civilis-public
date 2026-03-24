import './config/load-env.js';
import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import agentRouter from './agents/agent-manager.js';
import { initTreasury } from './agents/wallet-sync.js';
import arenaRouter from './arena/arena.js';
import negotiationRouter from './arena/negotiation.js';
import { initDB, getPool } from './db/postgres.js';
import fateRouter from './fate/routes.js';
import {
  asyncHandler,
  errorHandler,
  notFoundHandler,
} from './middleware/errorHandler.js';
import marketRouter from './services/market.js';
import { bindRealtimeServer, eventBus } from './realtime.js';
import socialRouter from './social/social-square.js';
import { initCivilisCommerce } from './standards/civilis-commerce.js';
import { initERC8004 } from './standards/erc8004.js';
import worldRouter from './world/routes.js';
import commonsRouter from './commons/commons-api.js';
import predictionRouter from './prediction/prediction-api.js';
import intelV2Router from './intel/intel-routes.js';
import acpRouter from './erc8183/acp-routes.js';
import { startWorldEngine } from './world/tick-engine.js';
import { initOkxTeeWallet } from './onchainos/okx-tee-wallet.js';
import { startSettlementWorker } from './onchainos/settlement-worker.js';
import { initOnchainGateway } from './onchainos/onchain-gateway.js';
import { seedBuiltInAgents } from './scripts/seed-agents.js';
import { getMainnetEpochMeta, pushMainnetEpochStartAtParam } from './config/mainnet-epoch.js';
import {
  getX402PaymentMode,
  getXLayerChainId,
  getXLayerNetwork,
  getXLayerRpcUrl,
  isStrictOnchainMode,
  isX402DirectWalletMode,
  missingRequiredOnchainEnv,
} from './config/xlayer.js';
import { resolveX402ServiceTarget } from './config/x402-service.js';
import { getSoulArchiveMode, isSoulArchiveModeExplicit } from './config/soul-archive.js';

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: '*' },
});

bindRealtimeServer(io);

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : '*',
}));
app.use(express.json({ limit: '100kb' }));

app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = {};
  const bootMode = shouldSkipOnchainBoot() ? 'isolated' : 'full';
  try {
    await getPool().query('SELECT 1');
    checks.database = 'ok';
  } catch { checks.database = 'error'; }

  const acpConfigured = Boolean(process.env.ACP_V2_CONTRACT_ADDRESS || process.env.ACP_CONTRACT_ADDRESS);
  const erc8004Configured = Boolean(
    (process.env.ERC8004_IDENTITY_V2_ADDRESS || process.env.ERC8004_IDENTITY_ADDRESS) &&
    (process.env.ERC8004_REPUTATION_V2_ADDRESS || process.env.ERC8004_REPUTATION_ADDRESS) &&
    (process.env.ERC8004_VALIDATION_V2_ADDRESS || process.env.ERC8004_VALIDATION_ADDRESS),
  );
  const commerceConfigured = Boolean(process.env.CIVILIS_COMMERCE_V2_ADDRESS || process.env.CIVILIS_COMMERCE_ADDRESS);
  const x402Target = resolveX402ServiceTarget();
  const x402Configured = x402Target.kind !== 'missing';
  const paymentMode = getX402PaymentMode();
  const soulArchiveMode = getSoulArchiveMode();

  const resolveConfiguredSurfaceStatus = (configured: boolean): string => {
    if (!configured) {
      return 'mock';
    }

    return bootMode === 'isolated' ? 'configured' : 'live';
  };

  checks.boot = bootMode;
  checks.network = `${getXLayerNetwork()}:${getXLayerChainId()}`;
  checks.mode = isStrictOnchainMode() ? 'strict' : 'compatible';
  checks.rpc = getXLayerRpcUrl();
  checks.protocolInit = bootMode === 'isolated' ? 'skipped_by_isolated_boot' : 'managed_in_boot';
  checks.acp = resolveConfiguredSurfaceStatus(acpConfigured);
  checks.erc8004 = resolveConfiguredSurfaceStatus(erc8004Configured);
  checks.x402 = x402Configured
    ? x402Target.kind === 'contract_address'
      ? bootMode === 'isolated'
        ? paymentMode === 'direct_wallet'
          ? 'direct_wallet_configured'
          : 'configured'
        : paymentMode === 'direct_wallet'
          ? 'direct_wallet'
          : 'live'
      : x402Target.kind === 'service_url'
        ? 'service_url_not_contract'
        : 'invalid_target'
    : 'mock';
  checks.commerce = resolveConfiguredSurfaceStatus(commerceConfigured);
  checks.soul = soulArchiveMode === 'onchain_mint'
    ? 'onchain_archive'
    : isSoulArchiveModeExplicit()
      ? 'archive_hash_only_approved'
      : 'archive_hash_only';

  const allOk = Object.values(checks).every(v => v !== 'error');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    service: 'Civilis Core Server',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    checks,
    readiness: {
      targetX402Network: 'mainnet:196',
      targetX402Mode: 'direct_wallet',
      mainnetCanaryRequired: getXLayerNetwork() !== 'mainnet' || !isX402DirectWalletMode(),
      soulArchiveMode,
      bootMode,
      protocolInitDependency: bootMode === 'isolated'
        ? 'not_required_in_isolated_boot'
        : 'managed_during_full_boot',
      x402TargetKind: x402Target.kind,
    },
  });
});

app.use('/api/social', socialRouter);
app.use('/api/arena', arenaRouter);
app.use('/api/arena', negotiationRouter);
app.use('/api/agents', agentRouter);
app.use('/api/fate', fateRouter);
app.use('/api/world', worldRouter);
app.use('/api/commons', commonsRouter);
app.use('/api/prediction', predictionRouter);
app.use('/api/intel', intelV2Router);
app.use('/api/acp', acpRouter);
app.use('/api', marketRouter);

app.get(
  '/api/stats',
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const params: Array<string | number> = [];
    const createdAtPlaceholder = pushMainnetEpochStartAtParam(params);
    const createdAtWhere = createdAtPlaceholder ? `WHERE created_at >= ${createdAtPlaceholder}` : '';
    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM agents WHERE is_alive = true) AS alive_agents,
         (SELECT COUNT(*) FROM agents WHERE is_alive = false) AS dead_agents,
         (SELECT COUNT(*) FROM posts ${createdAtWhere}) AS total_posts,
         (SELECT COUNT(*) FROM arena_matches ${createdAtWhere}) AS total_matches,
         (SELECT COUNT(*) FROM x402_transactions ${createdAtWhere}) AS total_x402_txns,
         (SELECT COALESCE(SUM(amount), 0) FROM x402_transactions ${createdAtWhere}) AS total_x402_volume,
         GREATEST(
           COALESCE((SELECT MAX(tick_number) FROM economy_state), 0),
           COALESCE((SELECT MAX(tick_number) FROM tick_snapshots), 0)
         ) AS current_tick`,
      params,
    );

    res.json({
      ...stats.rows[0],
      epoch: getMainnetEpochMeta(),
      recentEvents: eventBus.getRecent(10),
    });
  }),
);

io.on('connection', (socket) => {
  console.log(`[WS] client connected: ${socket.id}`);
  socket.emit('welcome', {
    message: 'Connected to Civilis real-time feed',
    version: '3.0.0',
  });

  socket.on('disconnect', () => {
    console.log(`[WS] client disconnected: ${socket.id}`);
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = Number(process.env.PORT || 3001);

function shouldSkipOnchainBoot(): boolean {
  return process.env.CIVILIS_SKIP_ONCHAIN_BOOT === 'true';
}

async function start(): Promise<void> {
  try {
    const missing = missingRequiredOnchainEnv();
    if (missing.length > 0) {
      throw new Error(
        `Strict on-chain mode is enabled but these env vars are missing: ${missing.join(', ')}`,
      );
    }

    await initDB();
    initERC8004();
    initCivilisCommerce();

    if (shouldSkipOnchainBoot()) {
      console.warn('[Boot] CIVILIS_SKIP_ONCHAIN_BOOT=true — skipping treasury, gateway, wallet, and settlement worker startup');
    } else {
      initTreasury();
      initOkxTeeWallet();
      initOnchainGateway();
      startSettlementWorker();
    }

    // Auto-seed the canonical 8 agents if none exist
    const agentCheck = await getPool().query('SELECT COUNT(*) as cnt FROM agents');
    if (Number(agentCheck.rows[0].cnt) === 0) {
      console.log('[Boot] No agents found — seeding 8 canonical agents (8 archetypes × 1)...');
      await seedBuiltInAgents();
    }

    if (process.env.AUTO_START_WORLD !== 'false') {
      startWorldEngine();
    }

    httpServer.listen(PORT, () => {
      console.log(`Civilis Core Server listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('[FATAL] server startup failed:', error);
    process.exit(1);
  }
}

void start();

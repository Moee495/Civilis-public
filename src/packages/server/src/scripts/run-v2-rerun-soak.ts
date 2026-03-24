import '../config/load-env.js';
import { ethers } from 'ethers';
import { getPool, initDB } from '../db/postgres.js';
import { getTreasuryAddress, initTreasury, syncOnchainBalances } from '../agents/wallet-sync.js';
import { initCivilisCommerce } from '../standards/civilis-commerce.js';
import { initERC8004 } from '../standards/erc8004.js';
import { initOkxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { ACP_CONTRACT_ABI } from '../erc8183/acp-abi.js';
import { reputationRegistry } from '../erc8004/reputation-registry.js';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';
import { executeTick, getCurrentTick } from '../world/tick-engine.js';

const COMMERCE_ABI = [
  'function mapBusiness(bytes32 businessRef, uint8 businessType, bytes32 businessSubtype, uint256 jobId)',
  'function closeMapping(bytes32 businessRef, bytes32 statusInfo)',
  'function getBusinessLink(bytes32 businessRef) view returns (tuple(bytes32 businessRef,uint256 jobId,uint8 businessType,bytes32 businessSubtype,uint8 status,bytes32 statusInfo,address mappedBy,uint256 mappedAt,uint256 updatedAt))',
] as const;

const IDENTITY_ABI = [
  'function register(string agentURI) returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
] as const;

const REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
] as const;

const VALIDATION_ABI = [
  'function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)',
  'function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)',
  'function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
] as const;

interface ValidationStatusView {
  validatorAddress: string;
  agentId: bigint;
  response: number;
  responseHash: string;
  tag: string;
  lastUpdate: bigint;
}

let currentPhase = 'boot';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enterPhase(phase: string): void {
  currentPhase = phase;
  console.log(`[BatchKL] phase=${phase}`);
}

function padGasEstimate(estimate: bigint): bigint {
  return estimate + estimate / 5n + 20_000n;
}

function summarizeActiveRuntime(): {
  phase: string;
  handles: Array<Record<string, unknown>>;
  requests: string[];
} {
  const handles = typeof (process as any)._getActiveHandles === 'function'
    ? ((process as any)._getActiveHandles() as any[])
    : [];
  const requests = typeof (process as any)._getActiveRequests === 'function'
    ? ((process as any)._getActiveRequests() as any[])
    : [];

  return {
    phase: currentPhase,
    handles: handles.map((handle) => ({
      type: handle?.constructor?.name ?? typeof handle,
      hasRef: typeof handle?.hasRef === 'function' ? handle.hasRef() : null,
    })),
    requests: requests.map((request) => request?.constructor?.name ?? typeof request),
  };
}

function logActiveRuntime(label: string): void {
  console.error(
    JSON.stringify(
      {
        action: 'batch_kl_runtime_handles',
        label,
        ...summarizeActiveRuntime(),
      },
      null,
      2,
    ),
  );
}

async function withTimeout<T>(
  label: string,
  task: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_after_${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function getValidationStatus(
  validation: ethers.Contract,
  requestHash: string,
): Promise<ValidationStatusView> {
  const status = await validation.getValidationStatus(requestHash);
  return {
    validatorAddress: String(status?.validatorAddress ?? status?.[0] ?? ethers.ZeroAddress),
    agentId: BigInt(status?.agentId ?? status?.[1] ?? 0),
    response: Number(status?.response ?? status?.[2] ?? 0),
    responseHash: String(status?.responseHash ?? status?.[3] ?? ethers.ZeroHash),
    tag: String(status?.tag ?? status?.[4] ?? ''),
    lastUpdate: BigInt(status?.lastUpdate ?? status?.[5] ?? 0),
  };
}

function summarizeDatabaseTarget(databaseUrl: string | undefined): {
  host: string | null;
  database: string | null;
  safetyClass: 'local' | 'staging_like' | 'unknown_remote';
} {
  if (!databaseUrl) {
    return { host: null, database: null, safetyClass: 'unknown_remote' };
  }

  try {
    const parsed = new URL(databaseUrl);
    const database = parsed.pathname.replace(/^\//, '') || null;
    const loweredHost = (parsed.hostname || '').toLowerCase();
    const loweredDatabase = (database || '').toLowerCase();
    const safetyClass =
      loweredHost === 'localhost' || loweredHost === '127.0.0.1'
        ? 'local'
        : loweredHost.includes('test') ||
            loweredHost.includes('staging') ||
            loweredDatabase.includes('test') ||
            loweredDatabase.includes('staging')
          ? 'staging_like'
          : 'unknown_remote';

    return {
      host: parsed.host || null,
      database,
      safetyClass,
    };
  } catch {
    return { host: null, database: null, safetyClass: 'unknown_remote' };
  }
}

async function waitForBudget(
  acp: ethers.Contract,
  jobId: number,
  expectedBudget: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const job = await acp.getJob(jobId);
    if (BigInt(job[4]) === expectedBudget) {
      return;
    }
    await delay(500 * (attempt + 1));
  }

  const finalJob = await acp.getJob(jobId);
  throw new Error(`ACPV2 budget not persisted for job ${jobId}; observed=${String(finalJob[4])}`);
}

async function waitForStatus(
  acp: ethers.Contract,
  jobId: number,
  expectedStatus: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const job = await acp.getJob(jobId);
    if (BigInt(job[6]) === expectedStatus) {
      return;
    }
    await delay(500 * (attempt + 1));
  }

  const finalJob = await acp.getJob(jobId);
  throw new Error(`ACPV2 status not persisted for job ${jobId}; observed=${String(finalJob[6])}`);
}

async function waitForBusinessLink(
  commerce: ethers.Contract,
  businessRef: string,
): Promise<any> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await commerce.getBusinessLink(businessRef);
    } catch {
      await delay(500 * (attempt + 1));
    }
  }

  return await commerce.getBusinessLink(businessRef);
}

async function waitForIdentityToken(
  identity: ethers.Contract,
  tokenId: number,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const owner = String(await identity.ownerOf(tokenId));
      if (owner && owner !== ethers.ZeroAddress) {
        return owner;
      }
    } catch {
      // keep polling until the latest block is visible across RPC backends
    }

    await delay(500 * (attempt + 1));
  }

  return String(await identity.ownerOf(tokenId));
}

async function waitForValidationRequest(
  validation: ethers.Contract,
  requestHash: string,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const status = await getValidationStatus(validation, requestHash);
      if (status.validatorAddress !== ethers.ZeroAddress) {
        return;
      }
    } catch {
      // keep polling until the request is queryable from the RPC endpoint
    }

    await delay(500 * (attempt + 1));
  }

  await getValidationStatus(validation, requestHash);
}

async function waitForNextJobId(
  acp: ethers.Contract,
  priorCount: bigint,
): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const count = BigInt(await acp.getJobCount());
    if (count > priorCount) {
      return Number(count - 1n);
    }
    await delay(500 * (attempt + 1));
  }

  const finalCount = BigInt(await acp.getJobCount());
  throw new Error(`ACPV2 job count did not advance; observed=${finalCount.toString()} prior=${priorCount.toString()}`);
}

async function reconcilePendingSmokeValidations(
  validation: ethers.Contract,
  validatorAddress: string,
): Promise<{ repaired: number; newlyResponded: number; stillMixed: number }> {
  const pool = getPool();
  const pending = await pool.query<{
    id: number;
    request_hash: string;
    sync_state: string | null;
  }>(
    `SELECT id, request_hash, sync_state
     FROM erc8004_validations
     WHERE category IN ('batch_ij_smoke', 'batch_kl_smoke')
       AND sync_state = 'mixed'
       AND on_chain_tx_hash IS NOT NULL
     ORDER BY id ASC`,
  );

  let repaired = 0;
  let newlyResponded = 0;

  for (const row of pending.rows) {
    const status = await getValidationStatus(validation, row.request_hash);

    if (status.response > 0) {
      await pool.query(
        `UPDATE erc8004_validations
         SET status = 'responded',
             response_score = COALESCE(response_score, $1),
             verified_by_count = COALESCE(verified_by_count, 1),
             is_fake = COALESCE(is_fake, false),
             responded_at = COALESCE(responded_at, TO_TIMESTAMP($2)),
             sync_state = 'v2'
         WHERE id = $3`,
        [status.response, Number(status.lastUpdate), row.id],
      );
      repaired += 1;
      continue;
    }

    if (status.validatorAddress.toLowerCase() !== validatorAddress.toLowerCase()) {
      continue;
    }

    const responseHash = ethers.id(`repair_${row.request_hash}`);
    const responseTxHash = await executeRoleWrite(
      'erc8004_validation',
      `erc8004.validationRepair:${row.request_hash}`,
      async (signer) => {
        const connected = validation.connect(signer) as any;
        const gas = await connected.validationResponse.estimateGas(
          row.request_hash,
          92,
          '',
          responseHash,
          'verified',
        );
        const tx = await connected.validationResponse(
          row.request_hash,
          92,
          '',
          responseHash,
          'verified',
          { gasLimit: padGasEstimate(gas) },
        );
        const receipt = await tx.wait();
        return receipt?.hash ?? null;
      },
    );

    await pool.query(
      `UPDATE erc8004_validations
       SET status = 'responded',
           response_score = 92,
           verified_by_count = 1,
           is_fake = false,
           responded_at = NOW(),
           response_tx_hash = $1,
           sync_state = 'v2'
       WHERE id = $2`,
      [responseTxHash, row.id],
    );

    repaired += 1;
    newlyResponded += 1;
  }

  const remaining = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM erc8004_validations
     WHERE category IN ('batch_ij_smoke', 'batch_kl_smoke')
       AND sync_state = 'mixed'`,
  );

  return {
    repaired,
    newlyResponded,
    stillMixed: Number(remaining.rows[0]?.count ?? 0),
  };
}

async function reconcilePendingSmokeFeedback(
  reputation: ethers.Contract,
  clientAddress: string,
): Promise<{ repaired: number; stillMixed: number }> {
  const pool = getPool();
  const pending = await pool.query<{
    id: number;
    agent_erc8004_id: number;
    client_address: string;
    value: number;
    value_decimals: number;
    tag1: string;
    tag2: string;
  }>(
    `SELECT id, agent_erc8004_id, client_address, value, value_decimals, tag1, tag2
     FROM erc8004_feedback
     WHERE tag1 IN ('batch_ij_smoke', 'batch_kl_smoke')
       AND sync_state = 'mixed'
       AND on_chain_tx_hash IS NULL
     ORDER BY id ASC`,
  );

  let repaired = 0;

  for (const row of pending.rows) {
    if (row.client_address.toLowerCase() !== clientAddress.toLowerCase()) {
      continue;
    }

    const summary = await reputation.getSummary(row.agent_erc8004_id, [clientAddress], row.tag1, row.tag2);
    const count = Number(summary?.count ?? summary?.[0] ?? 0);
    if (count > 0) {
      continue;
    }

    const feedbackHash = ethers.id(`repair_feedback_${row.id}`);
    const txHash = await executeRoleWrite(
      'erc8004_reputation',
      `erc8004.giveFeedbackRepair:${row.id}`,
      async (signer) => {
        const connected = reputation.connect(signer) as any;
        const tx = await connected.giveFeedback(
          row.agent_erc8004_id,
          row.value,
          row.value_decimals,
          row.tag1,
          row.tag2,
          'civilis://batch-kl/reputation-repair',
          '',
          feedbackHash,
        );
        const receipt = await tx.wait();
        return receipt?.hash ?? null;
      },
    );

    await pool.query(
      `UPDATE erc8004_feedback
       SET on_chain_tx_hash = $1,
           sync_state = 'v2'
       WHERE id = $2`,
      [txHash, row.id],
    );

    repaired += 1;
  }

  const remaining = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM erc8004_feedback
     WHERE tag1 IN ('batch_ij_smoke', 'batch_kl_smoke')
       AND sync_state = 'mixed'`,
  );

  return {
    repaired,
    stillMixed: Number(remaining.rows[0]?.count ?? 0),
  };
}

async function main(): Promise<void> {
  enterPhase('preflight');
  const network = (process.env.X_LAYER_NETWORK || 'testnet').toLowerCase();
  const databaseTarget = summarizeDatabaseTarget(process.env.DATABASE_URL);

  if (network === 'mainnet') {
    throw new Error('Refusing to run rerun/soak on mainnet');
  }
  if (databaseTarget.safetyClass === 'unknown_remote') {
    throw new Error('Refusing to run rerun/soak against an unknown remote DATABASE_URL target');
  }

  await initDB();
  initTreasury();
  initERC8004();
  initCivilisCommerce();
  initOkxTeeWallet();

  const pool = getPool();
  const startedAt = new Date().toISOString();
  const initialTick = getCurrentTick();
  const errors: string[] = [];

  enterPhase('x402_smoke');
  const x402TxHash = await processX402Payment('post', 'oracle', null, 0.001, {
    reason: 'batch_kl_rerun_smoke',
  });

  const acpAddress = process.env.ACP_V2_CONTRACT_ADDRESS || process.env.ACP_CONTRACT_ADDRESS;
  const usdtAddress = process.env.USDT_ADDRESS;
  const providerAddress = getSharedSignerAddress('commerce');
  const evaluatorAddress = getTreasuryAddress();
  if (!acpAddress || !usdtAddress || !providerAddress || !evaluatorAddress) {
    throw new Error('Missing ACPV2 rerun prerequisites (ACP address / USDT / provider / evaluator)');
  }

  const acp = new ethers.Contract(acpAddress, ACP_CONTRACT_ABI, getSharedProvider());
  const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, getSharedProvider());
  const budgetUnits = ethers.parseUnits('0.010000', 6);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);
  let onChainJobId = -1;
  let fundTxHash: string | null = null;
  let submitTxHash: string | null = null;
  let completeTxHash: string | null = null;

  enterPhase('acpv2_smoke');
  await executeRoleWrite('treasury', 'batch_ij.acpLifecycle', async (signer) => {
    const treasuryAddress = await signer.getAddress();
    const usdtConnected = usdt.connect(signer) as any;
    const allowance = await usdt.allowance(treasuryAddress, acpAddress);
    if (allowance < budgetUnits) {
      await (await usdtConnected.approve(acpAddress, ethers.MaxUint256)).wait();
    }

    const acpConnected = acp.connect(signer) as any;
    const priorCount = BigInt(await acp.getJobCount());
    const createTx = await acpConnected.createJob(
      providerAddress,
      evaluatorAddress,
      expiry,
      'Batch IJ smoke job',
      ethers.ZeroAddress,
    );
    await createTx.wait();
    onChainJobId = await waitForNextJobId(acp, priorCount);

    if (onChainJobId < 0) {
      throw new Error('Failed to resolve ACPV2 job id from JobCreated');
    }

    await (await acpConnected.setBudget(onChainJobId, budgetUnits, '0x')).wait();
    await waitForBudget(acp, onChainJobId, budgetUnits);

    const fundReceipt = await (await acpConnected.fund(onChainJobId, budgetUnits, '0x')).wait();
    fundTxHash = fundReceipt?.hash ?? null;
    await waitForStatus(acp, onChainJobId, 1n);
  });

  const deliverableHash = ethers.id(`batch_ij_deliverable_${Date.now()}`);
  await executeRoleWrite('commerce', 'batch_ij.acpSubmit', async (signer) => {
    const tx = await (acp.connect(signer) as any).submit(onChainJobId, deliverableHash, '0x');
    const receipt = await tx.wait();
    submitTxHash = receipt?.hash ?? null;
    return null;
  });
  await waitForStatus(acp, onChainJobId, 2n);

  const completionReason = ethers.id(`batch_ij_complete_${Date.now()}`);
  await executeRoleWrite('treasury', 'batch_ij.acpComplete', async (signer) => {
    const tx = await (acp.connect(signer) as any).complete(onChainJobId, completionReason, '0x');
    const receipt = await tx.wait();
    completeTxHash = receipt?.hash ?? null;
    return null;
  });
  await waitForStatus(acp, onChainJobId, 3n);

  const insertedJob = await pool.query<{ id: number }>(
    `INSERT INTO acp_jobs
      (on_chain_job_id, category, tx_type, client_agent_id, provider_agent_id, evaluator_address,
       budget, status, hook_address, deliverable_hash, reason_hash, metadata, on_chain_tx_hash,
       funded_at, submitted_at, settled_at, protocol_version, sync_state)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13,
             NOW(), NOW(), NOW(), 'v2', 'v2')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      onChainJobId,
      'arena_match',
      'batch_kl_smoke',
      null,
      null,
      evaluatorAddress,
      '0.010000',
      'completed',
      ethers.ZeroAddress,
      deliverableHash,
      completionReason,
      JSON.stringify({
        batch: 'KL',
        smoke: true,
        execution: 'direct_acpv2_lifecycle',
        submitTxHash,
        completeTxHash,
      }),
      fundTxHash,
    ],
  );
  let localJobId = insertedJob.rows[0]?.id ?? null;
  if (localJobId === null) {
    const existing = await pool.query<{ id: number }>(
      `SELECT id
       FROM acp_jobs
       WHERE protocol_version = 'v2'
         AND on_chain_job_id = $1
       LIMIT 1`,
      [onChainJobId],
    );
    localJobId = existing.rows[0]?.id ?? null;
  }

  const commerceAddress = process.env.CIVILIS_COMMERCE_V2_ADDRESS;
  if (!commerceAddress) {
    throw new Error('Missing CIVILIS_COMMERCE_V2_ADDRESS for rerun');
  }
  const businessRef = ethers.id(`batch_kl_arena_${Date.now()}`);
  const businessSubtype = ethers.encodeBytes32String('smoke').slice(0, 66);
  const statusInfo = ethers.encodeBytes32String('closed').slice(0, 66);
  const commerce = new ethers.Contract(commerceAddress, COMMERCE_ABI, getSharedProvider());
  enterPhase('commerce_mapping_smoke');
  await executeRoleWrite('commerce', `commerce.mapBusiness:${businessRef}`, async (signer) => {
    const connected = commerce.connect(signer) as any;
    const mapGas = await connected.mapBusiness.estimateGas(businessRef, 0, businessSubtype, onChainJobId);
    await (await connected.mapBusiness(
      businessRef,
      0,
      businessSubtype,
      onChainJobId,
      { gasLimit: padGasEstimate(mapGas) },
    )).wait();
    await waitForBusinessLink(commerce, businessRef);
    const closeGas = await connected.closeMapping.estimateGas(businessRef, statusInfo);
    await (await connected.closeMapping(
      businessRef,
      statusInfo,
      { gasLimit: padGasEstimate(closeGas) },
    )).wait();
    return null;
  });
  const businessLink = await waitForBusinessLink(commerce, businessRef);

  const identityAddress = process.env.ERC8004_IDENTITY_V2_ADDRESS;
  const reputationAddress = process.env.ERC8004_REPUTATION_V2_ADDRESS;
  const validationAddress = process.env.ERC8004_VALIDATION_V2_ADDRESS;
  if (!identityAddress || !reputationAddress || !validationAddress) {
    throw new Error('Missing ERC8004 v2 contract addresses for rerun');
  }

  const identity = new ethers.Contract(identityAddress, IDENTITY_ABI, getSharedProvider());
  const reputation = new ethers.Contract(reputationAddress, REPUTATION_ABI, getSharedProvider());
  const identityIface = new ethers.Interface(IDENTITY_ABI);
  const syntheticUri = `civilis://batch-kl/${Date.now()}`;
  let syntheticTokenId = 0;
  let identityTxHash: string | null = null;
  enterPhase('identity_smoke');
  await executeRoleWrite('erc8004_identity', 'erc8004.identitySmoke', async (signer) => {
    const connected = identity.connect(signer) as any;
    const tx = await connected['register(string)'](syntheticUri);
    const receipt = await tx.wait();
    identityTxHash = receipt?.hash ?? null;
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = identityIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'Registered') {
          syntheticTokenId = Number(parsed.args.agentId ?? parsed.args[0]);
          break;
        }
      } catch {
        continue;
      }
    }
    return null;
  });
  if (!syntheticTokenId) {
    throw new Error('Synthetic ERC-8004 identity token was not minted');
  }
  await waitForIdentityToken(identity, syntheticTokenId);

  enterPhase('reputation_reconcile');
  const reputationClientAddress = getSharedSignerAddress('erc8004_reputation') ?? '0x0000000000000000000000000000000000000000';
  const repairedFeedback = await reconcilePendingSmokeFeedback(reputation, reputationClientAddress);
  reputationRegistry.queueFeedback({
    agentId: 'batch-kl-smoke',
    erc8004TokenId: syntheticTokenId,
    value: 88,
    valueDecimals: 0,
    tag1: 'batch_kl_smoke',
    tag2: 'rerun',
    clientAddress: reputationClientAddress,
      endpoint: 'civilis://batch-kl/reputation',
    metadata: {
      syntheticTokenId,
    },
  });
  enterPhase('reputation_smoke');
  const flushedFeedback = await reputationRegistry.flushQueue();
  await pool.query(
    `UPDATE erc8004_feedback
     SET sync_state = CASE
           WHEN on_chain_tx_hash IS NOT NULL THEN 'v2'
           ELSE 'mixed'
         END
     WHERE agent_erc8004_id = $1
       AND tag1 = 'batch_kl_smoke'
       AND tag2 = 'rerun'`,
    [syntheticTokenId],
  );

  const validation = new ethers.Contract(validationAddress, VALIDATION_ABI, getSharedProvider());
  const validatorAddress = getSharedSignerAddress('erc8004_validation');
  if (!validatorAddress) {
    throw new Error('Missing erc8004_validation signer for rerun');
  }
  enterPhase('validation_repair');
  const repairedValidations = await reconcilePendingSmokeValidations(validation, validatorAddress);
  const requestHash = ethers.id(`batch_kl_validation_${syntheticTokenId}`);
  const responseHash = ethers.id(`batch_kl_validation_response_${syntheticTokenId}`);
  let validationRequestTxHash: string | null = null;
  let validationResponseTxHash: string | null = null;
  let validationRequestSucceeded = false;
  let validationResponseSucceeded = false;

  try {
    enterPhase('validation_request_smoke');
    await withTimeout(
      'erc8004.validationRequestSmoke',
      executeRoleWrite('erc8004_identity', 'erc8004.validationRequestSmoke', async (signer) => {
        const connected = validation.connect(signer) as any;
        const tx = await connected.validationRequest(
          validatorAddress,
          syntheticTokenId,
          `civilis://batch-kl/validation/${syntheticTokenId}`,
          requestHash,
        );
        const receipt = await tx.wait();
        validationRequestTxHash = receipt?.hash ?? null;
        return null;
      }),
      20_000,
    );
    validationRequestSucceeded = true;
    await waitForValidationRequest(validation, requestHash);
  } catch (error) {
    logActiveRuntime('validation_request_smoke');
    errors.push(`validation_request:${error instanceof Error ? error.message : String(error)}`);
  }

  if (validationRequestSucceeded) {
    await pool.query(
      `INSERT INTO erc8004_validations
        (request_hash, agent_erc8004_id, intel_item_id, category, status, on_chain_tx_hash, sync_state)
       VALUES ($1, $2, $3, $4, 'pending', $5, 'mixed')
       ON CONFLICT (request_hash) DO NOTHING`,
      [requestHash, syntheticTokenId, -1, 'batch_kl_smoke', validationRequestTxHash],
    );

    try {
      enterPhase('validation_response_smoke');
      await withTimeout(
        'erc8004.validationResponseSmoke',
        executeRoleWrite('erc8004_validation', 'erc8004.validationResponseSmoke', async (signer) => {
          const connected = validation.connect(signer) as any;
          const gas = await connected.validationResponse.estimateGas(
            requestHash,
            92,
            '',
            responseHash,
            'verified',
          );
          const tx = await connected.validationResponse(
            requestHash,
            92,
            '',
            responseHash,
            'verified',
            { gasLimit: padGasEstimate(gas) },
          );
          const receipt = await tx.wait();
          validationResponseTxHash = receipt?.hash ?? null;
          return null;
        }),
        20_000,
      );
      validationResponseSucceeded = true;
    } catch (error) {
      logActiveRuntime('validation_response_smoke');
      errors.push(`validation_response:${error instanceof Error ? error.message : String(error)}`);
    }

    await pool.query(
      `UPDATE erc8004_validations
       SET status = CASE WHEN $1::text IS NULL THEN status ELSE 'responded' END,
           response_score = CASE WHEN $1::text IS NULL THEN response_score ELSE 92 END,
           verified_by_count = CASE WHEN $1::text IS NULL THEN verified_by_count ELSE 1 END,
           is_fake = CASE WHEN $1::text IS NULL THEN is_fake ELSE false END,
           responded_at = CASE WHEN $1::text IS NULL THEN responded_at ELSE NOW() END,
           response_tx_hash = COALESCE($1, response_tx_hash),
           sync_state = CASE WHEN $1::text IS NULL THEN 'mixed' ELSE 'v2' END
       WHERE request_hash = $2`,
      [validationResponseTxHash, requestHash],
    );
  }

  const soakStarted = Date.now();
  let ticksAttempted = 0;
  let ticksCompleted = 0;
  enterPhase('bounded_soak');
  for (let i = 0; i < 5; i++) {
    ticksAttempted += 1;
    try {
      await withTimeout(`world_tick_${i + 1}`, executeTick(), 45_000);
      ticksCompleted += 1;
    } catch (error) {
      logActiveRuntime(`world_tick_${i + 1}`);
      errors.push(error instanceof Error ? error.message : String(error));
    }
    await delay(1000);
  }
  const soakDurationMs = Date.now() - soakStarted;

  try {
    enterPhase('sync_onchain_balances');
    await withTimeout('syncOnchainBalances', syncOnchainBalances(), 10_000);
  } catch (error) {
    logActiveRuntime('sync_onchain_balances');
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const markerCoverage = await Promise.all([
    pool.query<{ unmarked: string }>(
      `SELECT COUNT(*)::text AS unmarked
       FROM acp_jobs
       WHERE protocol_version IS NULL OR sync_state IS NULL`,
    ),
    pool.query<{ unmarked: string }>(
      `SELECT COUNT(*)::text AS unmarked
       FROM agents
       WHERE erc8004_registration_mode IS NULL`,
    ),
    pool.query<{ unmarked: string }>(
      `SELECT COUNT(*)::text AS unmarked
       FROM erc8004_feedback
       WHERE sync_state IS NULL`,
    ),
    pool.query<{ unmarked: string }>(
      `SELECT COUNT(*)::text AS unmarked
       FROM erc8004_validations
       WHERE sync_state IS NULL`,
    ),
  ]);

  console.log(JSON.stringify({
    action: 'batch_kl_rerun_soak',
    startedAt,
    network,
    databaseTarget,
    phase: currentPhase,
    x402: {
      executed: true,
      txHash: x402TxHash?.txHash ?? null,
    },
    acp: {
      localId: localJobId,
      onChainJobId,
      fundTxHash,
      submitTxHash,
      completeTxHash,
      finalStatus: 'completed',
    },
    commerce: {
      businessRef,
      jobId: Number(businessLink.jobId ?? businessLink[1] ?? 0),
      status: Number(businessLink.status ?? businessLink[4] ?? 0),
    },
    identity: {
      tokenId: syntheticTokenId,
      txHash: identityTxHash,
      mode: 'v2_onchain_smoke',
    },
    reputation: {
      repairedPendingFeedback: repairedFeedback,
      flushedFeedback,
      clientAddress: reputationClientAddress,
      tag1: 'batch_kl_smoke',
      tag2: 'rerun',
    },
    validation: {
      repairedPending: repairedValidations,
      requestHash,
      requestTxHash: validationRequestTxHash,
      responseTxHash: validationResponseTxHash,
      responseScore: 92,
      requestSucceeded: validationRequestSucceeded,
      responseSucceeded: validationResponseSucceeded,
    },
    soak: {
      durationMs: soakDurationMs,
      ticksAttempted,
      ticksCompleted,
      initialTick,
      finalTick: getCurrentTick(),
      crash: false,
      errors,
    },
    markerCoverage: {
      acpJobsUnmarked: markerCoverage[0].rows[0]?.unmarked ?? '0',
      agentsUnmarked: markerCoverage[1].rows[0]?.unmarked ?? '0',
      feedbackUnmarked: markerCoverage[2].rows[0]?.unmarked ?? '0',
      validationsUnmarked: markerCoverage[3].rows[0]?.unmarked ?? '0',
    },
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  logActiveRuntime('fatal');
  console.error(error);
  process.exit(1);
});

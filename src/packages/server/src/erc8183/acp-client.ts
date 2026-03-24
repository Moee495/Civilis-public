/**
 * ERC-8183 ACP Client — Agentic Commerce Protocol for Civilis
 *
 * Wraps on-chain ACP contract calls with strict/unsafe-mode aware behavior.
 * Dual-write: every job is recorded both on-chain AND in local DB.
 *
 * XLayer Official: "With lower gas fees and an ecosystem support to bring
 * more agents onchain, the infrastructure for scalable agent-to-agent
 * transactions is already in motion." — @XLayerOfficial
 */

import { ethers, Contract } from 'ethers';
import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { ACP_CONTRACT_ABI } from './acp-abi.js';
import {
  type ACPAddressSource,
  type ACPCategory,
  type ACPConfig,
  type ACPJobRow,
  type ACPProtocolDescriptor,
  ACPHookType,
  JobStatus,
  JOB_STATUS_LABEL,
} from './acp-types.js';
import {
  formatOnchainError,
  getXLayerRpcUrl,
  isStrictOnchainMode,
} from '../config/xlayer.js';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSigner,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';
import {
  getAgentWalletExecutionContext,
  getAgentWalletAddressStrict,
  getTreasuryAddress,
} from '../agents/wallet-sync.js';
import { okxTeeWallet } from '../onchainos/okx-tee-wallet.js';

/* ── Singleton ── */
let instance: ACPClient | null = null;

export function getACPClient(): ACPClient {
  if (!instance) {
    instance = new ACPClient();
  }
  return instance;
}

/* ── Address helpers ── */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const acpInterface = new ethers.Interface(ACP_CONTRACT_ABI);
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

function resolveACPContractAddress(): {
  address: string | null;
  source: ACPAddressSource;
} {
  if (process.env.ACP_V2_CONTRACT_ADDRESS) {
    return { address: process.env.ACP_V2_CONTRACT_ADDRESS, source: 'v2_env' };
  }
  if (process.env.ACP_CONTRACT_ADDRESS) {
    return { address: process.env.ACP_CONTRACT_ADDRESS, source: 'legacy_env_alias' };
  }
  return { address: null, source: 'unset' };
}

function treasuryAddress(): string {
  return getTreasuryAddress();
}

function parseTokenConfigUnits(raw: string | undefined, decimals: number, fallback: string): bigint {
  return ethers.parseUnits((raw && raw.trim()) || fallback, decimals);
}

function formatTokenUnits(value: bigint, decimals: number): string {
  return ethers.formatUnits(value, decimals);
}

function shouldRetryACPStage(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('array_range_error(50)') ||
    message.includes('panic due to array_range_error') ||
    message.includes('invalid status') ||
    message.includes('missing revert data')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLocalJobStatus(status: string | null | undefined): string | null {
  if (!status) {
    return null;
  }

  const value = status.toLowerCase();
  return value in JOB_STATUS_LABEL ? value : value;
}

function extractJobCreatedId(
  receipt: ethers.TransactionReceipt | null,
  contractAddress: string,
): number | null {
  if (!receipt) {
    return null;
  }

  const normalized = contractAddress.toLowerCase();

  for (const log of receipt.logs) {
    if ((log.address ?? '').toLowerCase() !== normalized) {
      continue;
    }

    try {
      const parsed = acpInterface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });

      if (parsed?.name !== 'JobCreated') {
        continue;
      }

      const jobId = Number(parsed.args?.jobId ?? parsed.args?.[0] ?? NaN);
      if (Number.isFinite(jobId) && jobId >= 0) {
        return jobId;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function waitForNextJobId(
  contract: Contract,
  priorCount: bigint,
): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const count = BigInt(await contract.getJobCount());
    if (count > priorCount) {
      return Number(count - 1n);
    }
    await sleep(500 * (attempt + 1));
  }

  const finalCount = BigInt(await contract.getJobCount());
  throw new Error(`ACPV2 job count did not advance; observed=${finalCount.toString()} prior=${priorCount.toString()}`);
}

/* ── ACP Client ── */
export class ACPClient {
  private contract: Contract | null = null;
  private provider: ethers.JsonRpcProvider | null = null;
  private signer: ethers.NonceManager | null = null;
  private config: ACPConfig | null = null;
  private initialized = false;
  private mockJobCounter = 100_000;

  constructor() {
    this.initialize();
  }

  /* ─────────── Initialization ─────────── */

  private initialize(): void {
    try {
      const contractAddress = process.env.ACP_CONTRACT_ADDRESS;
      const rpcUrl = getXLayerRpcUrl();
      const strict = isStrictOnchainMode();
      const resolved = resolveACPContractAddress();

      if (!resolved.address) {
        const error = new Error('[ACP] Missing ACP_V2_CONTRACT_ADDRESS (or ACP_CONTRACT_ADDRESS alias)');
        if (strict) {
          throw error;
        }

        console.warn(`${error.message} — running in mock mode`);
        this.initialized = false;
        return;
      }

      this.provider = getSharedProvider();
      this.signer = getSharedSigner('acp');
      const signerAddress = getSharedSignerAddress('acp');
      if (!this.signer || !signerAddress) {
        throw new Error('[ACP] ACP signer is unavailable');
      }
      this.contract = new ethers.Contract(resolved.address, ACP_CONTRACT_ABI, this.signer);

      this.config = {
        contractAddress: resolved.address,
        evaluatorAddress: signerAddress,
        hookAddresses: {
          [ACPHookType.Arena]: process.env.ACP_HOOK_ARENA || ZERO_ADDRESS,
          [ACPHookType.Prediction]: process.env.ACP_HOOK_PREDICTION || ZERO_ADDRESS,
          [ACPHookType.Commons]: process.env.ACP_HOOK_COMMONS || ZERO_ADDRESS,
          [ACPHookType.Intel]: process.env.ACP_HOOK_INTEL || ZERO_ADDRESS,
          [ACPHookType.SplitPayment]: process.env.ACP_HOOK_SPLIT || ZERO_ADDRESS,
        },
        defaultExpirySeconds: 600, // 10 minutes
        paymentToken: null,
        addressSource: resolved.source,
      };

      this.initialized = true;
      console.log(
        `[ACP] Initialized on ${rpcUrl} — contract ${resolved.address.slice(0, 10)}... (${resolved.source})`,
      );
    } catch (err) {
      if (isStrictOnchainMode()) {
        throw formatOnchainError('ACP init failed', err);
      }

      console.warn('[ACP] Init failed, mock mode:', err);
      this.initialized = false;
    }
  }

  isConfigured(): boolean {
    return this.initialized && !!this.contract;
  }

  async getProtocolDescriptor(): Promise<ACPProtocolDescriptor> {
    const resolved = resolveACPContractAddress();
    let paymentToken: string | null = null;
    const notes: string[] = [];

    if (this.isConfigured()) {
      try {
        paymentToken = await this.contract!.paymentToken();
      } catch (error) {
        notes.push(`paymentToken_read_failed:${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (resolved.source === 'legacy_env_alias') {
      notes.push('configured_via_legacy_env_alias');
    }

    if (resolved.source === 'legacy_env_alias') {
      notes.push('address_comes_from_ACP_CONTRACT_ADDRESS_alias');
    }

    return {
      surface: this.isConfigured() ? 'v2' : 'mock',
      configured: this.isConfigured(),
      contractAddress: resolved.address,
      addressSource: resolved.source,
      paymentToken,
      hookMode: 'optional',
      writeSemantics: this.isConfigured() ? 'erc8183_v2' : 'mock',
      notes,
    };
  }

  private async waitForAgentWalletReceipt(txHash: string, label: string): Promise<ethers.TransactionReceipt> {
    const receipt = await this.provider!.waitForTransaction(txHash, 1, 120_000);
    if (!receipt) {
      throw new Error(`[ACP] Timed out waiting for ${label} tx ${txHash}`);
    }
    if (receipt.status !== 1) {
      throw new Error(`[ACP] ${label} tx ${txHash} failed on-chain`);
    }
    return receipt;
  }

  private async runAgentWalletContractCall(
    teeKeyRef: string,
    to: string,
    data: string,
    value: string,
    label: string,
  ): Promise<ethers.TransactionReceipt> {
    const submitted = await okxTeeWallet.signTransaction(teeKeyRef, to, data, value);
    return this.waitForAgentWalletReceipt(submitted.txHash, label);
  }

  private async ensureACPSignerLiquidity(
    paymentTokenAddress: string,
    requiredBudgetUnits: bigint,
    contextLabel: string,
  ): Promise<void> {
    if (!this.provider || !this.config?.evaluatorAddress) {
      return;
    }

    const acpSignerAddress = this.config.evaluatorAddress;
    const treasurySignerAddress = getSharedSignerAddress('treasury');
    if (!treasurySignerAddress) {
      throw new Error('[ACP] Treasury signer is unavailable for ACP liquidity top-up');
    }

    const tokenReader = new ethers.Contract(paymentTokenAddress, ERC20_ABI, this.provider);
    const [decimals, symbol] = await Promise.all([
      tokenReader.decimals().then((value: number | bigint) => Number(value)).catch(() => 6),
      tokenReader.symbol().catch(() => 'TOKEN'),
    ]);

    const minLiquidityUnits = parseTokenConfigUnits(
      process.env.ACP_SIGNER_MIN_LIQUIDITY,
      decimals,
      '3',
    );
    const topupBufferUnits = parseTokenConfigUnits(
      process.env.ACP_SIGNER_TOPUP_BUFFER,
      decimals,
      '0.25',
    );
    const targetUnits = requiredBudgetUnits + topupBufferUnits > minLiquidityUnits
      ? requiredBudgetUnits + topupBufferUnits
      : minLiquidityUnits;

    const currentBalance = await tokenReader.balanceOf(acpSignerAddress);
    if (currentBalance >= targetUnits) {
      return;
    }

    const deficitUnits = targetUnits - currentBalance;
    const treasuryBalance = await tokenReader.balanceOf(treasurySignerAddress);
    if (treasuryBalance < deficitUnits) {
      throw new Error(
        `[ACP] Treasury ${symbol} balance ${formatTokenUnits(treasuryBalance, decimals)} is below required ACP top-up ${formatTokenUnits(deficitUnits, decimals)}`,
      );
    }

    await executeRoleWrite('treasury', `acp.topup:${contextLabel}`, async (treasurySigner) => {
      const treasuryToken = new ethers.Contract(paymentTokenAddress, ERC20_ABI, treasurySigner);
      const [latestAcpBalance, latestTreasuryBalance] = await Promise.all([
        treasuryToken.balanceOf(acpSignerAddress),
        treasuryToken.balanceOf(treasurySignerAddress),
      ]);

      if (latestAcpBalance >= targetUnits) {
        return;
      }

      const latestDeficitUnits = targetUnits - latestAcpBalance;
      if (latestTreasuryBalance < latestDeficitUnits) {
        throw new Error(
          `[ACP] Treasury ${symbol} balance ${formatTokenUnits(latestTreasuryBalance, decimals)} is below required ACP top-up ${formatTokenUnits(latestDeficitUnits, decimals)}`,
        );
      }

      const transferTx = await treasuryToken.transfer(acpSignerAddress, latestDeficitUnits);
      await transferTx.wait();

      console.log(
        `[ACP] Treasury topped up ACP signer by ${formatTokenUnits(latestDeficitUnits, decimals)} ${symbol} for ${contextLabel}`,
      );
    });
  }

  private async ensureACPSignerAllowance(
    paymentTokenAddress: string,
    spenderAddress: string,
    requiredBudgetUnits: bigint,
    signer: ethers.NonceManager,
    contextLabel: string,
  ): Promise<void> {
    if (!this.config?.evaluatorAddress) {
      return;
    }

    const token = new ethers.Contract(paymentTokenAddress, ERC20_ABI, signer);
    const [decimals, symbol, currentAllowance] = await Promise.all([
      token.decimals().then((value: number | bigint) => Number(value)).catch(() => 6),
      token.symbol().catch(() => 'TOKEN'),
      token.allowance(this.config.evaluatorAddress, spenderAddress),
    ]);

    const minAllowanceUnits = parseTokenConfigUnits(
      process.env.ACP_SIGNER_MIN_ALLOWANCE,
      decimals,
      '25',
    );
    const targetAllowanceUnits = requiredBudgetUnits > minAllowanceUnits
      ? requiredBudgetUnits
      : minAllowanceUnits;

    if (currentAllowance >= targetAllowanceUnits) {
      return;
    }

    if (currentAllowance > 0n) {
      const resetTx = await token.approve(spenderAddress, 0);
      await resetTx.wait();
    }

    const approveTx = await token.approve(spenderAddress, ethers.MaxUint256);
    await approveTx.wait();

    console.log(
      `[ACP] ACP signer approved ${spenderAddress.slice(0, 10)}... for ${symbol} during ${contextLabel}; minimum required ${formatTokenUnits(targetAllowanceUnits, decimals)} ${symbol}`,
    );
  }

  private async ensureAgentWalletAllowance(
    teeKeyRef: string,
    ownerAddress: string,
    paymentTokenAddress: string,
    spenderAddress: string,
    requiredBudgetUnits: bigint,
    contextLabel: string,
  ): Promise<void> {
    if (!this.provider) {
      throw new Error('[ACP] provider unavailable for agent allowance check');
    }

    const tokenReader = new ethers.Contract(paymentTokenAddress, ERC20_ABI, this.provider);
    const [decimals, symbol, currentAllowance] = await Promise.all([
      tokenReader.decimals().then((value: number | bigint) => Number(value)).catch(() => 6),
      tokenReader.symbol().catch(() => 'TOKEN'),
      tokenReader.allowance(ownerAddress, spenderAddress),
    ]);

    const minAllowanceUnits = parseTokenConfigUnits(
      process.env.ACP_AGENT_MIN_ALLOWANCE,
      decimals,
      '25',
    );
    const targetAllowanceUnits = requiredBudgetUnits > minAllowanceUnits
      ? requiredBudgetUnits
      : minAllowanceUnits;

    if (currentAllowance >= targetAllowanceUnits) {
      return;
    }

    const tokenIface = new ethers.Interface(ERC20_ABI);
    if (currentAllowance > 0n) {
      const resetCalldata = tokenIface.encodeFunctionData('approve', [spenderAddress, 0n]);
      await this.runAgentWalletContractCall(
        teeKeyRef,
        paymentTokenAddress,
        resetCalldata,
        '0',
        `erc20.approve.reset:${contextLabel}`,
      );
    }

    const approveCalldata = tokenIface.encodeFunctionData('approve', [spenderAddress, ethers.MaxUint256]);
    await this.runAgentWalletContractCall(
      teeKeyRef,
      paymentTokenAddress,
      approveCalldata,
      '0',
      `erc20.approve.max:${contextLabel}`,
    );

    const refreshedAllowance = await tokenReader.allowance(ownerAddress, spenderAddress);
    if (refreshedAllowance < targetAllowanceUnits) {
      throw new Error(
        `[ACP] Agent wallet allowance for ${symbol} is still below required amount after approve during ${contextLabel}`,
      );
    }
  }

  private async runJobStageWithRetry<T>(
    label: string,
    jobId: number,
    task: () => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 4;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (!shouldRetryACPStage(error) || attempt === maxAttempts) {
          throw error;
        }

        const delayMs = attempt * 750;
        console.warn(
          `[ACP] ${label} for job #${jobId} failed on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`[ACP] ${label} failed for job #${jobId}`);
  }

  private async getOnChainJobStatus(onChainJobId: number): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const job = await this.contract!.getJob(onChainJobId);
    const rawStatus = Number(job?.[6] ?? NaN);
    if (!Number.isFinite(rawStatus) || !(rawStatus in JOB_STATUS_LABEL)) {
      return null;
    }

    return JOB_STATUS_LABEL[rawStatus as JobStatus];
  }

  private async reconcileLocalJobStatus(localId: number, row: ACPJobRow): Promise<ACPJobRow> {
    const normalizedLocal = normalizeLocalJobStatus(row.status);
    const onChainStatus = await this.getOnChainJobStatus(row.on_chain_job_id);

    if (!onChainStatus || onChainStatus === normalizedLocal) {
      return row;
    }

    const pool = getPool();
    const submittedAt =
      onChainStatus === 'submitted' || onChainStatus === 'completed'
        ? row.submitted_at ?? new Date().toISOString()
        : row.submitted_at;
    const settledAt =
      onChainStatus === 'completed' || onChainStatus === 'rejected' || onChainStatus === 'expired'
        ? row.settled_at ?? new Date().toISOString()
        : row.settled_at;

    const updated = await pool.query<ACPJobRow>(
      `UPDATE acp_jobs
       SET status = $1,
           submitted_at = CASE
             WHEN $2::timestamptz IS NULL THEN submitted_at
             ELSE COALESCE(submitted_at, $2::timestamptz)
           END,
           settled_at = CASE
             WHEN $3::timestamptz IS NULL THEN settled_at
             ELSE COALESCE(settled_at, $3::timestamptz)
           END
       WHERE id = $4
       RETURNING *`,
      [onChainStatus, submittedAt, settledAt, localId],
    );

    const nextRow = updated.rows[0] ?? row;
    eventBus.emit('acp_job', {
      action: 'status_reconciled',
      localId,
      onChainJobId: row.on_chain_job_id,
      fromStatus: row.status,
      toStatus: nextRow.status,
    });
    return nextRow;
  }

  /* ─────────── Core Job Lifecycle ─────────── */

  /**
   * Create + Fund + record a new ACP job.
   * Returns the local DB row id and on-chain job id.
   */
  async createAndFundJob(params: {
    category: ACPCategory;
    txType: string;
    clientAgentId: string | null;
    providerAgentId: string | null;
    budget: number;
    description: string;
    hook?: ACPHookType;
    expirySeconds?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ localId: number; onChainJobId: number; txHash: string | null }> {
    const {
      category, txType, clientAgentId, providerAgentId,
      budget, description, hook, expirySeconds, metadata,
    } = params;

    const [clientAddr, providerAddr] = await Promise.all([
      clientAgentId ? getAgentWalletAddressStrict(clientAgentId) : Promise.resolve(treasuryAddress()),
      providerAgentId ? getAgentWalletAddressStrict(providerAgentId) : Promise.resolve(treasuryAddress()),
    ]);
    const evaluatorAddr = this.config?.evaluatorAddress ?? ZERO_ADDRESS;
    const hookAddr = hook ? (this.config?.hookAddresses[hook] ?? ZERO_ADDRESS) : ZERO_ADDRESS;
    const expiry = Math.floor(Date.now() / 1000) + (expirySeconds ?? this.config?.defaultExpirySeconds ?? 600);
    const budgetUnits = ethers.parseUnits(budget.toFixed(6), 6);
    const contractAddress = this.config?.contractAddress ?? '';

    let onChainJobId: number | null = null;
    let txHash: string | null = null;
    let onChainClientAddress = clientAddr;
    let onChainProviderAddress = providerAddr;
    const protocol = await this.getProtocolDescriptor();
    const strict = isStrictOnchainMode();

    /* ── On-chain call (or mock) ── */
    if (this.isConfigured()) {
      try {
        await executeRoleWrite('acp', `acp.createAndFund:${txType}`, async (signer) => {
          const connected = this.contract!.connect(signer) as Contract;
          const paymentTokenAddress = await connected.paymentToken();
          await this.ensureACPSignerLiquidity(paymentTokenAddress, budgetUnits, txType);
          await this.ensureACPSignerAllowance(paymentTokenAddress, contractAddress, budgetUnits, signer, txType);

          const tx = await connected.createJob(
            providerAddr,
            evaluatorAddr,
            expiry,
            description,
            hookAddr,
          );
          const receipt = await tx.wait();
          onChainJobId = extractJobCreatedId(receipt, contractAddress);
          if (onChainJobId === null) {
            if (strict) {
              throw new Error(`[ACP] JobCreated log missing for ${txType}`);
            }
            onChainJobId = Number(await this.contract!.getJobCount()) - 1;
            console.warn(
              `[ACP] JobCreated log missing for ${txType}; falling back to getJobCount()-1 = ${onChainJobId}`,
            );
          }

          await this.runJobStageWithRetry('setBudget', onChainJobId, async () => {
            const budgetTx = await connected.setBudget(
              onChainJobId,
              budgetUnits,
              '0x',
            );
            await budgetTx.wait();
          });

          const fundReceipt = await this.runJobStageWithRetry('fund', onChainJobId, async () => {
            const fundTx = await connected.fund(onChainJobId, budgetUnits, '0x');
            return await fundTx.wait();
          });
          txHash = fundReceipt?.hash ?? receipt?.hash ?? null;
        });
      } catch (err) {
        if (strict) {
          throw formatOnchainError('ACP createAndFundJob failed', err);
        }

        console.warn('[ACP] On-chain createJob failed, using mock:', err);
        onChainJobId = this.mockJobCounter++;
      }
    } else {
      if (strict) {
        throw new Error('[ACP] createAndFundJob called without on-chain ACP configuration');
      }

      onChainJobId = this.mockJobCounter++;
    }

    if (onChainJobId === null) {
      if (strict) {
        throw new Error('[ACP] createAndFundJob finished without on-chain job id');
      }
      onChainJobId = this.mockJobCounter++;
    }

    /* ── Local DB cache ── */
    const pool = getPool();
    const row = await pool.query<{ id: number }>(
      `INSERT INTO acp_jobs
        (on_chain_job_id, category, tx_type, client_agent_id, provider_agent_id,
         evaluator_address, budget, status, hook_address, metadata, on_chain_tx_hash, funded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       RETURNING id`,
      [
        onChainJobId, category, txType,
         clientAgentId, providerAgentId,
         evaluatorAddr, budget.toFixed(6),
         'funded', hookAddr,
          JSON.stringify({
            ...(metadata ?? {}),
            clientAddress: clientAddr,
            providerAddress: providerAddr,
            onChainClientAddress,
            onChainProviderAddress,
            onChainProtocolVersion: protocol.surface,
            onChainAddressSource: protocol.addressSource,
            onChainBudgetUnits: budgetUnits.toString(),
            onChainPaymentToken: protocol.paymentToken,
          }),
          txHash,
        ],
      );

    eventBus.emit('acp_job', {
      action: 'created_and_funded',
      localId: row.rows[0].id,
      onChainJobId,
      category,
      txType,
      client: clientAgentId,
      provider: providerAgentId,
      budget,
    });

    return { localId: row.rows[0].id, onChainJobId, txHash };
  }

  /**
   * Create + fund a new ACP job using the buyer's own agent wallet as client.
   * This path is intended for real funded flows where ERC-8183 escrow is the
   * payment rail, not just a record-only anchor.
   */
  async createAndFundJobWithAgentWallets(params: {
    category: ACPCategory;
    txType: string;
    clientAgentId: string;
    providerAgentId: string | null;
    budget: number;
    description: string;
    hook?: ACPHookType;
    expirySeconds?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ localId: number; onChainJobId: number; txHash: string | null }> {
    const {
      category,
      txType,
      clientAgentId,
      providerAgentId,
      budget,
      description,
      hook,
      expirySeconds,
      metadata,
    } = params;

    if (!this.isConfigured() || !this.contract || !this.provider || !this.config?.contractAddress) {
      throw new Error('[ACP] funded agent-wallet path requires live ACP configuration');
    }

    const [clientContext, providerAddr, protocol] = await Promise.all([
      getAgentWalletExecutionContext(clientAgentId),
      providerAgentId ? getAgentWalletAddressStrict(providerAgentId) : Promise.resolve(treasuryAddress()),
      this.getProtocolDescriptor(),
    ]);

    if (!clientContext.teeKeyRef) {
      throw new Error(`[ACP] Agent ${clientAgentId} has no OKX wallet execution context`);
    }

    const evaluatorAddr = this.config.evaluatorAddress ?? ZERO_ADDRESS;
    const hookAddr = hook ? (this.config.hookAddresses[hook] ?? ZERO_ADDRESS) : ZERO_ADDRESS;
    const expiry = Math.floor(Date.now() / 1000) + (expirySeconds ?? this.config.defaultExpirySeconds ?? 600);
    const budgetUnits = ethers.parseUnits(budget.toFixed(6), 6);
    const contractAddress = this.config.contractAddress;
    const paymentTokenAddress = protocol.paymentToken ?? await this.contract.paymentToken();
    const contractReader = new ethers.Contract(contractAddress, ACP_CONTRACT_ABI, this.provider);
    const tokenReader = new ethers.Contract(paymentTokenAddress, ERC20_ABI, this.provider);
    const clientAddress = clientContext.walletAddress;

    const [clientTokenBalance, clientNativeBalance, priorCount] = await Promise.all([
      tokenReader.balanceOf(clientAddress),
      this.provider.getBalance(clientAddress),
      contractReader.getJobCount().then((value: bigint | number) => BigInt(value)),
    ]);

    if (clientTokenBalance < budgetUnits) {
      throw new Error(
        `[ACP] Client wallet ${clientAgentId} balance ${formatTokenUnits(clientTokenBalance, 6)} is below funded budget ${formatTokenUnits(budgetUnits, 6)}`,
      );
    }
    if (clientNativeBalance <= 0n) {
      throw new Error(`[ACP] Client wallet ${clientAgentId} has no native gas for funded ACP flow`);
    }

    const createCalldata = acpInterface.encodeFunctionData('createJob', [
      providerAddr,
      evaluatorAddr,
      expiry,
      description,
      hookAddr,
    ]);
    const createReceipt = await this.runAgentWalletContractCall(
      clientContext.teeKeyRef,
      contractAddress,
      createCalldata,
      '0',
      `acp.createJob:${txType}`,
    );
    const onChainJobId =
      extractJobCreatedId(createReceipt, contractAddress) ??
      await waitForNextJobId(contractReader, priorCount);

    const setBudgetCalldata = acpInterface.encodeFunctionData('setBudget', [
      onChainJobId,
      budgetUnits,
      '0x',
    ]);
    await this.runAgentWalletContractCall(
      clientContext.teeKeyRef,
      contractAddress,
      setBudgetCalldata,
      '0',
      `acp.setBudget:${onChainJobId}`,
    );

    await this.ensureAgentWalletAllowance(
      clientContext.teeKeyRef,
      clientAddress,
      paymentTokenAddress,
      contractAddress,
      budgetUnits,
      txType,
    );

    const fundCalldata = acpInterface.encodeFunctionData('fund', [
      onChainJobId,
      budgetUnits,
      '0x',
    ]);
    const fundReceipt = await this.runAgentWalletContractCall(
      clientContext.teeKeyRef,
      contractAddress,
      fundCalldata,
      '0',
      `acp.fund:${onChainJobId}`,
    );
    const txHash = fundReceipt.hash;

    const pool = getPool();
    const row = await pool.query<{ id: number }>(
      `INSERT INTO acp_jobs
        (on_chain_job_id, category, tx_type, client_agent_id, provider_agent_id,
         evaluator_address, budget, status, hook_address, metadata, on_chain_tx_hash, funded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       RETURNING id`,
      [
        onChainJobId,
        category,
        txType,
        clientAgentId,
        providerAgentId,
        evaluatorAddr,
        budget.toFixed(6),
        'funded',
        hookAddr,
        JSON.stringify({
          ...(metadata ?? {}),
          clientAddress,
          providerAddress: providerAddr,
          onChainClientAddress: clientAddress,
          onChainProviderAddress: providerAddr,
          onChainProtocolVersion: protocol.surface,
          onChainAddressSource: protocol.addressSource,
          onChainBudgetUnits: budgetUnits.toString(),
          onChainPaymentToken: paymentTokenAddress,
        }),
        txHash,
      ],
    );

    eventBus.emit('acp_job', {
      action: 'created_and_funded',
      localId: row.rows[0].id,
      onChainJobId,
      category,
      txType,
      client: clientAgentId,
      provider: providerAgentId,
      budget,
    });

    return { localId: row.rows[0].id, onChainJobId, txHash };
  }

  /**
   * Create an OPEN ACP job as a record anchor without escrow funding.
   * This is the correct path for business references that already settle
   * value via x402 or other protocol paths and only need an ACPV2 job id.
   */
  async createOpenJob(params: {
    category: ACPCategory;
    txType: string;
    providerAgentId?: string | null;
    description: string;
    hook?: ACPHookType;
    expirySeconds?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ localId: number; onChainJobId: number; txHash: string | null }> {
    const {
      category,
      txType,
      providerAgentId = null,
      description,
      hook,
      expirySeconds,
      metadata,
    } = params;

    const providerAddr = providerAgentId
      ? await getAgentWalletAddressStrict(providerAgentId)
      : ZERO_ADDRESS;
    const evaluatorAddr = getSharedSignerAddress('treasury') ?? treasuryAddress();
    const hookAddr = hook ? (this.config?.hookAddresses[hook] ?? ZERO_ADDRESS) : ZERO_ADDRESS;
    const expiry = Math.floor(Date.now() / 1000) + (expirySeconds ?? this.config?.defaultExpirySeconds ?? 600);

    let onChainJobId: number | null = null;
    let txHash: string | null = null;
    const protocol = await this.getProtocolDescriptor();
    const strict = isStrictOnchainMode();

    if (this.isConfigured()) {
      try {
        await executeRoleWrite('treasury', `acp.createOpen:${txType}`, async (signer) => {
          const connected = this.contract!.connect(signer) as Contract;
          const priorCount = BigInt(await connected.getJobCount());
          const tx = await connected.createJob(
            providerAddr,
            evaluatorAddr,
            expiry,
            description,
            hookAddr,
          );
          const receipt = await tx.wait();
          onChainJobId = extractJobCreatedId(receipt, this.config?.contractAddress ?? '')
            ?? await waitForNextJobId(connected, priorCount);
          txHash = receipt?.hash ?? tx.hash ?? null;
        });
      } catch (err) {
        if (strict) {
          throw formatOnchainError('ACP createOpenJob failed', err);
        }

        console.warn('[ACP] On-chain createOpenJob failed, using mock:', err);
        onChainJobId = this.mockJobCounter++;
      }
    } else {
      if (strict) {
        throw new Error('[ACP] createOpenJob called without on-chain ACP configuration');
      }

      onChainJobId = this.mockJobCounter++;
    }

    if (onChainJobId === null) {
      if (strict) {
        throw new Error('[ACP] createOpenJob finished without on-chain job id');
      }
      onChainJobId = this.mockJobCounter++;
    }

    const pool = getPool();
    const row = await pool.query<{ id: number }>(
      `INSERT INTO acp_jobs
        (on_chain_job_id, category, tx_type, client_agent_id, provider_agent_id,
         evaluator_address, budget, status, hook_address, metadata, on_chain_tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        onChainJobId,
        category,
        txType,
        null,
        providerAgentId,
        evaluatorAddr,
        '0.000000',
        'open',
        hookAddr,
        JSON.stringify({
          ...(metadata ?? {}),
          recordOnly: true,
          providerAddress: providerAddr,
          evaluatorAddress: evaluatorAddr,
          onChainProtocolVersion: protocol.surface,
          onChainAddressSource: protocol.addressSource,
          onChainPaymentToken: protocol.paymentToken,
        }),
        txHash,
      ],
    );

    eventBus.emit('acp_job', {
      action: 'created',
      localId: row.rows[0].id,
      onChainJobId,
      category,
      txType,
      provider: providerAgentId,
      budget: 0,
    });

    return { localId: row.rows[0].id, onChainJobId, txHash };
  }

  /**
   * Submit work for a job (provider delivers).
   */
  async submitJob(localId: number, deliverableHash: string): Promise<void> {
    const pool = getPool();
    const job = await pool.query<ACPJobRow>('SELECT * FROM acp_jobs WHERE id = $1', [localId]);
    if (!job.rows[0]) throw new Error(`ACP job ${localId} not found`);

    const row = await this.reconcileLocalJobStatus(localId, job.rows[0]);
    if (row.status === 'submitted' || row.status === 'completed') {
      return;
    }
    if (row.status !== 'funded') throw new Error(`Cannot submit job in ${row.status} state`);

    const metadata = ((row.metadata ?? {}) as Record<string, unknown>);
    const isFundedAgentWalletFlow = metadata.acpMode === 'funded_intel_purchase';

    if (this.isConfigured()) {
      try {
        if (isFundedAgentWalletFlow && row.provider_agent_id) {
          const providerContext = await getAgentWalletExecutionContext(row.provider_agent_id);
          if (!providerContext.teeKeyRef) {
            throw new Error(`[ACP] Provider ${row.provider_agent_id} has no OKX wallet execution context`);
          }
          const calldata = acpInterface.encodeFunctionData('submit', [
            row.on_chain_job_id,
            ethers.encodeBytes32String(deliverableHash.slice(0, 31)),
            '0x',
          ]);
          await this.runAgentWalletContractCall(
            providerContext.teeKeyRef,
            this.config!.contractAddress,
            calldata,
            '0',
            `acp.submit:${row.on_chain_job_id}`,
          );
        } else {
          await executeRoleWrite('acp', `acp.submit:${row.on_chain_job_id}`, async () => {
            const tx = await this.contract!.submit(
              row.on_chain_job_id,
              ethers.encodeBytes32String(deliverableHash.slice(0, 31)),
              '0x',
            );
            await tx.wait();
          });
        }
      } catch (err) {
        if (isStrictOnchainMode()) {
          throw formatOnchainError('ACP submit failed', err);
        }

        console.warn('[ACP] On-chain submit failed:', err);
      }
    }

    await pool.query(
      `UPDATE acp_jobs SET status = 'submitted', deliverable_hash = $1, submitted_at = NOW() WHERE id = $2`,
      [deliverableHash, localId],
    );

    eventBus.emit('acp_job', { action: 'submitted', localId, onChainJobId: row.on_chain_job_id });
  }

  /**
   * Complete a job (evaluator approves — releases funds to provider).
   */
  async completeJob(localId: number, reasonHash: string): Promise<void> {
    const pool = getPool();
    const job = await pool.query<ACPJobRow>('SELECT * FROM acp_jobs WHERE id = $1', [localId]);
    if (!job.rows[0]) throw new Error(`ACP job ${localId} not found`);

    const row = await this.reconcileLocalJobStatus(localId, job.rows[0]);
    if (row.status === 'completed') {
      return;
    }
    if (row.status !== 'submitted') {
      throw new Error(`Cannot complete job in ${row.status} state`);
    }

    if (this.isConfigured()) {
      try {
        await executeRoleWrite('acp', `acp.complete:${row.on_chain_job_id}`, async () => {
          const tx = await this.contract!.complete(
            row.on_chain_job_id,
            ethers.encodeBytes32String(reasonHash.slice(0, 31)),
            '0x',
          );
          await tx.wait();
        });
      } catch (err) {
        if (isStrictOnchainMode()) {
          throw formatOnchainError('ACP complete failed', err);
        }

        console.warn('[ACP] On-chain complete failed:', err);
      }
    }

    await pool.query(
      `UPDATE acp_jobs SET status = 'completed', reason_hash = $1, settled_at = NOW() WHERE id = $2`,
      [reasonHash, localId],
    );

    eventBus.emit('acp_job', {
      action: 'completed', localId,
      onChainJobId: row.on_chain_job_id,
      category: row.category,
      provider: row.provider_agent_id,
      budget: row.budget,
    });
  }

  /**
   * Reject a job (evaluator rejects — refunds client).
   */
  async rejectJob(localId: number, reason: string): Promise<void> {
    const pool = getPool();
    const job = await pool.query<ACPJobRow>('SELECT * FROM acp_jobs WHERE id = $1', [localId]);
    if (!job.rows[0]) throw new Error(`ACP job ${localId} not found`);

    const row = job.rows[0];

    if (this.isConfigured()) {
      try {
        await executeRoleWrite('acp', `acp.reject:${row.on_chain_job_id}`, async () => {
          const tx = await this.contract!.reject(
            row.on_chain_job_id,
            ethers.encodeBytes32String(reason.slice(0, 31)),
            '0x',
          );
          await tx.wait();
        });
      } catch (err) {
        if (isStrictOnchainMode()) {
          throw formatOnchainError('ACP reject failed', err);
        }

        console.warn('[ACP] On-chain reject failed:', err);
      }
    }

    await pool.query(
      `UPDATE acp_jobs SET status = 'rejected', reason_hash = $1, settled_at = NOW() WHERE id = $2`,
      [reason, localId],
    );

    eventBus.emit('acp_job', { action: 'rejected', localId, reason });
  }

  /**
   * Claim refund for an expired funded/submitted job.
   * The on-chain kernel remains the source of truth for expiry eligibility.
   */
  async claimRefund(localId: number): Promise<void> {
    const pool = getPool();
    const job = await pool.query<ACPJobRow>('SELECT * FROM acp_jobs WHERE id = $1', [localId]);
    if (!job.rows[0]) throw new Error(`ACP job ${localId} not found`);

    const row = await this.reconcileLocalJobStatus(localId, job.rows[0]);
    if (row.status === 'expired') {
      return;
    }
    if (row.status !== 'funded' && row.status !== 'submitted') {
      throw new Error(`Cannot claim refund in ${row.status} state`);
    }

    if (this.isConfigured()) {
      try {
        await executeRoleWrite('acp', `acp.claimRefund:${row.on_chain_job_id}`, async () => {
          const tx = await this.contract!.claimRefund(row.on_chain_job_id);
          await tx.wait();
        });
      } catch (err) {
        if (isStrictOnchainMode()) {
          throw formatOnchainError('ACP claimRefund failed', err);
        }

        console.warn('[ACP] On-chain claimRefund failed:', err);
      }
    }

    await pool.query(
      `UPDATE acp_jobs SET status = 'expired', settled_at = NOW() WHERE id = $1`,
      [localId],
    );

    eventBus.emit('acp_job', {
      action: 'refunded',
      localId,
      onChainJobId: row.on_chain_job_id,
      category: row.category,
      client: row.client_agent_id,
      budget: row.budget,
    });
  }

  /* ─────────── Convenience: Full Lifecycle in One Call ─────────── */

  /**
   * Instant job: create → fund → submit → complete in one call.
   * For simple transactions (tips, posts, replies) that don't need escrow.
   */
  async instantJob(params: {
    category: ACPCategory;
    txType: string;
    clientAgentId: string | null;
    providerAgentId: string | null;
    budget: number;
    description: string;
    deliverable?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ localId: number; onChainJobId: number }> {
    const { localId, onChainJobId } = await this.createAndFundJob(params);

    const deliverable = params.deliverable ?? `${params.txType}_${Date.now()}`;
    await this.submitJob(localId, deliverable);

    const reason = params.reason ?? 'auto_complete';
    await this.completeJob(localId, reason);

    return { localId, onChainJobId };
  }

  /* ─────────── Query ─────────── */

  async getJobsByCategory(category: ACPCategory, limit = 50): Promise<ACPJobRow[]> {
    const pool = getPool();
    const result = await pool.query<ACPJobRow>(
      `SELECT * FROM acp_jobs WHERE category = $1 ORDER BY created_at DESC LIMIT $2`,
      [category, limit],
    );
    return result.rows;
  }

  async getJobsByAgent(agentId: string, limit = 50): Promise<ACPJobRow[]> {
    const pool = getPool();
    const result = await pool.query<ACPJobRow>(
      `SELECT * FROM acp_jobs
       WHERE client_agent_id = $1 OR provider_agent_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit],
    );
    return result.rows;
  }

  async getJobStats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    byCategory: Record<string, number>;
    totalVolume: number;
    completedCount: number;
    completedVolume: number;
    activeCount: number;
    terminalCount: number;
  }> {
    const pool = getPool();
    const [statusR, catR, overallR] = await Promise.all([
      pool.query<{ status: string; count: string }>(
        'SELECT status, COUNT(*) as count FROM acp_jobs GROUP BY status',
      ),
      pool.query<{ category: string; count: string }>(
        'SELECT category, COUNT(*) as count FROM acp_jobs GROUP BY category',
      ),
      pool.query<{
        total: string;
        volume: string;
        completed_count: string;
        completed_volume: string;
        active_count: string;
        terminal_count: string;
      }>(
        `SELECT
           COUNT(*) as total,
           COALESCE(SUM(budget),0) as volume,
           COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
           COALESCE(SUM(budget) FILTER (WHERE status = 'completed'), 0) as completed_volume,
           COUNT(*) FILTER (WHERE status IN ('open', 'funded', 'submitted')) as active_count,
           COUNT(*) FILTER (WHERE status IN ('completed', 'rejected', 'expired')) as terminal_count
         FROM acp_jobs`,
      ),
    ]);

    const byStatus: Record<string, number> = {};
    for (const r of statusR.rows) byStatus[r.status] = Number(r.count);

    const byCategory: Record<string, number> = {};
    for (const r of catR.rows) byCategory[r.category] = Number(r.count);

    const overall = overallR.rows[0];

    return {
      total: Number(overall?.total ?? 0),
      byStatus,
      byCategory,
      totalVolume: Number(overall?.volume ?? 0),
      completedCount: Number(overall?.completed_count ?? 0),
      completedVolume: Number(overall?.completed_volume ?? 0),
      activeCount: Number(overall?.active_count ?? 0),
      terminalCount: Number(overall?.terminal_count ?? 0),
    };
  }

  /* ─────────── Expiry Check (called from tick engine) ─────────── */

  async checkExpiredJobs(): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE acp_jobs
       SET status = 'expired', settled_at = NOW()
       WHERE status IN ('open', 'funded', 'submitted')
         AND created_at < NOW() - INTERVAL '10 minutes'
       RETURNING id`,
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[ACP] Expired ${result.rowCount} stale jobs`);
    }
    return result.rowCount ?? 0;
  }
}

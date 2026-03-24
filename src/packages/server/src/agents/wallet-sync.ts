import { ethers } from 'ethers';
import { getPool } from '../db/postgres.js';
import { formatOnchainError, isStrictOnchainMode } from '../config/xlayer.js';
import { resolveX402ServiceTarget } from '../config/x402-service.js';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSigner,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';

const X402_ABI = [
  'function processPaymentAmount(address buyer, address seller, uint8 serviceType, uint256 amount) returns (uint256)',
  'function getBalance(address agent) view returns (uint256)',
  'function getPaymentCount() view returns (uint256)',
  'function deposit(uint256 amount)',
  'function depositFor(address agent, uint256 amount)',
] as const;

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
] as const;

let treasurySigner: ethers.NonceManager | null = null;
let treasuryProvider: ethers.JsonRpcProvider | null = null;
let x402Contract: ethers.Contract | null = null;
let usdtContract: ethers.Contract | null = null;

export interface AgentWalletExecutionContext {
  agentId: string;
  walletAddress: string;
  walletProvider: string;
  teeKeyRef: string | null;
  okxAccountId: string | null;
  okxAccountName: string | null;
}

export function initTreasury(): void {
  treasuryProvider = getSharedProvider();
  treasurySigner = getSharedSigner('treasury');
  if (!treasurySigner) {
    if (isStrictOnchainMode()) {
      throw new Error('[Treasury] Shared treasury signer missing in strict mode');
    }
    console.warn('[Treasury] Shared treasury signer missing, mock mode enabled');
    x402Contract = null;
    usdtContract = null;
    return;
  }

  const x402Target = resolveX402ServiceTarget();
  if (x402Target.kind === 'contract_address') {
    const contractAddress = x402Target.contractAddress!;
    x402Contract = new ethers.Contract(
      contractAddress,
      X402_ABI,
      treasurySigner,
    );
  } else {
    if (x402Target.kind === 'service_url' || x402Target.kind === 'invalid') {
      const message =
        x402Target.kind === 'service_url'
          ? '[Treasury] X402_SERVICE_ADDRESS is a URL; on-chain x402 contract binding is disabled'
          : '[Treasury] X402_SERVICE_ADDRESS is not a valid on-chain address; x402 contract binding is disabled';
      if (isStrictOnchainMode()) {
        throw new Error(message);
      }
      console.warn(message);
    }
    x402Contract = null;
  }

  if (process.env.USDT_ADDRESS) {
    usdtContract = new ethers.Contract(
      process.env.USDT_ADDRESS,
      ERC20_ABI,
      treasurySigner,
    );
  } else {
    usdtContract = null;
  }
}

export function getTreasurySigner(): ethers.NonceManager | null {
  return treasurySigner;
}

export function getTreasuryAddress(): string {
  return (
    process.env.TREASURY_ADDRESS ??
    getSharedSignerAddress('treasury') ??
    ethers.ZeroAddress
  );
}

export function isTreasuryConfigured(): boolean {
  return treasurySigner !== null;
}

export function deriveAgentAddress(agentId: string): string {
  return ethers.getAddress(`0x${ethers.id(agentId).slice(-40)}`);
}

export async function treasuryProcessPayment(
  buyerAgentId: string,
  sellerAgentId: string,
  serviceType: number,
  amountUsdt = 0,
): Promise<{ txHash: string; paymentId: number } | null> {
  const contract = x402Contract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Treasury] x402 contract is not configured in strict mode');
    }
    return {
      txHash: `0xmock${Date.now().toString(16).padStart(60, '0')}`,
      paymentId: Math.floor(Math.random() * 1_000_000),
    };
  }

  try {
    return await executeRoleWrite('treasury', 'treasury.processPayment', async () => {
      const buyerAddress = await getAgentWalletAddress(buyerAgentId);
      const sellerAddress = await getAgentWalletAddress(sellerAgentId);
      const tx = await contract.processPaymentAmount(
        buyerAddress,
        sellerAddress,
        serviceType,
        ethers.parseUnits(amountUsdt.toFixed(6), 6),
      );
      const receipt = await tx.wait();
      const paymentCount = await contract.getPaymentCount();
      return {
        txHash: receipt?.hash ?? '',
        paymentId: Number(paymentCount) - 1,
      };
    });
  } catch (error) {
    console.warn('[Treasury] processPayment failed:', error);
    return null;
  }
}

export async function getOnchainBalance(agentId: string): Promise<number | null> {
  if (!x402Contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Treasury] x402 contract is not configured in strict mode');
    }
    return null;
  }

  try {
    const balance = await x402Contract.getBalance(await getAgentWalletAddress(agentId));
    return Number(ethers.formatUnits(balance, 6));
  } catch (error) {
    console.warn(`[Treasury] failed to read onchain balance for ${agentId}:`, error);
    return null;
  }
}

// ─── TEE Wallet Helpers ─────────────────────────────────

export async function getAgentTeeKeyRef(agentId: string): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query<{ ref: string | null }>(
    'SELECT COALESCE(okx_account_id, tee_key_ref) AS ref FROM agents WHERE agent_id = $1',
    [agentId],
  );
  return result.rows[0]?.ref ?? null;
}

export async function getAgentWalletAddress(agentId: string): Promise<string> {
  return getAgentWalletAddressStrict(agentId);
}

export async function getAgentWalletAddressStrict(agentId: string): Promise<string> {
  const pool = getPool();
  const result = await pool.query<{ wallet_address: string | null }>(
    'SELECT wallet_address FROM agents WHERE agent_id = $1',
    [agentId],
  );

  if (result.rows.length === 0) {
    throw new Error(`[Wallet] Agent ${agentId} not found`);
  }

  const walletAddress = result.rows[0]?.wallet_address;
  if (!walletAddress) {
    throw new Error(`[Wallet] Agent ${agentId} has no bound wallet_address`);
  }

  return walletAddress;
}

export async function getAgentWalletExecutionContext(
  agentId: string,
): Promise<AgentWalletExecutionContext> {
  const pool = getPool();
  const result = await pool.query<{
    wallet_address: string | null;
    wallet_provider: string | null;
    tee_key_ref: string | null;
    okx_account_id: string | null;
    okx_account_name: string | null;
  }>(
    `SELECT
       wallet_address,
       wallet_provider,
       tee_key_ref,
       okx_account_id,
       okx_account_name
     FROM agents
     WHERE agent_id = $1`,
    [agentId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Agent ${agentId} not found`);
  }
  if (!row.wallet_address) {
    throw new Error(`Agent ${agentId} has no bound wallet_address`);
  }

  return {
    agentId,
    walletAddress: row.wallet_address,
    walletProvider: row.wallet_provider ?? 'legacy_derived',
    teeKeyRef: row.okx_account_id ?? row.tee_key_ref ?? null,
    okxAccountId: row.okx_account_id ?? null,
    okxAccountName: row.okx_account_name ?? null,
  };
}

export async function getAgentWalletExecutionContextByAddress(
  walletAddress: string,
): Promise<AgentWalletExecutionContext> {
  const normalizedAddress = ethers.getAddress(walletAddress);
  const pool = getPool();
  const result = await pool.query<{
    agent_id: string;
    wallet_address: string | null;
    wallet_provider: string | null;
    tee_key_ref: string | null;
    okx_account_id: string | null;
    okx_account_name: string | null;
  }>(
    `SELECT
       agent_id,
       wallet_address,
       wallet_provider,
       tee_key_ref,
       okx_account_id,
       okx_account_name
     FROM agents
     WHERE LOWER(wallet_address) = LOWER($1)
     LIMIT 1`,
    [normalizedAddress],
  );

  const row = result.rows[0];
  if (!row || !row.wallet_address) {
    throw new Error(`No agent wallet execution context found for ${normalizedAddress}`);
  }

  return {
    agentId: row.agent_id,
    walletAddress: row.wallet_address,
    walletProvider: row.wallet_provider ?? 'legacy_derived',
    teeKeyRef: row.okx_account_id ?? row.tee_key_ref ?? null,
    okxAccountId: row.okx_account_id ?? null,
    okxAccountName: row.okx_account_name ?? null,
  };
}

export async function syncOnchainBalances(): Promise<void> {
  if (!x402Contract) {
    return;
  }

  const pool = getPool();
  const agents = await pool.query<{ agent_id: string }>(
    'SELECT agent_id FROM agents WHERE is_alive = true',
  );

  for (const agent of agents.rows) {
    const balance = await getOnchainBalance(agent.agent_id);
    if (balance === null) {
      continue;
    }

    await pool.query(
      'UPDATE agents SET onchain_balance = $1, last_sync_at = NOW() WHERE agent_id = $2',
      [balance.toFixed(6), agent.agent_id],
    );
  }
}

export async function setAgentOnchainBalanceSnapshot(
  agentId: string,
  balance: number,
): Promise<void> {
  await getPool().query(
    'UPDATE agents SET onchain_balance = $1, last_sync_at = NOW() WHERE agent_id = $2',
    [balance.toFixed(6), agentId],
  );
}

export async function getTreasuryUsdtBalance(): Promise<number | null> {
  if (!usdtContract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Treasury] USDT contract is not configured in strict mode');
    }
    return null;
  }

  try {
    const owner = getTreasuryAddress();
    const balance = await usdtContract.balanceOf(owner);
    return Number(ethers.formatUnits(balance, 6));
  } catch (error) {
    console.warn('[Treasury] failed to read treasury USDT balance:', error);
    return null;
  }
}

async function ensureTreasuryAllowanceDirect(amountUnits: bigint): Promise<void> {
  if (!usdtContract || !x402Contract || !treasurySigner) {
    return;
  }

  const owner = getSharedSignerAddress('treasury');
  if (!owner) {
    return;
  }
  const spender = await x402Contract.getAddress();
  const allowance = await usdtContract.allowance(owner, spender);

  if (allowance >= amountUnits) {
    return;
  }

  const approveTx = await usdtContract.approve(spender, ethers.MaxUint256);
  await approveTx.wait();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const refreshed = await usdtContract.allowance(owner, spender);
    if (refreshed >= amountUnits) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }

  throw new Error(
    `[Treasury] allowance for ${spender} is still below required amount after approve`,
  );
}

export async function creditAgentOnchainBalance(
  agentAddress: string,
  amountUsdt: number,
): Promise<string | null> {
  const contract = x402Contract;
  if (!contract || !treasurySigner) {
    if (isStrictOnchainMode()) {
      throw new Error('[Treasury] x402 credit path is not configured in strict mode');
    }
    return null;
  }

  const amountUnits = ethers.parseUnits(amountUsdt.toFixed(6), 6);
  return executeRoleWrite('treasury', `treasury.depositFor:${agentAddress}`, async () => {
    try {
      await ensureTreasuryAllowanceDirect(amountUnits);
      const tx = await contract.depositFor(agentAddress, amountUnits);
      const receipt = await tx.wait();
      return receipt?.hash ?? null;
    } catch (error) {
      throw formatOnchainError(`treasury depositFor failed for ${agentAddress}`, error);
    }
  });
}

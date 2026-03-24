import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { createXLayerProvider, isStrictOnchainMode } from '../config/xlayer.js';
import { getPool } from '../db/postgres.js';

export type SharedSignerRole =
  | 'deployer'
  | 'treasury'
  | 'commerce'
  | 'acp'
  | 'erc8004_identity'
  | 'erc8004_reputation'
  | 'erc8004_validation'
  | 'soul';

interface SharedSignerContext {
  provider: ethers.JsonRpcProvider;
  signer: ethers.NonceManager;
  address: string;
  queue: Promise<void>;
}

const signerContexts: Partial<Record<SharedSignerRole, SharedSignerContext | null>> = {};
const signerContextsByAddress = new Map<string, SharedSignerContext>();
let sharedProvider: ethers.JsonRpcProvider | null = null;

function getContextLockKey(address: string): string {
  const digest = crypto.createHash('sha256').update(address.toLowerCase()).digest('hex');
  const value = BigInt(`0x${digest.slice(0, 15)}`);
  return value.toString();
}

function getRolePrivateKey(role: SharedSignerRole): string | null {
  const strict = isStrictOnchainMode();
  const key = (() => {
    switch (role) {
      case 'deployer':
        return process.env.DEPLOYER_PRIVATE_KEY;
      case 'treasury':
        return process.env.TREASURY_PRIVATE_KEY;
      case 'commerce':
        return strict
          ? process.env.CIVILIS_COMMERCE_PRIVATE_KEY
          : process.env.CIVILIS_COMMERCE_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
      case 'acp':
        return strict
          ? process.env.ACP_PRIVATE_KEY
          : process.env.ACP_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
      case 'erc8004_identity':
        return strict
          ? process.env.ERC8004_IDENTITY_PRIVATE_KEY
          : process.env.ERC8004_IDENTITY_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
      case 'erc8004_reputation':
        return strict
          ? process.env.ERC8004_REPUTATION_PRIVATE_KEY
          : process.env.ERC8004_REPUTATION_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
      case 'erc8004_validation':
        return strict
          ? process.env.ERC8004_VALIDATION_PRIVATE_KEY
          : process.env.ERC8004_VALIDATION_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
      case 'soul':
        return strict ? process.env.SOUL_PRIVATE_KEY : process.env.SOUL_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
      default:
        return process.env.DEPLOYER_PRIVATE_KEY;
    }
  })();

  if (!key || key.includes('your-')) {
    return null;
  }

  return key;
}

export function getSharedProvider(): ethers.JsonRpcProvider {
  if (!sharedProvider) {
    sharedProvider = createXLayerProvider();
  }

  return sharedProvider;
}

function getOrCreateSignerContext(privateKey: string): SharedSignerContext {
  const normalizedKey = privateKey.trim();
  const address = new ethers.Wallet(normalizedKey).address.toLowerCase();
  const existing = signerContextsByAddress.get(address);
  if (existing) {
    return existing;
  }

  const provider = getSharedProvider();
  const wallet = new ethers.Wallet(normalizedKey, provider);
  const context: SharedSignerContext = {
    provider,
    signer: new ethers.NonceManager(wallet),
    address: wallet.address,
    queue: Promise.resolve(),
  };

  signerContextsByAddress.set(address, context);
  return context;
}

function createSignerContext(role: SharedSignerRole): SharedSignerContext | null {
  const privateKey = getRolePrivateKey(role);
  if (!privateKey) {
    return null;
  }

  return getOrCreateSignerContext(privateKey);
}

function getSignerContext(role: SharedSignerRole): SharedSignerContext | null {
  if (signerContexts[role] !== undefined) {
    return signerContexts[role] ?? null;
  }

  const context = createSignerContext(role);
  signerContexts[role] = context;
  return context;
}

export function getSharedSigner(role: SharedSignerRole): ethers.NonceManager | null {
  return getSignerContext(role)?.signer ?? null;
}

export function getSharedSignerAddress(role: SharedSignerRole): string | null {
  return getSignerContext(role)?.address ?? null;
}

export function getManagedSigner(privateKey: string): ethers.NonceManager {
  return getOrCreateSignerContext(privateKey).signer;
}

export function getManagedSignerAddress(privateKey: string): string {
  return getOrCreateSignerContext(privateKey).address;
}

function isRetryableNonceError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes('nonce too low') ||
    message.includes('nonce expired') ||
    message.includes('already known') ||
    message.includes('replacement fee too low') ||
    message.includes('replacement transaction underpriced') ||
    message.includes('could not coalesce error')
  );
}

async function runQueuedContextWrite<T>(
  context: SharedSignerContext,
  contextLabel: string,
  label: string,
  task: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    try {
      const result = await task();
      context.signer.reset();
      return result;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableNonceError(error);
      attempt += 1;

      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      console.warn(
        `[Onchain:${contextLabel}] ${label} hit nonce conflict, retrying (${attempt}/${maxAttempts - 1})`,
      );
      context.signer.reset();
      await context.provider.getTransactionCount(context.address, 'pending');
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function withCrossProcessSignerLock<T>(
  context: SharedSignerContext,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  const lockKey = getContextLockKey(context.address);

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
  } catch (error) {
    console.warn(`[Onchain:${context.address}] failed to acquire cross-process lock for ${label}:`, error);
    throw error;
  }

  try {
    return await task();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
    } finally {
      client.release();
    }
  }
}

export async function executeRoleWrite<T>(
  role: SharedSignerRole,
  label: string,
  task: (signer: ethers.NonceManager) => Promise<T>,
): Promise<T> {
  const context = getSignerContext(role);
  if (!context) {
    throw new Error(`[Onchain:${role}] signer is not configured for ${label}`);
  }

  const run = context.queue.then(
    () =>
      withCrossProcessSignerLock(context, label, () =>
        runQueuedContextWrite(context, role, label, () => task(context.signer)),
      ),
    () =>
      withCrossProcessSignerLock(context, label, () =>
        runQueuedContextWrite(context, role, label, () => task(context.signer)),
      ),
  );

  context.queue = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

export async function executePrivateKeyWrite<T>(
  privateKey: string,
  label: string,
  task: (signer: ethers.NonceManager) => Promise<T>,
): Promise<T> {
  const context = getOrCreateSignerContext(privateKey);

  const run = context.queue.then(
    () =>
      withCrossProcessSignerLock(context, label, () =>
        runQueuedContextWrite(context, context.address, label, async () => task(context.signer)),
      ),
    () =>
      withCrossProcessSignerLock(context, label, () =>
        runQueuedContextWrite(context, context.address, label, async () => task(context.signer)),
      ),
  );

  context.queue = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

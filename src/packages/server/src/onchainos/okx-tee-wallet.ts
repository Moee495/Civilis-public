/**
 * OKX Agentic Wallet (TEE) adapter
 *
 * Important:
 * - The real OKX path is account/session based. We provision one OKX account
 *   per agent via the `onchainos` CLI, then bind that account ID to the agent.
 * - `tee_key_ref` is kept only as a backward-compatible alias and mirrors
 *   `okx_account_id` when available.
 * - On X Layer testnet we currently use the wallet for real address ownership
 *   and future signing, while x402 contract settlement still runs through the
 *   shared treasury path.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { ethers } from 'ethers';
import * as crypto from 'crypto';
import {
  createXLayerProvider,
  getXLayerChainId,
  isStrictOnchainMode,
} from '../config/xlayer.js';
import { executePrivateKeyWrite } from './shared-signers.js';

const execFileAsync = promisify(execFile);
const CLI_MAX_BUFFER = 1024 * 1024 * 4;
const DEFAULT_ONCHAINOS_BIN = '/Users/kb/.local/bin/onchainos';
const OKX_QUEUE_RETRY_DELAYS_MS = [1200, 2500, 4000] as const;

export interface TeeWalletResult {
  address: string;
  teeKeyRef: string;
  okxAccountId?: string;
  okxAccountName?: string;
  walletProvider?: 'okx_agentic_wallet' | 'local_mock_wallet';
  loginType?: string;
  capabilities?: string[];
  source: 'okx_tee' | 'mock_tee_fallback' | 'mock_tee_local';
}

export interface TeeSignResult {
  txHash: string;
  orderId: string;
}

export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  chainIndex: string;
  payload: {
    signature: string;
    authorization: X402Authorization;
  };
}

export interface X402PaymentRequirements {
  scheme: string;
  chainIndex: string;
  maxAmountRequired: string;
  payTo: string;
  asset?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  outputSchema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface X402PaymentProof {
  provider: 'okx_agentic_wallet' | 'local_mock_wallet';
  headerName: 'PAYMENT-SIGNATURE' | 'X-PAYMENT';
  headerValue: string;
  x402Version: number;
  network: string;
  chainIndex: string;
  amount: string;
  payerAddress: string;
  payeeAddress: string;
  signature: string;
  authorization: X402Authorization;
  paymentPayload: X402PaymentPayload;
  paymentRequirements: X402PaymentRequirements;
  signedAt: string;
}

export interface X402PaymentSignInput {
  amount: string;
  payTo: string;
  asset: string;
  from?: string;
  x402Version?: number;
  network?: string;
  chainIndex?: string | number;
  scheme?: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

interface OkxWalletStatus {
  accountCount: number;
  apiKey: string;
  currentAccountId: string | null;
  currentAccountName: string | null;
  email: string;
  loggedIn: boolean;
  loginType: string | null;
}

interface WalletAddressesResponse {
  xlayer?: Array<{ address?: string; chainIndex?: string; chainName?: string }>;
  evm?: Array<{ address?: string; chainIndex?: string; chainName?: string }>;
}

interface OkxCliEnvelope<TData> {
  ok?: boolean;
  code?: string | number;
  msg?: string;
  message?: string;
  data?: TData;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientOkxQueueError<TData>(parsed: OkxCliEnvelope<TData>): boolean {
  const code = String(parsed.code ?? '');
  const message = [parsed.msg, parsed.message]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();

  return (
    code === '20008' ||
    message.includes('another order processing') ||
    message.includes('too many requests') ||
    message.includes('getnonce error')
  );
}

function isTransientOkxQueueDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes('another order processing') ||
    normalized.includes('too many requests') ||
    normalized.includes('getnonce error')
  );
}

class OkxTeeWalletClient {
  private apiKey = '';
  private secret = '';
  private passphrase = '';
  private projectId = '';
  private cliPath = '';
  private initialized = false;
  private mockCounter = 0;
  private sessionQueue: Promise<void> = Promise.resolve();

  private localKeys = new Map<string, string>();

  initialize(): void {
    this.apiKey = process.env.OKX_API_KEY ?? '';
    this.secret = process.env.OKX_SECRET_KEY ?? '';
    this.passphrase = process.env.OKX_PASSPHRASE ?? '';
    this.projectId = process.env.OKX_PROJECT_ID ?? '';
    this.cliPath = this.resolveCliPath();

    if (this.apiKey && this.secret && this.passphrase && this.projectId && this.cliPath) {
      this.initialized = true;
      console.log(`[OKX-TEE] Agentic Wallet session adapter initialized via ${this.cliPath}`);
      return;
    }

    this.initialized = false;
    const missing = [
      !this.apiKey ? 'OKX_API_KEY' : null,
      !this.secret ? 'OKX_SECRET_KEY' : null,
      !this.passphrase ? 'OKX_PASSPHRASE' : null,
      !this.projectId ? 'OKX_PROJECT_ID' : null,
      !this.cliPath ? 'onchainos binary' : null,
    ].filter(Boolean);
    const message = `[OKX-TEE] Agentic Wallet unavailable (${missing.join(', ')})`;
    if (isStrictOnchainMode()) {
      throw new Error(message);
    }

    console.warn(`${message} — running in local fallback mode`);
  }

  isConfigured(): boolean {
    return this.initialized;
  }

  private resolveCliPath(): string {
    const candidates = [
      process.env.ONCHAINOS_BIN?.trim(),
      DEFAULT_ONCHAINOS_BIN,
      'onchainos',
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (candidate === 'onchainos') {
        return candidate;
      }
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return '';
  }

  private getCliEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${process.env.HOME ?? ''}/.local/bin:${process.env.PATH ?? ''}`,
    };
  }

  private async withSessionQueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    const run = this.sessionQueue.then(task, task);
    this.sessionQueue = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } catch (error) {
      if (isStrictOnchainMode()) {
        throw error;
      }
      console.warn(`[OKX-TEE] ${label} failed:`, error);
      throw error;
    }
  }

  private async runCli<TData>(
    args: string[],
    label: string,
    options?: { allowEmptyData?: boolean; retryDelaysMs?: readonly number[] },
  ): Promise<TData> {
    if (!this.cliPath) {
      throw new Error(`[OKX-TEE] onchainos binary not found for ${label}`);
    }

    const retryDelays = options?.retryDelaysMs ?? [];

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const { stdout, stderr } = await execFileAsync(this.cliPath, args, {
          env: this.getCliEnv(),
          maxBuffer: CLI_MAX_BUFFER,
        });

        const output = String(stdout ?? '').trim() || String(stderr ?? '').trim();
        if (!output) {
          throw new Error(`[OKX-TEE] ${label} returned empty output`);
        }

        const parsed = JSON.parse(output) as OkxCliEnvelope<TData>;
        if (parsed.ok === false || (parsed.code !== undefined && String(parsed.code) !== '0' && parsed.data === undefined)) {
          if (attempt < retryDelays.length && isTransientOkxQueueError(parsed)) {
            const delayMs = retryDelays[attempt]!;
            console.warn(
              `[OKX-TEE] ${label} hit transient queueing, retrying in ${delayMs}ms (${attempt + 1}/${retryDelays.length})`,
            );
            await sleep(delayMs);
            continue;
          }

          const message = parsed.msg ?? parsed.message ?? `[OKX-TEE] ${label} failed`;
          throw new Error(message);
        }

        if (parsed.data === undefined && options?.allowEmptyData) {
          return {} as TData;
        }

        if (parsed.data === undefined) {
          throw new Error(`[OKX-TEE] ${label} returned no data`);
        }

        return parsed.data;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'stdout' in error &&
          typeof (error as { stdout?: string }).stdout === 'string'
        ) {
          const stdout = String((error as { stdout?: string }).stdout ?? '').trim();
          const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
          const detail = stdout || stderr || String(error);
          if (attempt < retryDelays.length && isTransientOkxQueueDetail(detail)) {
            const delayMs = retryDelays[attempt]!;
            console.warn(
              `[OKX-TEE] ${label} hit transient CLI failure, retrying in ${delayMs}ms (${attempt + 1}/${retryDelays.length})`,
            );
            await sleep(delayMs);
            continue;
          }
          throw new Error(`[OKX-TEE] ${label} failed: ${detail}`);
        }

        throw error;
      }
    }

    throw new Error(`[OKX-TEE] ${label} exhausted retries`);
  }

  private async getStatusInternal(): Promise<OkxWalletStatus> {
    const data = await this.runCli<{
      accountCount?: number;
      apiKey?: string;
      currentAccountId?: string;
      currentAccountName?: string;
      email?: string;
      loggedIn?: boolean;
      loginType?: string;
    }>(['wallet', 'status'], 'wallet status');

    return {
      accountCount: Number(data.accountCount ?? 0),
      apiKey: String(data.apiKey ?? ''),
      currentAccountId: data.currentAccountId ? String(data.currentAccountId) : null,
      currentAccountName: data.currentAccountName ? String(data.currentAccountName) : null,
      email: String(data.email ?? ''),
      loggedIn: Boolean(data.loggedIn),
      loginType: data.loginType ? String(data.loginType) : null,
    };
  }

  async getStatus(): Promise<OkxWalletStatus | null> {
    if (!this.initialized) {
      return null;
    }

    try {
      return await this.withSessionQueue('wallet-status', async () => this.getStatusInternal());
    } catch {
      return null;
    }
  }

  private async ensureLoggedInInternal(): Promise<OkxWalletStatus> {
    const status = await this.getStatusInternal().catch(() => null);
    const needsLogin =
      !status?.loggedIn ||
      !status.apiKey ||
      status.apiKey !== this.apiKey;

    if (needsLogin) {
      await this.runCli<{ accountId?: string }>(
        ['wallet', 'login', '--force'],
        'wallet login --force',
      );
    }

    const refreshed = await this.getStatusInternal();
    if (!refreshed.loggedIn) {
      throw new Error('[OKX-TEE] Agentic Wallet login failed');
    }

    return refreshed;
  }

  private async switchAccountInternal(accountId: string): Promise<void> {
    await this.runCli<Record<string, unknown>>(
      ['wallet', 'switch', accountId],
      `wallet switch ${accountId}`,
      { allowEmptyData: true },
    );
  }

  private async getAddressesInternal(): Promise<WalletAddressesResponse> {
    return this.runCli<WalletAddressesResponse>(
      ['wallet', 'addresses'],
      'wallet addresses',
    );
  }

  private extractAgentAddress(addresses: WalletAddressesResponse): string {
    const preferredChain = String(getXLayerChainId());
    const xlayer = Array.isArray(addresses.xlayer) ? addresses.xlayer : [];
    const evm = Array.isArray(addresses.evm) ? addresses.evm : [];

    const preferred =
      xlayer.find((item) => String(item.chainIndex ?? '') === preferredChain && item.address) ??
      xlayer.find((item) => item.address) ??
      evm.find((item) => item.address);

    if (!preferred?.address) {
      throw new Error('[OKX-TEE] wallet addresses returned no usable EVM/X Layer address');
    }

    return ethers.getAddress(preferred.address);
  }

  private getCapabilities(): string[] {
    return [
      'wallet_balance',
      'wallet_addresses',
      'wallet_send',
      'contract_call',
      'x402_sign',
    ];
  }

  async createAgentWallet(agentId: string): Promise<TeeWalletResult> {
    if (!this.initialized) {
      if (isStrictOnchainMode()) {
        throw new Error(`[OKX-TEE] Agentic Wallet is not configured for ${agentId}`);
      }
      return this.createMockWallet(agentId);
    }

    try {
      return await this.withSessionQueue(`provision:${agentId}`, async () => {
        const statusBefore = await this.ensureLoggedInInternal();
        const previousAccountId = statusBefore.currentAccountId;

        const addResult = await this.runCli<{
          accountId?: string;
          accountName?: string;
        }>(['wallet', 'add'], `wallet add (${agentId})`);

        const accountId = String(addResult.accountId ?? '').trim();
        if (!accountId) {
          throw new Error(`[OKX-TEE] wallet add returned no accountId for ${agentId}`);
        }

        const accountName = String(addResult.accountName ?? '').trim() || `Agent ${agentId}`;

        try {
          await this.switchAccountInternal(accountId);
          const addresses = await this.getAddressesInternal();
          const address = this.extractAgentAddress(addresses);

          return {
            address,
            teeKeyRef: accountId,
            okxAccountId: accountId,
            okxAccountName: accountName,
            walletProvider: 'okx_agentic_wallet',
            loginType: statusBefore.loginType ?? 'ak',
            capabilities: this.getCapabilities(),
            source: 'okx_tee',
          };
        } finally {
          if (previousAccountId && previousAccountId !== accountId) {
            await this.switchAccountInternal(previousAccountId).catch((error) => {
              console.warn(`[OKX-TEE] failed to restore active account to ${previousAccountId}:`, error);
            });
          }
        }
      });
    } catch (error) {
      if (isStrictOnchainMode()) {
        throw error;
      }

      console.warn(`[OKX-TEE] failed to provision ${agentId}, using local fallback:`, error);
      return this.createMockWallet(agentId, 'mock_tee_fallback');
    }
  }

  async resolveAccountAddress(accountId: string): Promise<string> {
    if (!this.initialized) {
      throw new Error('[OKX-TEE] Agentic Wallet is not configured');
    }

    return this.withSessionQueue(`resolve-address:${accountId}`, async () => {
      const statusBefore = await this.ensureLoggedInInternal();
      const previousAccountId = statusBefore.currentAccountId;

      try {
        if (previousAccountId !== accountId) {
          await this.switchAccountInternal(accountId);
        }
        const addresses = await this.getAddressesInternal();
        return this.extractAgentAddress(addresses);
      } finally {
        if (previousAccountId && previousAccountId !== accountId) {
          await this.switchAccountInternal(previousAccountId).catch((error) => {
            console.warn(`[OKX-TEE] failed to restore active account to ${previousAccountId}:`, error);
          });
        }
      }
    });
  }

  private createMockWallet(
    agentId: string,
    source: TeeWalletResult['source'] = 'mock_tee_local',
  ): TeeWalletResult {
    const wallet = ethers.Wallet.createRandom();
    this.localKeys.set(`mock-tee-${agentId}`, wallet.privateKey);
    this.mockCounter++;

    return {
      address: wallet.address,
      teeKeyRef: `mock-tee-${agentId}`,
      okxAccountName: `Mock ${agentId}`,
      walletProvider: 'local_mock_wallet',
      capabilities: ['local_sign'],
      source,
    };
  }

  async signTransaction(
    teeKeyRef: string,
    to: string,
    data: string,
    value = '0',
  ): Promise<TeeSignResult> {
    if (teeKeyRef.startsWith('mock-tee-') || !this.initialized) {
      if (isStrictOnchainMode()) {
        throw new Error(`[OKX-TEE] local signing fallback is disabled in strict mode for ${teeKeyRef}`);
      }
      return this.signWithLocalKey(teeKeyRef, to, data, value);
    }

    const chainId = getXLayerChainId();
    if (chainId !== 196) {
      throw new Error(
        `[OKX-TEE] Agentic Wallet contract-call is only validated for X Layer mainnet (196); current chain is ${chainId}`,
      );
    }

    return this.withSessionQueue(`contract-call:${teeKeyRef}:${to}`, async () => {
      const statusBefore = await this.ensureLoggedInInternal();
      const previousAccountId = statusBefore.currentAccountId;

      try {
        if (previousAccountId !== teeKeyRef) {
          await this.switchAccountInternal(teeKeyRef);
        }

        const result = await this.runCli<Record<string, unknown>>(
          [
            'wallet',
            'contract-call',
            '--to',
            to,
            '--chain',
            String(chainId),
            '--input-data',
            data,
            '--value',
            value,
            '--force',
          ],
          `wallet contract-call ${teeKeyRef}`,
          { retryDelaysMs: OKX_QUEUE_RETRY_DELAYS_MS },
        );

        const txHash = this.extractTxHash(result);
        return {
          txHash,
          orderId: txHash,
        };
      } finally {
        if (previousAccountId && previousAccountId !== teeKeyRef) {
          await this.switchAccountInternal(previousAccountId).catch((error) => {
            console.warn(`[OKX-TEE] failed to restore active account to ${previousAccountId}:`, error);
          });
        }
      }
    });
  }

  private extractTxHash(result: Record<string, unknown>): string {
    const candidates = [
      result.txHash,
      result.transactionHash,
      (result.data as Record<string, unknown> | undefined)?.txHash,
      (result.data as Record<string, unknown> | undefined)?.transactionHash,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.startsWith('0x') && candidate.length >= 66) {
        return candidate;
      }
    }

    throw new Error('[OKX-TEE] contract-call returned no transaction hash');
  }

  async signX402Payment(
    teeKeyRef: string,
    input: X402PaymentSignInput,
  ): Promise<X402PaymentProof> {
    if (teeKeyRef.startsWith('mock-tee-') || !this.initialized) {
      if (isStrictOnchainMode()) {
        throw new Error(`[OKX-TEE] local x402 signing fallback is disabled in strict mode for ${teeKeyRef}`);
      }
      return this.signMockX402Payment(teeKeyRef, input);
    }

    const chainIndex = String(input.chainIndex ?? getXLayerChainId());
    if (chainIndex !== '196') {
      throw new Error(
        `[OKX-TEE] Agentic Wallet x402 signing is only validated for X Layer mainnet (196); current chain is ${chainIndex}`,
      );
    }

    const network = input.network ?? `eip155:${chainIndex}`;
    const x402Version = input.x402Version ?? 2;
    const scheme = input.scheme ?? 'exact';
    const payTo = ethers.getAddress(input.payTo);
    const amount = String(input.amount);

    return this.withSessionQueue(`x402-pay:${teeKeyRef}:${payTo}`, async () => {
      const statusBefore = await this.ensureLoggedInInternal();
      const previousAccountId = statusBefore.currentAccountId;

      try {
        if (previousAccountId !== teeKeyRef) {
          await this.switchAccountInternal(teeKeyRef);
        }

        const args = [
          'payment',
          'x402-pay',
          '--network',
          network,
          '--amount',
          amount,
          '--pay-to',
          payTo,
          '--asset',
          input.asset,
        ];

        if (input.from) {
          args.push('--from', input.from);
        }
        if (input.maxTimeoutSeconds) {
          args.push('--max-timeout-seconds', String(input.maxTimeoutSeconds));
        }

        const result = await this.runCli<{
          signature?: string;
          authorization?: Partial<X402Authorization>;
        }>(args, `payment x402-pay ${teeKeyRef}`, {
          retryDelaysMs: OKX_QUEUE_RETRY_DELAYS_MS,
        });

        return this.buildX402PaymentProof(
          {
            signature: String(result.signature ?? ''),
            authorization: result.authorization,
          },
          {
            ...input,
            x402Version,
            network,
            chainIndex,
            scheme,
            amount,
            payTo,
          },
          'okx_agentic_wallet',
        );
      } finally {
        if (previousAccountId && previousAccountId !== teeKeyRef) {
          await this.switchAccountInternal(previousAccountId).catch((error) => {
            console.warn(`[OKX-TEE] failed to restore active account to ${previousAccountId}:`, error);
          });
        }
      }
    });
  }

  private buildX402PaymentProof(
    result: {
      signature: string;
      authorization?: Partial<X402Authorization>;
    },
    input: Required<
      Pick<X402PaymentSignInput, 'amount' | 'payTo' | 'asset' | 'x402Version' | 'network' | 'chainIndex' | 'scheme'>
    > &
      Omit<X402PaymentSignInput, 'amount' | 'payTo' | 'asset' | 'x402Version' | 'network' | 'chainIndex' | 'scheme'>,
    provider: 'okx_agentic_wallet' | 'local_mock_wallet',
  ): X402PaymentProof {
    const signature = String(result.signature ?? '').trim();
    if (!signature.startsWith('0x')) {
      throw new Error('[OKX-TEE] x402-pay returned no signature');
    }

    const authorization = this.normalizeX402Authorization(
      result.authorization,
      input.payTo,
      input.amount,
      input.maxTimeoutSeconds,
    );

    const paymentPayload: X402PaymentPayload = {
      x402Version: input.x402Version,
      scheme: input.scheme,
      chainIndex: String(input.chainIndex),
      payload: {
        signature,
        authorization,
      },
    };

    const paymentRequirements: X402PaymentRequirements = {
      scheme: input.scheme,
      chainIndex: String(input.chainIndex),
      maxAmountRequired: input.amount,
      payTo: ethers.getAddress(input.payTo),
      asset: input.asset,
      resource: input.resource,
      description: input.description,
      mimeType: input.mimeType,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      outputSchema: input.outputSchema,
      extra: input.extra,
    };

    const headerName = input.x402Version >= 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
    const headerValue = Buffer.from(
      JSON.stringify({
        ...paymentPayload,
        paymentRequirements,
      }),
    ).toString('base64');

    return {
      provider,
      headerName,
      headerValue,
      x402Version: input.x402Version,
      network: input.network,
      chainIndex: String(input.chainIndex),
      amount: input.amount,
      payerAddress: authorization.from,
      payeeAddress: authorization.to,
      signature,
      authorization,
      paymentPayload,
      paymentRequirements,
      signedAt: new Date().toISOString(),
    };
  }

  private normalizeX402Authorization(
    authorization: Partial<X402Authorization> | undefined,
    payTo: string,
    amount: string,
    maxTimeoutSeconds: number | undefined,
  ): X402Authorization {
    const now = Math.floor(Date.now() / 1000);
    const validBefore = String(now + (maxTimeoutSeconds ?? 300));
    const nonce = authorization?.nonce && authorization.nonce.startsWith('0x')
      ? authorization.nonce
      : `0x${crypto.randomBytes(32).toString('hex')}`;

    if (!authorization?.from) {
      throw new Error('[OKX-TEE] x402-pay returned no payer address');
    }

    return {
      from: ethers.getAddress(authorization.from),
      to: authorization.to ? ethers.getAddress(authorization.to) : ethers.getAddress(payTo),
      value: String(authorization.value ?? amount),
      validAfter: String(authorization.validAfter ?? '0'),
      validBefore: String(authorization.validBefore ?? validBefore),
      nonce,
    };
  }

  private async signMockX402Payment(
    teeKeyRef: string,
    input: X402PaymentSignInput,
  ): Promise<X402PaymentProof> {
    const now = Math.floor(Date.now() / 1000);
    const fromAddress = input.from
      ? ethers.getAddress(input.from)
      : this.localKeys.get(teeKeyRef)
        ? new ethers.Wallet(this.localKeys.get(teeKeyRef)!).address
        : ethers.Wallet.createRandom().address;

    return this.buildX402PaymentProof(
      {
        signature: `0x${crypto.randomBytes(65).toString('hex')}`,
        authorization: {
          from: fromAddress,
          to: input.payTo,
          value: input.amount,
          validAfter: String(now - 1),
          validBefore: String(now + (input.maxTimeoutSeconds ?? 300)),
          nonce: `0x${crypto.randomBytes(32).toString('hex')}`,
        },
      },
      {
        ...input,
        x402Version: input.x402Version ?? 2,
        network: input.network ?? `eip155:${input.chainIndex ?? getXLayerChainId()}`,
        chainIndex: String(input.chainIndex ?? getXLayerChainId()),
        scheme: input.scheme ?? 'exact',
        amount: input.amount,
        payTo: input.payTo,
        asset: input.asset,
      },
      'local_mock_wallet',
    );
  }

  private async signWithLocalKey(
    teeKeyRef: string,
    to: string,
    data: string,
    value: string,
  ): Promise<TeeSignResult> {
    const key = this.localKeys.get(teeKeyRef);
    if (key) {
      try {
        const tx = await executePrivateKeyWrite(
          key,
          `okxtee.localSign:${teeKeyRef}:${to}`,
          async (signer) =>
            signer.sendTransaction({
              to,
              data,
              value: ethers.parseEther(value),
            }),
        );
        return { txHash: tx.hash, orderId: `local-${Date.now()}` };
      } catch {
        // fall through to mock
      }
    }

    return {
      txHash: `0xmock${crypto.randomBytes(30).toString('hex')}`,
      orderId: `mock-${Date.now()}`,
    };
  }

  async getTransactionStatus(orderId: string): Promise<'pending' | 'confirmed' | 'failed'> {
    if (orderId.startsWith('mock-') || orderId.startsWith('local-') || !this.initialized) {
      if (isStrictOnchainMode()) {
        throw new Error(`[OKX-TEE] transaction status fallback is disabled in strict mode for ${orderId}`);
      }
      return 'confirmed';
    }

    if (!orderId.startsWith('0x')) {
      return 'pending';
    }

    try {
      const provider = createXLayerProvider(process.env.X_LAYER_RPC);
      const receipt = await provider.getTransactionReceipt(orderId);
      if (!receipt) {
        return 'pending';
      }
      return receipt.status === 1 ? 'confirmed' : 'failed';
    } catch {
      return 'pending';
    }
  }

  getStats(): { configured: boolean; mockWallets: number; cliPath: string | null } {
    return {
      configured: this.initialized,
      mockWallets: this.mockCounter,
      cliPath: this.cliPath || null,
    };
  }
}

export const okxTeeWallet = new OkxTeeWalletClient();

export function initOkxTeeWallet(): void {
  okxTeeWallet.initialize();
}

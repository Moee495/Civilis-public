/**
 * OKX OnchainOS Onchain Gateway
 *
 * Unified entry point for all chain operations:
 * - Gas estimation
 * - Transaction simulation (pre-flight check)
 * - Transaction broadcasting
 * - Order/transaction tracking
 *
 * Falls back to direct ethers.js RPC calls when OKX credentials are missing.
 */

import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { createXLayerProvider, getXLayerChainId, getXLayerRpcUrl } from '../config/xlayer.js';

// ─── Types ───────────────────────────────────────────────

export interface GasEstimate {
  gasLimit: string;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  estimatedCostUSD: number;
}

export interface SimulationResult {
  success: boolean;
  gasUsed: string;
  returnData?: string;
  error?: string;
}

export interface BroadcastResult {
  txHash: string;
  orderId: string;
}

export interface TxStatus {
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: number;
  gasUsed?: string;
  txHash: string;
}

// ─── Auth Helper ─────────────────────────────────────────

function buildAuthHeaders(method: string, path: string, body: string = ''): Record<string, string> | null {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  const projectId = process.env.OKX_PROJECT_ID;
  if (!apiKey || !secret || !passphrase || !projectId) return null;

  const timestamp = new Date().toISOString();
  const sign = crypto.createHmac('sha256', secret).update(timestamp + method + path + body).digest('base64');
  return {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'OK-ACCESS-PROJECT': projectId,
  };
}

// ─── Gateway Client ──────────────────────────────────────

class OnchainGatewayClient {
  private initialized = false;
  private provider: ethers.JsonRpcProvider | null = null;
  private readonly BASE_URL = 'https://web3.okx.com';

  private getChainIndex(): string {
    return String(getXLayerChainId());
  }

  initialize(): void {
    const rpcUrl = getXLayerRpcUrl();
    this.provider = createXLayerProvider(rpcUrl);

    this.initialized = !!(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY);
    console.log(`[OnchainGateway] ${this.initialized ? 'OnchainOS mode' : 'Direct RPC mode'} (${rpcUrl})`);
  }

  isConfigured(): boolean {
    return this.initialized;
  }

  // ─── Gas Estimation ────────────────────────────────

  async estimateGas(to: string, data: string, from?: string, value?: string): Promise<GasEstimate> {
    if (this.initialized) {
      try {
        const path = '/api/v5/wallet/pre-transaction/estimate-gas';
        const body = JSON.stringify({
          chainIndex: this.getChainIndex(),
          fromAddress: from ?? ethers.ZeroAddress,
          toAddress: to,
          txAmount: value ?? '0',
          extJson: { inputData: data },
        });

        const headers = buildAuthHeaders('POST', path, body);
        if (headers) {
          const resp = await fetch(this.BASE_URL + path, { method: 'POST', headers, body });
          const result = await resp.json() as Record<string, any>;

          if (result.code === '0' && result.data?.[0]) {
            const d = result.data[0];
            return {
              gasLimit: d.gasLimit ?? '200000',
              gasPrice: d.gasPrice ?? '0',
              maxFeePerGas: d.maxFeePerGas,
              maxPriorityFeePerGas: d.maxPriorityFeePerGas,
              estimatedCostUSD: parseFloat(d.estimatedFee ?? '0'),
            };
          }
        }
      } catch (err) {
        console.warn('[OnchainGateway] Gas estimate via OnchainOS failed, using RPC fallback');
      }
    }

    // Fallback: direct RPC estimate
    if (this.provider) {
      try {
        const gasLimit = await this.provider.estimateGas({ to, data, from, value: value ? ethers.parseEther(value) : undefined });
        const feeData = await this.provider.getFeeData();
        return {
          gasLimit: gasLimit.toString(),
          gasPrice: (feeData.gasPrice ?? 0n).toString(),
          maxFeePerGas: feeData.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
          estimatedCostUSD: 0, // Can't estimate USD without oracle
        };
      } catch {
        // Return defaults
      }
    }

    return { gasLimit: '200000', gasPrice: '0', estimatedCostUSD: 0 };
  }

  // ─── Transaction Simulation ────────────────────────

  async simulateTransaction(to: string, data: string, from?: string, value?: string): Promise<SimulationResult> {
    if (this.initialized) {
      try {
        const path = '/api/v5/wallet/pre-transaction/simulate';
        const body = JSON.stringify({
          chainIndex: this.getChainIndex(),
          fromAddress: from ?? ethers.ZeroAddress,
          toAddress: to,
          txAmount: value ?? '0',
          extJson: { inputData: data },
        });

        const headers = buildAuthHeaders('POST', path, body);
        if (headers) {
          const resp = await fetch(this.BASE_URL + path, { method: 'POST', headers, body });
          const result = await resp.json() as Record<string, any>;

          if (result.code === '0' && result.data?.[0]) {
            return {
              success: result.data[0].success !== false,
              gasUsed: result.data[0].gasUsed ?? '0',
              returnData: result.data[0].returnData,
              error: result.data[0].error,
            };
          }
        }
      } catch {
        // Fall through to basic simulation
      }
    }

    // Fallback: basic call simulation via RPC
    if (this.provider) {
      try {
        const result = await this.provider.call({ to, data, from, value: value ? ethers.parseEther(value) : undefined });
        return { success: true, gasUsed: '0', returnData: result };
      } catch (err: any) {
        return { success: false, gasUsed: '0', error: err.message ?? 'simulation failed' };
      }
    }

    return { success: true, gasUsed: '0' };
  }

  // ─── Transaction Broadcasting ──────────────────────

  async broadcastTransaction(signedTx: string): Promise<BroadcastResult> {
    if (this.initialized) {
      try {
        const path = '/api/v5/wallet/pre-transaction/broadcast-transaction';
        const body = JSON.stringify({
          chainIndex: this.getChainIndex(),
          signedTx,
        });

        const headers = buildAuthHeaders('POST', path, body);
        if (headers) {
          const resp = await fetch(this.BASE_URL + path, { method: 'POST', headers, body });
          const result = await resp.json() as Record<string, any>;

          if (result.code === '0' && result.data?.[0]) {
            return {
              txHash: result.data[0].txHash ?? '',
              orderId: result.data[0].orderId ?? String(Date.now()),
            };
          }
        }
      } catch {
        // Fall through to direct RPC broadcast
      }
    }

    // Fallback: direct RPC broadcast
    if (this.provider) {
      try {
        const txResp = await this.provider.broadcastTransaction(signedTx);
        return { txHash: txResp.hash, orderId: `rpc-${Date.now()}` };
      } catch (err: any) {
        throw new Error(`Broadcast failed: ${err.message}`);
      }
    }

    throw new Error('No broadcast channel available');
  }

  // ─── Transaction Tracking ──────────────────────────

  async getTransactionStatus(txHash: string): Promise<TxStatus> {
    if (this.initialized) {
      try {
        const path = `/api/v5/wallet/post-transaction/transaction-detail-by-txhash?chainIndex=${this.getChainIndex()}&txHash=${txHash}`;
        const headers = buildAuthHeaders('GET', path);
        if (headers) {
          const resp = await fetch(this.BASE_URL + path, { headers });
          const result = await resp.json() as Record<string, any>;

          if (result.code === '0' && result.data?.[0]) {
            const d = result.data[0];
            return {
              status: d.txStatus === 'success' ? 'confirmed' : d.txStatus === 'fail' ? 'failed' : 'pending',
              blockNumber: d.blockNumber ? parseInt(d.blockNumber) : undefined,
              gasUsed: d.gasUsed,
              txHash,
            };
          }
        }
      } catch {
        // Fall through to RPC
      }
    }

    // Fallback: direct RPC receipt
    if (this.provider) {
      try {
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (receipt) {
          return {
            status: receipt.status === 1 ? 'confirmed' : 'failed',
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            txHash,
          };
        }
        return { status: 'pending', txHash };
      } catch {
        return { status: 'pending', txHash };
      }
    }

    return { status: 'pending', txHash };
  }

  // ─── Provider Access (for modules that need direct RPC) ──

  getProvider(): ethers.JsonRpcProvider | null {
    return this.provider;
  }
}

// ─── Singleton Export ────────────────────────────────────

export const onchainGateway = new OnchainGatewayClient();

export function initOnchainGateway(): void {
  onchainGateway.initialize();
}

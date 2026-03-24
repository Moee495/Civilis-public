import { ethers, Contract, type TransactionReceipt } from 'ethers';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSigner,
  getSharedSignerAddress,
} from './shared-signers.js';
import { okxTeeWallet } from './okx-tee-wallet.js';
import {
  getAgentWalletAddressStrict,
  getAgentWalletExecutionContext,
} from '../agents/wallet-sync.js';
import { formatOnchainError, getUsdtAddress, isStrictOnchainMode } from '../config/xlayer.js';
import { resolveX402ServiceTarget } from '../config/x402-service.js';

const X402_SERVICE_ABI = [
  {
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'serviceType', type: 'uint8' },
    ],
    name: 'processPayment',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'serviceType', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'processPaymentAmount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'buyers', type: 'address[]' },
      { name: 'sellers', type: 'address[]' },
      { name: 'serviceTypes', type: 'uint8[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    name: 'processPaymentBatchAmount',
    outputs: [{ name: '', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'paymentId', type: 'uint256' }],
    name: 'verifyPayment',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getPaymentCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'agent', type: 'address' }],
    name: 'getBalance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'paymentId', type: 'uint256' },
      { indexed: true, name: 'buyer', type: 'address' },
      { indexed: true, name: 'seller', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'serviceType', type: 'uint8' },
      { indexed: false, name: 'timestamp', type: 'uint256' },
    ],
    name: 'PaymentProcessed',
    type: 'event',
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export enum ServiceType {
  Signal = 0,
  Advice = 1,
  Execution = 2,
}

export interface X402DirectPaymentResult {
  buyerAddress: string;
  sellerAddress: string;
  paymentId: number | null;
  txHash: string;
  confirmedAt: string;
}

class X402Bridge {
  private contract: Contract | null = null;
  private provider: ethers.JsonRpcProvider | null = null;
  private signer: ethers.NonceManager | null = null;
  private contractAddress: string | null = null;
  private contractInterface = new ethers.Interface(X402_SERVICE_ABI);
  private isInitialized = false;
  private attemptedInit = false;

  constructor() {
    // Delay initialization until first use so config inspection does not fail on import.
  }

  private initialize(): void {
    try {
      const target = resolveX402ServiceTarget();
      const rpcUrl = process.env.X_LAYER_RPC || 'https://rpc.xlayer.tech';
      const strict = isStrictOnchainMode();

      if (target.kind === 'missing') {
        if (strict) {
          throw new Error('[x402] bridge is missing X402_SERVICE_ADDRESS');
        }
        console.warn('x402 bridge is missing contract or treasury signer. Mock mode enabled.');
        this.isInitialized = false;
        return;
      }

      if (target.kind !== 'contract_address') {
        const message =
          target.kind === 'service_url'
            ? '[x402] X402_SERVICE_ADDRESS must be an on-chain contract address, but a URL was provided'
            : '[x402] X402_SERVICE_ADDRESS must be an on-chain contract address';
        if (strict) {
          throw new Error(message);
        }
        console.warn(`${message}. Mock mode enabled.`);
        this.isInitialized = false;
        return;
      }
      const contractAddress = target.contractAddress!;

      this.provider = getSharedProvider();
      this.signer = getSharedSigner('treasury');
      if (!this.signer) {
        if (strict) {
          throw new Error('[x402] bridge could not load treasury signer');
        }
        console.warn('x402 bridge could not load treasury signer. Mock mode enabled.');
        this.isInitialized = false;
        return;
      }

      this.contractAddress = contractAddress;
      this.contract = new ethers.Contract(contractAddress, X402_SERVICE_ABI, this.signer);
      this.isInitialized = true;
      console.log(`X402Bridge initialized: contract ${contractAddress.substring(0, 10)}... on ${rpcUrl}`);
    } catch (error) {
      if (isStrictOnchainMode()) {
        throw formatOnchainError('x402 bridge init failed', error);
      }
      console.warn('Failed to initialize X402Bridge:', error);
      this.isInitialized = false;
    }
  }

  async processPayment(
    buyerAgentId: string,
    sellerAgentId: string,
    serviceType: number,
    price: number,
  ): Promise<{ paymentId: number; txHash: string }> {
    if (!this.isConfigured()) {
      if (isStrictOnchainMode()) {
        throw new Error('[x402] bridge is not configured in strict mode');
      }
      return this.mockSingleResult();
    }

    return executeRoleWrite('treasury', 'x402.engine.processPayment', async () => {
      const buyerAddress = await getAgentWalletAddressStrict(buyerAgentId);
      const sellerAddress = await this.resolveParticipantAddress(sellerAgentId);
      const tx = await this.contract!.processPaymentAmount(
        buyerAddress,
        sellerAddress,
        serviceType,
        ethers.parseUnits(price.toFixed(6), 6),
      );
      const receipt = await tx.wait();
      const paymentId = this.extractPaymentIds(receipt ?? null)[0] ?? (await this.getPaymentCount()) - 1;
      return {
        paymentId: Math.max(0, paymentId),
        txHash: receipt?.hash ?? '',
      };
    });
  }

  async processPaymentBatch(
    payments: Array<{
      buyerAgentId: string;
      sellerAgentId: string;
      serviceType: number;
      price: number;
    }>,
  ): Promise<{ paymentIds: number[]; txHash: string }> {
    if (!payments.length) {
      throw new Error('processPaymentBatch requires at least one payment');
    }

    if (!this.isConfigured()) {
      if (isStrictOnchainMode()) {
        throw new Error('[x402] bridge batch path is not configured in strict mode');
      }
      return {
        paymentIds: payments.map((_, index) => this.mockSingleResult().paymentId + index),
        txHash: this.mockSingleResult().txHash,
      };
    }

    return executeRoleWrite('treasury', 'x402.engine.processPaymentBatch', async () => {
      const buyers = await Promise.all(
        payments.map((payment) => getAgentWalletAddressStrict(payment.buyerAgentId)),
      );
      const sellers = await Promise.all(
        payments.map((payment) => this.resolveParticipantAddress(payment.sellerAgentId)),
      );
      const serviceTypes = payments.map((payment) => payment.serviceType);
      const amounts = payments.map((payment) => ethers.parseUnits(payment.price.toFixed(6), 6));

      const tx = await this.contract!.processPaymentBatchAmount(buyers, sellers, serviceTypes, amounts);
      const receipt = await tx.wait();
      const paymentIds = this.extractPaymentIds(receipt ?? null);

      return {
        paymentIds,
        txHash: receipt?.hash ?? '',
      };
    });
  }

  async processDirectPayment(
    buyerAgentId: string | null,
    sellerAgentId: string | null,
    serviceType: number,
    price: number,
  ): Promise<X402DirectPaymentResult> {
    if (!this.isConfigured()) {
      if (isStrictOnchainMode()) {
        throw new Error('[x402] direct payment bridge is not configured in strict mode');
      }
      const fallback = this.mockSingleResult();
      return {
        buyerAddress: buyerAgentId ? await getAgentWalletAddressStrict(buyerAgentId) : this.getTreasuryAddress(),
        sellerAddress: await this.resolveParticipantAddress(sellerAgentId),
        paymentId: fallback.paymentId,
        txHash: fallback.txHash,
        confirmedAt: new Date().toISOString(),
      };
    }

    const sellerAddress = await this.resolveParticipantAddress(sellerAgentId);
    const amount = ethers.parseUnits(price.toFixed(6), 6);

    if (!buyerAgentId) {
      return executeRoleWrite('treasury', 'x402.direct.treasury', async () => {
        const buyerAddress = this.getTreasuryAddress();
        const usdtAddress = getUsdtAddress();
        if (!usdtAddress) {
          throw new Error('[x402] direct treasury payout requires USDT address');
        }

        // Treasury-origin payouts/refunds do not have an agent-side x402 proof flow.
        // On mainnet we settle these legs as direct USDT transfers from treasury.
        const usdt = new ethers.Contract(usdtAddress, ERC20_TRANSFER_ABI, this.signer);
        const tx = await usdt.transfer(sellerAddress, amount);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error('[x402] treasury payout transaction failed');
        }
        return {
          buyerAddress,
          sellerAddress,
          paymentId: null,
          txHash: receipt?.hash ?? '',
          confirmedAt: new Date().toISOString(),
        };
      });
    }

    const context = await getAgentWalletExecutionContext(buyerAgentId);
    if (!context.teeKeyRef) {
      throw new Error(`[x402] ${buyerAgentId} has no wallet signing reference`);
    }

    const calldata = this.contractInterface.encodeFunctionData('processPaymentAmount', [
      context.walletAddress,
      sellerAddress,
      serviceType,
      amount,
    ]);

    const submitted = await okxTeeWallet.signTransaction(
      context.teeKeyRef,
      this.contractAddress!,
      calldata,
      '0',
    );
    const receipt = await this.waitForReceipt(submitted.txHash);
    const paymentId = this.extractPaymentIds(receipt)[0];

    if (paymentId === undefined) {
      throw new Error(`[x402] PaymentProcessed event missing for tx ${submitted.txHash}`);
    }

    return {
      buyerAddress: context.walletAddress,
      sellerAddress,
      paymentId,
      txHash: receipt.hash,
      confirmedAt: new Date().toISOString(),
    };
  }

  async verifyPayment(paymentId: number): Promise<string> {
    if (!this.isConfigured()) {
      return this.mockSingleResult().txHash;
    }

    return executeRoleWrite('treasury', 'x402.verifyPayment', async () => {
      const tx = await this.contract!.verifyPayment(paymentId);
      const receipt = await tx.wait();
      return receipt?.hash ?? '';
    });
  }

  async getPaymentCount(): Promise<number> {
    if (!this.isConfigured()) {
      return 0;
    }

    const count = await this.contract!.getPaymentCount();
    return parseInt(count.toString(), 10);
  }

  async getBalance(agentId: string): Promise<string> {
    if (!this.isConfigured()) {
      return '0';
    }

    const agentAddress = await getAgentWalletAddressStrict(agentId);
    const balance = await this.contract!.getBalance(agentAddress);
    return balance.toString();
  }

  isConfigured(): boolean {
    if (!this.attemptedInit) {
      this.attemptedInit = true;
      this.initialize();
    }
    return this.isInitialized && !!this.contractAddress && !!this.provider;
  }

  private getTreasuryAddress(): string {
    return process.env.TREASURY_ADDRESS ?? getSharedSignerAddress('treasury') ?? ethers.ZeroAddress;
  }

  private async resolveParticipantAddress(agentId: string | null): Promise<string> {
    if (!agentId || agentId === 'treasury') {
      return this.getTreasuryAddress();
    }

    return getAgentWalletAddressStrict(agentId);
  }

  private async waitForReceipt(txHash: string): Promise<TransactionReceipt> {
    const receipt = await this.provider!.waitForTransaction(txHash, 1, 120_000);
    if (!receipt) {
      throw new Error(`[x402] Timed out waiting for receipt ${txHash}`);
    }
    if (receipt.status !== 1) {
      throw new Error(`[x402] Transaction ${txHash} failed on-chain`);
    }
    return receipt;
  }

  private extractPaymentIds(receipt: TransactionReceipt | null): number[] {
    if (!receipt) {
      return [];
    }

    const paymentIds: number[] = [];
    for (const log of receipt.logs) {
      try {
        const parsed = this.contractInterface.parseLog(log);
        if (parsed?.name === 'PaymentProcessed') {
          paymentIds.push(Number(parsed.args.paymentId));
        }
      } catch {
        // ignore unrelated logs
      }
    }

    return paymentIds;
  }

  private mockSingleResult(): { paymentId: number; txHash: string } {
    return {
      paymentId: Math.floor(Math.random() * 1_000_000),
      txHash: `0x${Math.random().toString(16).substring(2).padEnd(64, '0')}`,
    };
  }
}

export const x402Bridge = new X402Bridge();

import { ethers } from 'ethers';
import { getXLayerChainId } from '../config/xlayer.js';
import { executePrivateKeyWrite } from './shared-signers.js';

export const TOKENS = {
  USDT: '0xfde4C96c1286F8B31ACFabc61d4be5149095B213',
  WOKB: '0xc1d4635b91dd786d8a7ba92105b35e75c65f4357',
  WETH: '0x5A7ed6B61628e7B12Fdce1Ec4875cEA37e6d5d38',
};

export interface Quote {
  from: string;
  to: string;
  fromAmount: string;
  toAmount: string;
  slippage: number;
}

export interface SwapResult {
  txHash: string;
  from: string;
  to: string;
  fromAmount: string;
  toAmount: string;
  gasUsed: string;
  timestamp: number;
}

export class TradeClient {
  private dailyTradeCount = 0;
  private lastResetDate = new Date().toDateString();
  private readonly MAX_REAL_TRADES_PER_DAY = 8;

  getQuote(from: string, to: string, amount: string): Quote {
    const fromAddr = this.getTokenAddress(from);
    const toAddr = this.getTokenAddress(to);

    // Simulated quote with 0.5% slippage
    const slippage = 0.005;
    const outAmount = (parseFloat(amount) * (1 - slippage)).toFixed(8);

    return {
      from: fromAddr,
      to: toAddr,
      fromAmount: amount,
      toAmount: outAmount,
      slippage: slippage * 100,
    };
  }

  async executeSwap(
    fromSymbol: string,
    toSymbol: string,
    amountUSDT: string,
    wallet: string,
    key: string,
    forceReal: boolean = false
  ): Promise<SwapResult> {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyTradeCount = 0;
      this.lastResetDate = today;
    }

    const isRealTrade =
      forceReal && this.dailyTradeCount < this.MAX_REAL_TRADES_PER_DAY;

    if (isRealTrade) {
      // Execute real swap on OKX DEX
      return await this.executeRealSwap(
        fromSymbol,
        toSymbol,
        amountUSDT,
        wallet,
        key
      );
    } else {
      // Simulate swap
      return this.simulateSwap(
        fromSymbol,
        toSymbol,
        amountUSDT,
        wallet
      );
    }
  }

  private async executeRealSwap(
    fromSymbol: string,
    toSymbol: string,
    amountUSDT: string,
    wallet: string,
    key: string
  ): Promise<SwapResult> {
    try {
      // OKX DEX real swap currently targets mainnet. On testnet we keep trading
      // deterministic and safe by staying in simulation mode.
      if (getXLayerChainId() !== 196) {
        return this.simulateSwap(fromSymbol, toSymbol, amountUSDT, wallet);
      }

      const fromAddr = this.getTokenAddress(fromSymbol);
      const toAddr = this.getTokenAddress(toSymbol);

      // Build OKX DEX swap transaction
      const swapUrl = new URL('https://www.okx.com/api/v5/dex/aggregator/swap');
      swapUrl.searchParams.set('chainId', String(getXLayerChainId()));
      swapUrl.searchParams.set('fromTokenAddress', fromAddr);
      swapUrl.searchParams.set('toTokenAddress', toAddr);
      swapUrl.searchParams.set('amount', (parseFloat(amountUSDT) * 1e6).toString());
      swapUrl.searchParams.set('slippage', '0.5');
      swapUrl.searchParams.set('userWalletAddress', wallet);

      const swapResponse = await fetch(swapUrl.toString());
      const swapData = await swapResponse.json() as {
        code?: string;
        data?: Array<{
          tx: {
            to: string;
            data: string;
            value?: string;
          };
          toAmount?: string;
        }>;
      };

      if (swapData.code !== '0' || !swapData.data) {
        throw new Error('Failed to get swap data from OKX DEX');
      }

      const tx = swapData.data[0].tx;
      const transaction = {
        to: tx.to,
        from: wallet,
        data: tx.data,
        value: tx.value || '0',
        gasLimit: ethers.toBeHex(300000),
      };

      const txResponse = await executePrivateKeyWrite(
        key,
        `trade.swap:${fromSymbol}:${toSymbol}:${amountUSDT}`,
        async (signer) => signer.sendTransaction(transaction),
      );
      const receipt = await txResponse.wait();

      if (!receipt) {
        throw new Error('Transaction failed to execute');
      }

      this.dailyTradeCount++;

      return {
        txHash: receipt.hash,
        from: fromAddr,
        to: toAddr,
        fromAmount: amountUSDT,
        toAmount: swapData.data[0].toAmount || '0',
        gasUsed: receipt.gasUsed.toString(),
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('Real swap failed, falling back to simulation:', error);
      return this.simulateSwap(
        fromSymbol,
        toSymbol,
        amountUSDT,
        wallet
      );
    }
  }

  private simulateSwap(
    fromSymbol: string,
    toSymbol: string,
    amountUSDT: string,
    wallet: string
  ): SwapResult {
    const fromAddr = this.getTokenAddress(fromSymbol);
    const toAddr = this.getTokenAddress(toSymbol);

    // Simulated output with 0.5% slippage
    const slippage = 0.005;
    const outAmount = (parseFloat(amountUSDT) * (1 - slippage)).toFixed(8);

    return {
      txHash: `0x${Math.random().toString(16).substring(2)}${'0'.repeat(60)}`,
      from: fromAddr,
      to: toAddr,
      fromAmount: amountUSDT,
      toAmount: outAmount,
      gasUsed: '123456',
      timestamp: Date.now(),
    };
  }

  private getTokenAddress(symbol: string): string {
    const upper = symbol.toUpperCase();
    if (upper in TOKENS) {
      return TOKENS[upper as keyof typeof TOKENS];
    }
    throw new Error(`Unknown token: ${symbol}`);
  }

  resetDailyCount(): void {
    this.dailyTradeCount = 0;
  }

  getDailyTradeCount(): number {
    return this.dailyTradeCount;
  }

  getRemainingRealTrades(): number {
    return Math.max(0, this.MAX_REAL_TRADES_PER_DAY - this.dailyTradeCount);
  }
}

export const tradeClient = new TradeClient();

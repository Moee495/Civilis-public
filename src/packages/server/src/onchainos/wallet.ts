import { ethers } from 'ethers';
import { executePrivateKeyWrite, getSharedProvider } from './shared-signers.js';
import { TOKENS } from './trade.js';

export interface WalletSummary {
  address: string;
  okbBalance: string;
  usdtBalance: string;
  ethBalance: string;
  totalUSD: string;
  timestamp: number;
}

export class WalletClient {
  private provider: ethers.JsonRpcProvider;
  private readonly USDT_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ];

  constructor() {
    this.provider = getSharedProvider();
  }

  createWallet(): { address: string; privateKey: string } {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
  }

  async getOKBBalance(address: string): Promise<string> {
    try {
      const contract = new ethers.Contract(
        TOKENS.WOKB,
        this.USDT_ABI,
        this.provider
      );
      const balance = await contract.balanceOf(address);
      return ethers.formatUnits(balance, 8);
    } catch (error) {
      console.error('Error fetching OKB balance:', error);
      return '0';
    }
  }

  async getUSDTBalance(address: string): Promise<string> {
    try {
      const contract = new ethers.Contract(
        TOKENS.USDT,
        this.USDT_ABI,
        this.provider
      );
      const balance = await contract.balanceOf(address);
      return ethers.formatUnits(balance, 6);
    } catch (error) {
      console.error('Error fetching USDT balance:', error);
      return '0';
    }
  }

  async getETHBalance(address: string): Promise<string> {
    try {
      const balance = await this.provider.getBalance(address);
      return ethers.formatEther(balance);
    } catch (error) {
      console.error('Error fetching ETH balance:', error);
      return '0';
    }
  }

  async transferUSDT(
    fromKey: string,
    toAddr: string,
    amount: string
  ): Promise<string> {
    try {
      const amountWei = ethers.parseUnits(amount, 6);
      const tx = await executePrivateKeyWrite(
        fromKey,
        `wallet.transferUSDT:${toAddr}:${amount}`,
        async (signer) => {
          const contract = new ethers.Contract(
            TOKENS.USDT,
            this.USDT_ABI,
            signer
          );
          return contract.transfer(toAddr, amountWei);
        },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw new Error('Transaction failed');
      }

      return receipt.hash;
    } catch (error) {
      console.error('Error transferring USDT:', error);
      throw error;
    }
  }

  async getWalletSummary(address: string): Promise<WalletSummary> {
    try {
      const [okbBalance, usdtBalance, ethBalance] = await Promise.all([
        this.getOKBBalance(address),
        this.getUSDTBalance(address),
        this.getETHBalance(address),
      ]);

      // Assume OKB = $1, ETH = $1500 USD for estimation
      const totalUSD = (
        parseFloat(okbBalance) * 1 +
        parseFloat(usdtBalance) * 1 +
        parseFloat(ethBalance) * 1500
      ).toFixed(2);

      return {
        address,
        okbBalance,
        usdtBalance,
        ethBalance,
        totalUSD,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('Error getting wallet summary:', error);
      return {
        address,
        okbBalance: '0',
        usdtBalance: '0',
        ethBalance: '0',
        totalUSD: '0',
        timestamp: Date.now(),
      };
    }
  }
}

export const walletClient = new WalletClient();

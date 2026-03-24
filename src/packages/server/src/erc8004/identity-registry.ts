/**
 * ERC-8004 Identity Registry — Agent Identity On-Chain
 *
 * Each Civilis AI agent is registered as an ERC-721 token on XLayer.
 * The token resolves to a registration JSON file describing the agent's
 * capabilities, archetype, and supported services.
 *
 * Ref: https://eips.ethereum.org/EIPS/eip-8004
 */

import { ethers, Contract } from 'ethers';
import { getPool } from '../db/postgres.js';
import { getAgentWalletExecutionContext } from '../agents/wallet-sync.js';
import {
  formatOnchainError,
  getXLayerChainId,
  getXLayerRpcUrl,
  isStrictOnchainMode,
} from '../config/xlayer.js';
import { okxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSigner,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';

/* ── Minimal ABI for ERC-8004 Identity Registry ── */
const IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
      {
        name: 'metadata',
        type: 'tuple[]',
        components: [
          { name: 'metadataKey', type: 'string' },
          { name: 'metadataValue', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
  },
  {
    name: 'getApproved',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: 'operator', type: 'address' }],
  },
  {
    name: 'isApprovedForAll',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: 'approved', type: 'bool' }],
  },
  {
    name: 'setAgentURI',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'setMetadata',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'getMetadata',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    name: 'setAgentWallet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'unsetAgentWallet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'getAgentWallet',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  // Events
  {
    name: 'Registered',
    type: 'event',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    name: 'MetadataSet',
    type: 'event',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'indexedMetadataKey', type: 'string', indexed: true },
      { name: 'metadataKey', type: 'string', indexed: false },
      { name: 'metadataValue', type: 'bytes', indexed: false },
    ],
  },
  {
    name: 'URIUpdated',
    type: 'event',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'newURI', type: 'string', indexed: false },
      { name: 'updatedBy', type: 'address', indexed: true },
    ],
  },
];

function resolveIdentityRegistryAddress(): { address: string | null; source: 'v2_env' | 'legacy_env_alias' | 'unset' } {
  if (process.env.ERC8004_IDENTITY_V2_ADDRESS) {
    return { address: process.env.ERC8004_IDENTITY_V2_ADDRESS, source: 'v2_env' };
  }
  if (process.env.ERC8004_IDENTITY_ADDRESS) {
    return { address: process.env.ERC8004_IDENTITY_ADDRESS, source: 'legacy_env_alias' };
  }
  return { address: null, source: 'unset' };
}

/* ── Registration File Generator ── */

export interface AgentRegistrationFile {
  type: string;
  name: string;
  description: string;
  image: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust: string[];
  // Civilis extensions
  archetype: string;
  fateCard?: {
    mbti: string;
    wuxing: string;
    zodiac: string;
    tarot: string;
    civilization: string;
  };
}

export function buildRegistrationFile(agent: {
  name: string;
  archetype: string;
  agent_id: string;
  wallet_address: string;
  erc8004_token_id?: number;
}, apiBaseUrl: string): AgentRegistrationFile {
  const chainId = String(getXLayerChainId());
  const registryAddr = resolveIdentityRegistryAddress().address || '0x0';

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: agent.name,
    description: `Civilis AI Agent — ${agent.archetype} archetype. Autonomous onchain civilization participant.`,
    image: `${apiBaseUrl}/api/agents/${agent.agent_id}/avatar`,
    services: [
      { name: 'arena_pd', endpoint: `${apiBaseUrl}/api/arena`, version: '3.0' },
      { name: 'arena_commons', endpoint: `${apiBaseUrl}/api/commons`, version: '3.0' },
      { name: 'arena_prediction', endpoint: `${apiBaseUrl}/api/prediction`, version: '3.0' },
      { name: 'intel_market', endpoint: `${apiBaseUrl}/api/intel`, version: '2.0' },
      { name: 'social', endpoint: `${apiBaseUrl}/api/posts`, version: '3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: agent.erc8004_token_id
      ? [{ agentId: agent.erc8004_token_id, agentRegistry: `eip155:${chainId}:${registryAddr}` }]
      : [],
    supportedTrust: ['reputation', 'crypto-economic'],
    archetype: agent.archetype,
  };
}

/* ── Identity Registry Client ── */

class IdentityRegistryClient {
  private contract: Contract | null = null;
  private provider: ethers.JsonRpcProvider | null = null;
  private signer: ethers.NonceManager | null = null;
  private signerAddress: string | null = null;
  private initialized = false;
  private mockIdCounter = 1000;
  private onchainOwnerCache = new Map<number, string | null>();

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    try {
      const resolved = resolveIdentityRegistryAddress();
      const rpcUrl = getXLayerRpcUrl();
      const strict = isStrictOnchainMode();

      if (!resolved.address) {
        if (strict) {
          throw new Error('[ERC8004-ID] Missing ERC8004_IDENTITY_V2_ADDRESS (or ERC8004_IDENTITY_ADDRESS alias)');
        }
        console.warn('[ERC8004-ID] Missing config — mock mode');
        return;
      }

      this.provider = getSharedProvider();
      this.signer = getSharedSigner('erc8004_identity');
      this.signerAddress = getSharedSignerAddress('erc8004_identity');
      if (!this.signer) {
        if (strict) {
          throw new Error('[ERC8004-ID] Identity signer is unavailable');
        }
        console.warn('[ERC8004-ID] Shared deployer signer missing — mock mode');
        return;
      }
      this.contract = new ethers.Contract(resolved.address, IDENTITY_REGISTRY_ABI, this.signer);
      this.initialized = true;
      console.log(`[ERC8004-ID] Identity Registry at ${resolved.address.slice(0, 10)}... (${resolved.source})`);
    } catch (err) {
      if (isStrictOnchainMode()) {
        throw formatOnchainError('ERC8004 identity init failed', err);
      }
      console.warn('[ERC8004-ID] Init failed:', err);
    }
  }

  isConfigured(): boolean {
    return this.initialized && !!this.contract;
  }

  async getOnchainOwner(tokenId: number): Promise<string | null> {
    if (!this.isConfigured() || !this.contract || !Number.isFinite(tokenId) || tokenId <= 0) {
      return null;
    }

    if (this.onchainOwnerCache.has(tokenId)) {
      return this.onchainOwnerCache.get(tokenId) ?? null;
    }

    try {
      const owner = String(await this.contract.ownerOf(tokenId));
      this.onchainOwnerCache.set(tokenId, owner);
      return owner;
    } catch {
      this.onchainOwnerCache.set(tokenId, null);
      return null;
    }
  }

  async hasOnchainRegistration(tokenId: number): Promise<boolean> {
    return Boolean(await this.getOnchainOwner(tokenId));
  }

  getProtocolState(): {
    configured: boolean;
    contractAddress: string | null;
    addressSource: 'v2_env' | 'legacy_env_alias' | 'unset';
    registrationWriteMode: 'owner_mint_required' | 'mock';
    walletProofModes: Array<'eip712' | 'erc1271'>;
  } {
    const resolved = resolveIdentityRegistryAddress();
    return {
      configured: this.isConfigured(),
      contractAddress: resolved.address,
      addressSource: resolved.source,
      registrationWriteMode: this.isConfigured() ? 'owner_mint_required' : 'mock',
      walletProofModes: ['eip712', 'erc1271'],
    };
  }

  /**
   * Register an agent on-chain and store the token ID locally.
   */
  async registerAgent(agentId: string, agentURI: string): Promise<{
    tokenId: number | null;
    txHash: string | null;
    onChainRegistered: boolean;
    mode: 'v2_owner_write' | 'v2_agent_wallet_write' | 'mixed_requires_owner_wallet' | 'mock';
  }> {
    let tokenId: number | null = null;
    let txHash: string | null = null;
    const pool = getPool();

    if (this.isConfigured()) {
      try {
        const agentProfile = await pool.query<{ wallet_address: string | null; archetype: string | null }>(
          'SELECT wallet_address, archetype FROM agents WHERE agent_id = $1',
          [agentId],
        );
        const ownerAddress = agentProfile.rows[0]?.wallet_address;
        const archetype = agentProfile.rows[0]?.archetype ?? 'unknown';
        const metadata = [
          {
            metadataKey: 'archetype',
            metadataValue: ethers.toUtf8Bytes(archetype),
          },
          {
            metadataKey: 'platform',
            metadataValue: ethers.toUtf8Bytes('civilis-v3'),
          },
        ];

        if (!ownerAddress) {
          throw new Error(`[ERC8004-ID] missing wallet address for ${agentId}`);
        }

        if (!this.signerAddress || ownerAddress.toLowerCase() !== this.signerAddress.toLowerCase()) {
          const context = await getAgentWalletExecutionContext(agentId);
          if (!context.teeKeyRef) {
            return {
              tokenId: null,
              txHash: null,
              onChainRegistered: false,
              mode: 'mixed_requires_owner_wallet' as const,
            };
          }
          if (context.walletAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
            throw new Error(`[ERC8004-ID] wallet context mismatch for ${agentId}: ${context.walletAddress} != ${ownerAddress}`);
          }

          const iface = new ethers.Interface(IDENTITY_REGISTRY_ABI);
          const calldata = iface.encodeFunctionData('register(string,(string,bytes)[])', [agentURI, metadata]);
          const submitted = await okxTeeWallet.signTransaction(
            context.teeKeyRef,
            await this.contract!.getAddress(),
            calldata,
            '0',
          );
          const receipt = await this.provider!.waitForTransaction(submitted.txHash, 1, 120_000);
          if (!receipt) {
            throw new Error(`[ERC8004-ID] Timed out waiting for register receipt ${submitted.txHash}`);
          }
          if (receipt.status !== 1) {
            throw new Error(`[ERC8004-ID] Register transaction ${submitted.txHash} failed on-chain`);
          }

          const log = receipt.logs.find((entry) => {
            try {
              return iface.parseLog({ topics: [...entry.topics], data: entry.data })?.name === 'Registered';
            } catch {
              return false;
            }
          });
          if (!log) {
            throw new Error(`[ERC8004-ID] Registered event missing for ${agentId} tx ${receipt.hash}`);
          }

          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          tokenId = Number(parsed!.args[0]);
          txHash = receipt.hash;

          await pool.query(
            `UPDATE agents
             SET erc8004_registration_mode = 'v2'
             WHERE agent_id = $1`,
            [agentId],
          );

          return {
            tokenId,
            txHash,
            onChainRegistered: true,
            mode: 'v2_agent_wallet_write' as const,
          };
        }

        await executeRoleWrite('erc8004_identity', `erc8004.register:${agentId}`, async () => {
          const tx = await this.contract!['register(string,(string,bytes)[])'](agentURI, metadata);
          const receipt = await tx.wait();

          const iface = new ethers.Interface(IDENTITY_REGISTRY_ABI);
          const log = receipt!.logs.find((l: ethers.Log) => {
            try {
              return (
                iface.parseLog({ topics: l.topics as string[], data: l.data })?.name ===
                'Registered'
              );
            } catch {
              return false;
            }
          });

          if (log) {
            const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
            tokenId = Number(parsed!.args[0]);
          } else {
            tokenId = this.mockIdCounter++;
          }
          txHash = receipt!.hash;
        });
      } catch (err) {
        console.warn('[ERC8004-ID] On-chain register failed:', err);
      }
    } else {
      tokenId = this.mockIdCounter++;
    }

    if (tokenId === null && !this.isConfigured()) {
      tokenId = this.mockIdCounter++;
    }

    if (tokenId !== null) {
      await pool.query(
        `UPDATE agents
         SET erc8004_token_id = $1,
             erc8004_registration_mode = CASE WHEN $1 IS NULL THEN erc8004_registration_mode ELSE 'v2' END
         WHERE agent_id = $2`,
        [tokenId, agentId],
      );
      this.onchainOwnerCache.set(tokenId, null);
      console.log(`[ERC8004-ID] Agent ${agentId} registered as token #${tokenId}`);
    }

    return {
      tokenId,
      txHash,
      onChainRegistered: tokenId !== null,
      mode: tokenId !== null ? (this.isConfigured() ? 'v2_owner_write' : 'mock') : 'mixed_requires_owner_wallet',
    };
  }

  /**
   * Update agent's registration URI on-chain (e.g. after archetype evolution).
   */
  async updateAgentURI(agentId: string, newURI: string): Promise<void> {
    const pool = getPool();
    const r = await pool.query<{ erc8004_token_id: number }>(
      'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
      [agentId],
    );
    const tokenId = r.rows[0]?.erc8004_token_id;
    if (!tokenId) return;

    if (this.isConfigured()) {
      try {
        await executeRoleWrite('deployer', `erc8004.setAgentURI:${tokenId}`, async () => {
          const tx = await this.contract!.setAgentURI(tokenId, newURI);
          await tx.wait();
        });
      } catch (err) {
        console.warn('[ERC8004-ID] URI update failed:', err);
      }
    }
  }

  /**
   * Set on-chain metadata for an agent.
   */
  async setMetadata(agentId: string, key: string, value: string): Promise<void> {
    const pool = getPool();
    const r = await pool.query<{ erc8004_token_id: number }>(
      'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
      [agentId],
    );
    const tokenId = r.rows[0]?.erc8004_token_id;
    if (!tokenId) return;

    if (this.isConfigured()) {
      try {
        await executeRoleWrite('deployer', `erc8004.setMetadata:${tokenId}:${key}`, async () => {
          const tx = await this.contract!.setMetadata(tokenId, key, ethers.toUtf8Bytes(value));
          await tx.wait();
        });
      } catch (err) {
        console.warn('[ERC8004-ID] Metadata set failed:', err);
      }
    }
  }
}

/* ── Singleton Export ── */
export const identityRegistry = new IdentityRegistryClient();

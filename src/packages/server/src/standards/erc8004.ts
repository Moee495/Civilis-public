import { ethers } from 'ethers';
import { getPool } from '../db/postgres.js';
import { getAgentWalletAddressStrict } from '../agents/wallet-sync.js';
import {
  formatOnchainError,
  isStrictOnchainMode,
} from '../config/xlayer.js';
import {
  executeRoleWrite,
  getSharedSignerAddress,
  getSharedSigner,
} from '../onchainos/shared-signers.js';
import { identityRegistry } from '../erc8004/identity-registry.js';
import { reputationRegistry } from '../erc8004/reputation-registry.js';
import { validationRegistry } from '../erc8004/validation-registry.js';

const IDENTITY_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
] as const;

const REPUTATION_ABI = [
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
] as const;

let identityContract: ethers.Contract | null = null;
let reputationContract: ethers.Contract | null = null;

export function initERC8004(): void {
  const identitySigner = getSharedSigner('erc8004_identity');
  const reputationSigner = getSharedSigner('erc8004_reputation');
  const identityAddress = process.env.ERC8004_IDENTITY_V2_ADDRESS || process.env.ERC8004_IDENTITY_ADDRESS;
  const reputationAddress = process.env.ERC8004_REPUTATION_V2_ADDRESS || process.env.ERC8004_REPUTATION_ADDRESS;

  if (!identitySigner || !reputationSigner || !identityAddress || !reputationAddress) {
    const error = new Error('[ERC-8004] Missing signer or registry addresses');
    if (isStrictOnchainMode()) {
      throw error;
    }

    console.warn(`${error.message}, mock mode enabled`);
    identityContract = null;
    reputationContract = null;
    return;
  }

  identityContract = new ethers.Contract(identityAddress, IDENTITY_ABI, identitySigner);
  reputationContract = new ethers.Contract(
    reputationAddress,
    REPUTATION_ABI,
    reputationSigner,
  );
}

export function isERC8004Configured(): boolean {
  return identityContract !== null && reputationContract !== null;
}

export async function registerAgentOnERC8004(
  agentId: string,
  agentCardUri: string,
  walletAddress?: string,
): Promise<{ tokenId: number | null; txHash: string | null; onChainRegistered: boolean; mode: string } | null> {
  if (walletAddress) {
    await getAgentWalletAddressStrict(agentId);
  }
  const result = await identityRegistry.registerAgent(agentId, agentCardUri);
  return result;
}

export async function submitReputationFeedback(
  targetTokenId: number,
  value: number,
  tag: string,
  endpoint: string,
  clientAddress?: string,
): Promise<string | null> {
  const contract = reputationContract;
  if (!contract || !targetTokenId) {
    if (isStrictOnchainMode() && !targetTokenId) {
      throw new Error('[ERC-8004] target token id is required in strict mode');
    }
    if (isStrictOnchainMode() && !contract) {
      throw new Error('[ERC-8004] Reputation contract not configured in strict mode');
    }
    return null;
  }

  try {
    const receipt = await executeRoleWrite('erc8004_reputation', `erc8004.standardFeedback:${targetTokenId}:${tag}`, async () => {
      if (!clientAddress) {
        throw new Error('[ERC-8004] clientAddress is required for v2 feedback writes');
      }
      const signerAddress = getSharedSignerAddress('erc8004_reputation');
      if (!signerAddress || signerAddress.toLowerCase() !== clientAddress.toLowerCase()) {
        throw new Error('[ERC-8004] v2 feedback write requires caller to equal clientAddress');
      }
      const tx = await contract.giveFeedback(
        targetTokenId,
        value,
        0,
        tag,
        'civilis',
        endpoint,
        '',
        ethers.ZeroHash,
      );
      return tx.wait();
    });
    return receipt?.hash ?? null;
  } catch (error) {
    if (isStrictOnchainMode()) {
      throw formatOnchainError(`ERC-8004 feedback failed for ${targetTokenId}:${tag}`, error);
    }
    console.warn('[ERC-8004] feedback failed:', error);
    return null;
  }
}

export async function getAgentTokenId(agentId: string): Promise<number | null> {
  const pool = getPool();
  const result = await pool.query<{ erc8004_token_id: number | null }>(
    'SELECT erc8004_token_id FROM agents WHERE agent_id = $1',
    [agentId],
  );
  const tokenId = result.rows[0]?.erc8004_token_id;
  return tokenId ?? null;
}

export async function getAgentReputation(
  tokenId: number,
  tag: string | string[] = '',
): Promise<{ count: number; score: number } | null> {
  if (!tokenId) {
    return null;
  }

  try {
    const summary = await reputationRegistry.getAgentReputationView(tokenId, tag);
    return {
      count: summary.localLedger.count,
      score: summary.localLedger.averageValue,
    };
  } catch (error) {
    console.warn('[ERC-8004] summary lookup failed:', error);
    return null;
  }
}

export async function getAgentOnchainReputation(
  tokenId: number,
  tag: string | string[] = '',
): Promise<{ count: number; score: number } | null> {
  if (!tokenId) {
    return null;
  }

  try {
    const summary = await reputationRegistry.getAgentReputationView(tokenId, tag);
    if (!summary.onChainSummary || summary.onChainSummary.count <= 0) {
      return null;
    }

    return {
      count: summary.onChainSummary.count,
      score: summary.onChainSummary.averageValue,
    };
  } catch (error) {
    console.warn('[ERC-8004] on-chain summary lookup failed:', error);
    return null;
  }
}

export async function getAgentReputationByAgentId(
  agentId: string,
  tag: string | string[] = '',
): Promise<{ count: number; score: number } | null> {
  const tokenId = await getAgentTokenId(agentId);
  if (!tokenId) {
    return null;
  }

  return getAgentReputation(tokenId, tag);
}

export async function getAgentOnchainReputationByAgentId(
  agentId: string,
  tag: string | string[] = '',
): Promise<{ count: number; score: number } | null> {
  const tokenId = await getAgentTokenId(agentId);
  if (!tokenId) {
    return null;
  }

  return getAgentOnchainReputation(tokenId, tag);
}

export async function judgeSoul(agentId: string): Promise<{
  grade: 'legendary' | 'noble' | 'common' | 'fallen';
  finalScore: number;
  feedbackCount: number;
}> {
  const reputation = await getAgentReputationByAgentId(agentId);
  const score = reputation?.score ?? 0;

  let grade: 'legendary' | 'noble' | 'common' | 'fallen' = 'fallen';
  if (score > 80) {
    grade = 'legendary';
  } else if (score > 60) {
    grade = 'noble';
  } else if (score > 40) {
    grade = 'common';
  }

  const tokenId = await getAgentTokenId(agentId);
  if (tokenId) {
    reputationRegistry.queueFeedback({
      agentId,
      erc8004TokenId: tokenId,
      value: 0,
      valueDecimals: 0,
      tag1: 'death_judgment',
      tag2: 'civilis',
      endpoint: `civilis://graveyard/${agentId}`,
      metadata: { agentId, reason: 'death_judgment' },
    });
  }

  return {
    grade,
    finalScore: score,
    feedbackCount: reputation?.count ?? 0,
  };
}

export function getERC8004ServerAlignmentStatus(): {
  identity: ReturnType<typeof identityRegistry.getProtocolState>;
  reputation: ReturnType<typeof reputationRegistry.getProtocolState>;
  validation: ReturnType<typeof validationRegistry.getProtocolState>;
} {
  return {
    identity: identityRegistry.getProtocolState(),
    reputation: reputationRegistry.getProtocolState(),
    validation: validationRegistry.getProtocolState(),
  };
}

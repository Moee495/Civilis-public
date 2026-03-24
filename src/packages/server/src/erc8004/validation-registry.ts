/**
 * ERC-8004 Validation Registry — On-chain Intel Verification
 *
 * When intel is produced and later verified, the result is posted
 * on-chain via validationRequest / validationResponse, creating
 * an immutable audit trail of intel credibility.
 *
 * Ref: https://eips.ethereum.org/EIPS/eip-8004
 */

import { ethers, Contract } from 'ethers';
import { getPool } from '../db/postgres.js';
import { formatOnchainError, isStrictOnchainMode } from '../config/xlayer.js';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSigner,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';

/* ── Minimal ABI ── */
const VALIDATION_REGISTRY_ABI = [
  {
    name: 'initialize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'identityRegistry_', type: 'address' }],
    outputs: [],
  },
  {
    name: 'getIdentityRegistry',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'validationRequest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'requestURI', type: 'string' },
      { name: 'requestHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'validationResponse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'getValidationStatus',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestHash', type: 'bytes32' }],
    outputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'response', type: 'uint8' },
      { name: 'responseHash', type: 'bytes32' },
      { name: 'tag', type: 'string' },
      { name: 'lastUpdate', type: 'uint256' },
    ],
  },
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'validatorAddresses', type: 'address[]' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'averageResponse', type: 'uint8' },
    ],
  },
  {
    name: 'getAgentValidations',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'getValidatorRequests',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'validatorAddress', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  // Events
  {
    name: 'ValidationRequest',
    type: 'event',
    inputs: [
      { name: 'validatorAddress', type: 'address', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'requestURI', type: 'string', indexed: false },
      { name: 'requestHash', type: 'bytes32', indexed: true },
    ],
  },
  {
    name: 'ValidationResponse',
    type: 'event',
    inputs: [
      { name: 'validatorAddress', type: 'address', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'requestHash', type: 'bytes32', indexed: true },
      { name: 'response', type: 'uint8', indexed: false },
      { name: 'responseURI', type: 'string', indexed: false },
      { name: 'responseHash', type: 'bytes32', indexed: false },
      { name: 'tag', type: 'string', indexed: false },
    ],
  },
];

const IDENTITY_OWNER_ABI = [
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getApproved(uint256 agentId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
] as const;

function resolveValidationRegistryAddress(): { address: string | null; source: 'v2_env' | 'legacy_env_alias' | 'unset' } {
  if (process.env.ERC8004_VALIDATION_V2_ADDRESS) {
    return { address: process.env.ERC8004_VALIDATION_V2_ADDRESS, source: 'v2_env' };
  }
  if (process.env.ERC8004_VALIDATION_ADDRESS) {
    return { address: process.env.ERC8004_VALIDATION_ADDRESS, source: 'legacy_env_alias' };
  }
  return { address: null, source: 'unset' };
}

function resolveIdentityRegistryAddress(): string | null {
  return process.env.ERC8004_IDENTITY_V2_ADDRESS || process.env.ERC8004_IDENTITY_ADDRESS || null;
}

/* ── Validation Registry Client ── */

class ValidationRegistryClient {
  private contract: Contract | null = null;
  private signer: ethers.NonceManager | null = null;
  private signerAddress: string | null = null;
  private initialized = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    try {
      const resolved = resolveValidationRegistryAddress();
      const strict = isStrictOnchainMode();

      if (!resolved.address) {
        if (strict) {
          throw new Error('[ERC8004-VAL] Missing ERC8004_VALIDATION_V2_ADDRESS (or ERC8004_VALIDATION_ADDRESS alias)');
        }
        console.warn('[ERC8004-VAL] Missing config — mock mode');
        return;
      }

      const provider = getSharedProvider();
      this.signer = getSharedSigner('erc8004_validation');
      this.signerAddress = getSharedSignerAddress('erc8004_validation');
      if (!this.signer || !this.signerAddress) {
        if (strict) {
          throw new Error('[ERC8004-VAL] Validation signer is unavailable');
        }
        console.warn('[ERC8004-VAL] Shared deployer signer missing — mock mode');
        return;
      }
      this.contract = new ethers.Contract(resolved.address, VALIDATION_REGISTRY_ABI, this.signer);
      this.initialized = true;
      console.log(`[ERC8004-VAL] Validation Registry at ${resolved.address.slice(0, 10)}... (${resolved.source})`);
    } catch (err) {
      if (isStrictOnchainMode()) {
        throw formatOnchainError('ERC8004 validation init failed', err);
      }
      console.warn('[ERC8004-VAL] Init failed:', err);
    }
  }

  isConfigured(): boolean {
    return this.initialized && !!this.contract;
  }

  getProtocolState(): {
    configured: boolean;
    contractAddress: string | null;
    addressSource: 'v2_env' | 'legacy_env_alias' | 'unset';
    requestWriteMode: 'owner_or_operator_required' | 'mock';
    responseWriteMode: 'assigned_validator_required' | 'mock';
  } {
    const resolved = resolveValidationRegistryAddress();
    return {
      configured: this.isConfigured(),
      contractAddress: resolved.address,
      addressSource: resolved.source,
      requestWriteMode: this.isConfigured() ? 'owner_or_operator_required' : 'mock',
      responseWriteMode: this.isConfigured() ? 'assigned_validator_required' : 'mock',
    };
  }

  /**
   * Request validation for an intel item.
   * Called when intel is produced — creates on-chain commitment.
   */
  async requestValidation(params: {
    producerTokenId: number;
    intelItemId: number;
    category: string;
    contentHash: string;
  }): Promise<{ requestHash: string; txHash: string | null }> {
    const { producerTokenId, intelItemId, category, contentHash } = params;

    // Deterministic request hash from item details
    const requestHash = ethers.id(`intel_${intelItemId}_${contentHash}`);
    let txHash: string | null = null;

    if (this.isConfigured()) {
      try {
        const canRequest = await this.canSignerRequestForAgent(producerTokenId);
        if (canRequest) {
          txHash = await executeRoleWrite('erc8004_validation', `erc8004.validationRequest:${intelItemId}`, async () => {
            const tx = await this.contract!.validationRequest(
              this.signerAddress!,
              producerTokenId,
              `civilis://intel/${intelItemId}`,
              requestHash,
            );
            const receipt = await tx.wait();
            return receipt?.hash ?? null;
          });
        }
      } catch (err) {
        console.warn('[ERC8004-VAL] On-chain request failed:', err);
      }
    }

    // Record locally
    const pool = getPool();
    await pool.query(
      `INSERT INTO erc8004_validations
        (request_hash, agent_erc8004_id, intel_item_id, category, status, on_chain_tx_hash, sync_state)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       ON CONFLICT (request_hash) DO NOTHING`,
      [requestHash, producerTokenId, intelItemId, category, txHash, txHash ? 'mixed' : 'legacy'],
    );

    return { requestHash, txHash };
  }

  /**
   * Respond to a validation request after buyers verify accuracy.
   * Called after 3+ buyers have verified the intel.
   */
  async respondValidation(params: {
    requestHash: string;
    accuracyScore: number; // 0-100
    verifiedByCount: number;
    isFake: boolean;
  }): Promise<{ txHash: string | null }> {
    const { requestHash, accuracyScore, verifiedByCount, isFake } = params;

    const response = Math.min(100, Math.max(0, Math.round(accuracyScore)));
    const tag = isFake ? 'fake_detected' : 'verified';
    let txHash: string | null = null;

    if (this.isConfigured()) {
      try {
        const responseHash = ethers.id(`verified_${requestHash}_${accuracyScore}_${verifiedByCount}`);

        const status = await this.contract!.getValidationStatus(requestHash);
        const validatorAddress = String(status?.validatorAddress ?? status?.[0] ?? ethers.ZeroAddress);

        if (
          validatorAddress !== ethers.ZeroAddress &&
          this.signerAddress &&
          validatorAddress.toLowerCase() === this.signerAddress.toLowerCase()
        ) {
          txHash = await executeRoleWrite('erc8004_validation', `erc8004.validationResponse:${requestHash}`, async () => {
            const tx = await this.contract!.validationResponse(
              requestHash,
              response,
              '',
              responseHash,
              tag,
            );
            const receipt = await tx.wait();
            return receipt?.hash ?? null;
          });
        }
      } catch (err) {
        console.warn('[ERC8004-VAL] On-chain response failed:', err);
      }
    }

    // Update local
    const pool = getPool();
    await pool.query(
      `UPDATE erc8004_validations
       SET status = 'responded', response_score = $1, verified_by_count = $2,
           is_fake = $3, responded_at = NOW(), response_tx_hash = $4,
           sync_state = CASE WHEN $4::text IS NULL THEN 'mixed' ELSE 'v2' END
       WHERE request_hash = $5`,
      [response, verifiedByCount, isFake, txHash, requestHash],
    );

    return { txHash };
  }

  /**
   * Get validation summary for an agent's produced intel.
   */
  async getProducerValidationSummary(tokenId: number): Promise<{
    totalValidations: number;
    averageScore: number;
    fakeCount: number;
    verifiedCount: number;
    onChainCount?: number;
    onChainAverageScore?: number;
  }> {
    const pool = getPool();
    const r = await pool.query<{
      total: string;
      avg_score: string;
      fake_count: string;
      verified_count: string;
    }>(
      `SELECT
        COUNT(*) as total,
        COALESCE(AVG(response_score), 0) as avg_score,
        COUNT(*) FILTER (WHERE is_fake) as fake_count,
        COUNT(*) FILTER (WHERE status = 'responded' AND NOT is_fake) as verified_count
       FROM erc8004_validations
       WHERE agent_erc8004_id = $1`,
      [tokenId],
    );

    let onChainCount = 0;
    let onChainAverageScore = 0;
    if (this.isConfigured()) {
      try {
        const requestHashes = await this.contract!.getAgentValidations(tokenId);
        const validators = new Set<string>();

        for (const requestHash of requestHashes as string[]) {
          const status = await this.contract!.getValidationStatus(requestHash);
          const validator = String(status[0] ?? ethers.ZeroAddress);
          if (validator !== ethers.ZeroAddress) {
            validators.add(validator);
          }
        }

        if (validators.size > 0) {
          const summary = await this.contract!.getSummary(tokenId, [...validators], '');
          onChainCount = Number(summary[0] ?? 0);
          onChainAverageScore = Number(summary[1] ?? 0);
        }
      } catch (error) {
        console.warn('[ERC8004-VAL] on-chain summary lookup failed:', error);
      }
    }

    return {
      totalValidations: Number(r.rows[0]?.total ?? 0),
      averageScore: Number(Number(r.rows[0]?.avg_score ?? 0).toFixed(1)),
      fakeCount: Number(r.rows[0]?.fake_count ?? 0),
      verifiedCount: Number(r.rows[0]?.verified_count ?? 0),
      onChainCount,
      onChainAverageScore,
    };
  }

  async getProducerValidationView(tokenId: number): Promise<{
    localLedger: { totalValidations: number; averageScore: number; fakeCount: number; verifiedCount: number };
    onChainSummary: { count: number; averageScore: number } | null;
    syncState: 'empty' | 'local_only' | 'mixed';
  }> {
    const local = await this.getProducerValidationSummary(tokenId);
    const onChainSummary =
      (local.onChainCount ?? 0) > 0
        ? {
            count: local.onChainCount ?? 0,
            averageScore: local.onChainAverageScore ?? 0,
          }
        : null;

    return {
      localLedger: {
        totalValidations: local.totalValidations,
        averageScore: local.averageScore,
        fakeCount: local.fakeCount,
        verifiedCount: local.verifiedCount,
      },
      onChainSummary,
      syncState: onChainSummary ? 'mixed' : (local.totalValidations > 0 ? 'local_only' : 'empty'),
    };
  }

  private async canSignerRequestForAgent(agentId: number): Promise<boolean> {
    if (!this.signerAddress) {
      return false;
    }
    const identityAddress = resolveIdentityRegistryAddress();
    if (!identityAddress) {
      return false;
    }

    const identity = new ethers.Contract(identityAddress, IDENTITY_OWNER_ABI, getSharedProvider());
    const owner = String(await identity.ownerOf(agentId));
    const approved = String(await identity.getApproved(agentId));
    const approvedForAll = Boolean(await identity.isApprovedForAll(owner, this.signerAddress));

    return (
      owner.toLowerCase() === this.signerAddress.toLowerCase()
      || approved.toLowerCase() === this.signerAddress.toLowerCase()
      || approvedForAll
    );
  }
}

/* ── Singleton Export ── */
export const validationRegistry = new ValidationRegistryClient();

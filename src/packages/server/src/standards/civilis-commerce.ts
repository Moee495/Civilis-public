import { ethers } from 'ethers';
import { getAgentWalletAddressStrict } from '../agents/wallet-sync.js';
import { executeRoleWrite, getSharedSigner } from '../onchainos/shared-signers.js';
import { formatOnchainError, isStrictOnchainMode } from '../config/xlayer.js';

const LEGACY_COMMERCE_ABI = [
  'function createArenaJob(string playerA, string playerB, address clientAddr, address providerAddr, uint256 entryFee, uint256 timeoutSeconds) returns (uint256)',
  'function settleArenaJob(uint256 jobId, uint8 actionA, uint8 actionB, uint256 payoutA, uint256 payoutB)',
  'function createDivinationJob(string agentId, string dimension, address clientAddr, uint256 price) returns (uint256)',
  'function completeDivination(uint256 jobId, bytes32 fateResult)',
  'function getJob(uint256 jobId) view returns (tuple(uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status))',
] as const;

const V2_COMMERCE_ABI = [
  'function acpKernel() view returns (address)',
  'function mapBusiness(bytes32 businessRef, uint8 businessType, bytes32 businessSubtype, uint256 jobId)',
  'function closeMapping(bytes32 businessRef, bytes32 statusInfo)',
  'function getBusinessLink(bytes32 businessRef) view returns (tuple(bytes32 businessRef,uint256 jobId,uint8 businessType,bytes32 businessSubtype,uint8 status,bytes32 statusInfo,address mappedBy,uint256 mappedAt,uint256 updatedAt))',
  'function getBusinessRefForJob(uint256 jobId) view returns (bytes32)',
] as const;

type CommerceMode = 'v2_mapping' | 'legacy_job_registry' | 'mock';

let commerceContract: ethers.Contract | null = null;
let commerceMode: CommerceMode = 'mock';
let commerceAddressSource: 'v2_env' | 'legacy_env_alias' | 'unset' = 'unset';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = ethers.ZeroHash;

const COMMERCE_STATUS_LABEL: Record<number, 'open' | 'funded' | 'submitted' | 'completed' | 'rejected' | 'expired'> = {
  0: 'open',
  1: 'funded',
  2: 'submitted',
  3: 'completed',
  4: 'rejected',
  5: 'expired',
};

function resolveCommerceConfig(): {
  address: string | null;
  mode: CommerceMode;
  source: 'v2_env' | 'legacy_env_alias' | 'unset';
} {
  if (process.env.CIVILIS_COMMERCE_V2_ADDRESS) {
    return {
      address: process.env.CIVILIS_COMMERCE_V2_ADDRESS,
      mode: 'v2_mapping',
      source: 'v2_env',
    };
  }

  if (process.env.CIVILIS_COMMERCE_ADDRESS) {
    return {
      address: process.env.CIVILIS_COMMERCE_ADDRESS,
      mode: 'legacy_job_registry',
      source: 'legacy_env_alias',
    };
  }

  return {
    address: null,
    mode: 'mock',
    source: 'unset',
  };
}

export function initCivilisCommerce(): void {
  const signer = getSharedSigner('commerce');
  const resolved = resolveCommerceConfig();

  commerceMode = resolved.mode;
  commerceAddressSource = resolved.source;

  if (!signer || !resolved.address) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Missing commerce contract address or signer');
    }
    commerceContract = null;
    return;
  }

  const abi = resolved.mode === 'v2_mapping' ? V2_COMMERCE_ABI : LEGACY_COMMERCE_ABI;
  commerceContract = new ethers.Contract(resolved.address, abi, signer);
}

export function isCivilisCommerceConfigured(): boolean {
  return commerceContract !== null;
}

export function getCivilisCommerceProtocolState(): {
  configured: boolean;
  mode: CommerceMode;
  addressSource: 'v2_env' | 'legacy_env_alias' | 'unset';
  mappingOnly: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  if (commerceMode === 'v2_mapping') {
    notes.push('mapping_layer_only');
    notes.push('no_escrow_or_payment_state');
  }
  if (commerceAddressSource === 'legacy_env_alias') {
    notes.push('address_comes_from_CIVILIS_COMMERCE_ADDRESS_alias');
  }
  return {
    configured: commerceContract !== null,
    mode: commerceMode,
    addressSource: commerceAddressSource,
    mappingOnly: commerceMode === 'v2_mapping',
    notes,
  };
}

function padGasEstimate(estimate: bigint): bigint {
  return estimate + estimate / 5n + 20_000n;
}

function encodeBytes32Label(value: string): string {
  return ethers.encodeBytes32String(value.slice(0, 31));
}

type BusinessLinkView = {
  businessRef: string;
  jobId: number;
  status: 'linked' | 'closed';
};

async function readBusinessLink(businessRef: string): Promise<BusinessLinkView | null> {
  if (!commerceContract || commerceMode !== 'v2_mapping') {
    return null;
  }

  try {
    const link = await commerceContract.getBusinessLink(businessRef);
    const resolvedRef = String(link.businessRef ?? link[0] ?? ZERO_HASH);
    const resolvedJobId = Number(link.jobId ?? link[1] ?? 0);
    const resolvedStatus = Number(link.status ?? link[4] ?? 0);

    if (resolvedRef === ZERO_HASH) {
      return null;
    }

    return {
      businessRef: resolvedRef,
      jobId: resolvedJobId,
      status: resolvedStatus === 1 ? 'closed' : 'linked',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown business ref/i.test(message)) {
      return null;
    }
    throw error;
  }
}

export function getArenaBusinessRef(matchId: number): string {
  return ethers.id(`arena:match:${matchId}`);
}

export async function ensureArenaBusinessMapping(
  matchId: number,
  matchType: string,
  onChainJobId: number,
): Promise<{ businessRef: string; jobId: number; status: 'linked' | 'closed' }> {
  const contract = commerceContract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Arena business mapping contract is not configured in strict mode');
    }

    return {
      businessRef: getArenaBusinessRef(matchId),
      jobId: onChainJobId,
      status: 'linked',
    };
  }

  if (commerceMode !== 'v2_mapping') {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] ensureArenaBusinessMapping is only available in CivilisCommerceV2 mapping mode');
    }

    return {
      businessRef: getArenaBusinessRef(matchId),
      jobId: onChainJobId,
      status: 'linked',
    };
  }

  const businessRef = getArenaBusinessRef(matchId);
  const existingRef = await contract.getBusinessRefForJob(onChainJobId);
  if (existingRef && existingRef !== ZERO_HASH) {
    if (String(existingRef).toLowerCase() !== businessRef.toLowerCase()) {
      throw new Error(
        `[Commerce] ACP job ${onChainJobId} is already mapped to a different business ref`,
      );
    }

    const existingLink = await readBusinessLink(businessRef);
    return {
      businessRef,
      jobId: existingLink?.jobId ?? onChainJobId,
      status: existingLink?.status ?? 'linked',
    };
  }

  const existingLink = await readBusinessLink(businessRef);
  if (existingLink) {
    if (existingLink.jobId !== onChainJobId) {
      throw new Error(
        `[Commerce] arena business ref for match ${matchId} is already linked to job ${existingLink.jobId}`,
      );
    }

    return {
      businessRef,
      jobId: existingLink.jobId,
      status: existingLink.status,
    };
  }

  const businessSubtype = encodeBytes32Label(matchType || 'match');
  await executeRoleWrite('commerce', `commerce.mapArenaBusiness:${matchId}:${onChainJobId}`, async (signer) => {
    try {
      const connected = contract.connect(signer) as any;
      const gas = await connected.mapBusiness.estimateGas(businessRef, 0, businessSubtype, onChainJobId);
      const tx = await connected.mapBusiness(
        businessRef,
        0,
        businessSubtype,
        onChainJobId,
        { gasLimit: padGasEstimate(gas) },
      );
      await tx.wait();
      return null;
    } catch (error) {
      throw formatOnchainError(`commerce mapBusiness failed for arena match ${matchId}`, error);
    }
  });

  return {
    businessRef,
    jobId: onChainJobId,
    status: 'linked',
  };
}

export async function closeArenaBusinessMapping(
  matchId: number,
  statusInfo = 'settled',
): Promise<string | null> {
  const contract = commerceContract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Arena business mapping contract is not configured in strict mode');
    }
    return null;
  }

  if (commerceMode !== 'v2_mapping') {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] closeArenaBusinessMapping is only available in CivilisCommerceV2 mapping mode');
    }
    return null;
  }

  const businessRef = getArenaBusinessRef(matchId);
  const existingLink = await readBusinessLink(businessRef);
  if (!existingLink || existingLink.status === 'closed') {
    return null;
  }

  const encodedStatusInfo = encodeBytes32Label(statusInfo);
  const receipt = await executeRoleWrite('commerce', `commerce.closeArenaBusiness:${matchId}`, async (signer) => {
    try {
      const connected = contract.connect(signer) as any;
      const gas = await connected.closeMapping.estimateGas(businessRef, encodedStatusInfo);
      const tx = await connected.closeMapping(
        businessRef,
        encodedStatusInfo,
        { gasLimit: padGasEstimate(gas) },
      );
      return await tx.wait();
    } catch (error) {
      throw formatOnchainError(`commerce closeMapping failed for arena match ${matchId}`, error);
    }
  });

  return receipt?.hash ?? null;
}

export async function getBusinessRefForJob(jobId: number): Promise<string | null> {
  if (!commerceContract || commerceMode !== 'v2_mapping') {
    return null;
  }

  const businessRef = await commerceContract.getBusinessRefForJob(jobId);
  return businessRef === ethers.ZeroHash ? null : String(businessRef);
}

export async function getArenaJobState(jobId: number): Promise<'missing' | 'open' | 'funded' | 'submitted' | 'completed' | 'rejected' | 'expired'> {
  const contract = commerceContract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Arena state contract is not configured in strict mode');
    }
    return 'missing';
  }

  if (commerceMode === 'v2_mapping') {
    const businessRef = await contract.getBusinessRefForJob(jobId);
    return businessRef && businessRef !== ethers.ZeroHash ? 'open' : 'missing';
  }

  const job = await contract.getJob(jobId) as Record<string, unknown> & Array<unknown>;
  const resolvedId = Number(job.id ?? job[0] ?? 0);
  const resolvedClient = String(job.client ?? job[1] ?? ZERO_ADDRESS);
  const resolvedProvider = String(job.provider ?? job[2] ?? ZERO_ADDRESS);
  const resolvedStatus = Number(job.status ?? job[7] ?? 0);

  if (
    resolvedId === 0 &&
    resolvedClient.toLowerCase() === ZERO_ADDRESS &&
    resolvedProvider.toLowerCase() === ZERO_ADDRESS
  ) {
    return 'missing';
  }

  return COMMERCE_STATUS_LABEL[resolvedStatus] ?? 'open';
}

export async function createArenaJob(
  playerAId: string,
  playerBId: string,
  entryFee: number,
): Promise<number> {
  const contract = commerceContract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Arena job contract is not configured in strict mode');
    }
    return Date.now();
  }

  if (commerceMode === 'v2_mapping') {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] createArenaJob is a legacy writer path and is unavailable in CivilisCommerceV2 mapping-only mode');
    }
    return Date.now();
  }

  const [playerAAddress, playerBAddress] = await Promise.all([
    getAgentWalletAddressStrict(playerAId),
    getAgentWalletAddressStrict(playerBId),
  ]);

  const receipt = await executeRoleWrite('commerce', `commerce.createArenaJob:${playerAId}:${playerBId}`, async () => {
    try {
      const tx = await contract.createArenaJob(
        playerAId,
        playerBId,
        playerAAddress,
        playerBAddress,
        ethers.parseUnits(entryFee.toFixed(6), 6),
        300,
      );
      return tx.wait();
    } catch (error) {
      throw formatOnchainError(`commerce createArenaJob failed for ${playerAId}/${playerBId}`, error);
    }
  });
  const log = receipt?.logs[0];
  return log?.topics?.[1] ? Number(log.topics[1]) : Date.now();
}

const ACTION_TO_UINT8: Record<string, number> = {
  cooperate: 1, betray: 2,
  claim_low: 3, claim_mid: 4, claim_high: 5,
  bid_low: 6, bid_mid: 7, bid_high: 8,
};

export async function settleArenaJob(
  jobId: number,
  actionA: string,
  actionB: string,
  payoutA: number,
  payoutB: number,
): Promise<string | null> {
  const contract = commerceContract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Arena settlement contract is not configured in strict mode');
    }
    return null;
  }

  if (commerceMode === 'v2_mapping') {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] settleArenaJob is a legacy writer path and is unavailable in CivilisCommerceV2 mapping-only mode');
    }
    return null;
  }

  const receipt = await executeRoleWrite('commerce', `commerce.settleArenaJob:${jobId}`, async () => {
    try {
      const tx = await contract.settleArenaJob(
        jobId,
        ACTION_TO_UINT8[actionA] ?? 0,
        ACTION_TO_UINT8[actionB] ?? 0,
        ethers.parseUnits(payoutA.toFixed(6), 6),
        ethers.parseUnits(payoutB.toFixed(6), 6),
      );
      return tx.wait();
    } catch (error) {
      throw formatOnchainError(`commerce settleArenaJob failed for ${jobId}`, error);
    }
  });
  return receipt?.hash ?? null;
}

export async function createDivinationJob(
  agentId: string,
  dimension: string,
  price: number,
): Promise<number> {
  const contract = commerceContract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Divination contract is not configured in strict mode');
    }
    return Date.now();
  }

  if (commerceMode === 'v2_mapping') {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] createDivinationJob is a legacy writer path and is unavailable in CivilisCommerceV2 mapping-only mode');
    }
    return Date.now();
  }

  const agentAddress = await getAgentWalletAddressStrict(agentId);
  const receipt = await executeRoleWrite('commerce', `commerce.createDivination:${agentId}:${dimension}`, async () => {
    try {
      const tx = await contract.createDivinationJob(
        agentId,
        dimension,
        agentAddress,
        ethers.parseUnits(price.toFixed(6), 6),
      );
      return tx.wait();
    } catch (error) {
      throw formatOnchainError(`commerce createDivination failed for ${agentId}:${dimension}`, error);
    }
  });
  const log = receipt?.logs[0];
  return log?.topics?.[1] ? Number(log.topics[1]) : Date.now();
}

export async function completeDivination(
  jobId: number,
  resultHash: string,
): Promise<string | null> {
  const contract = commerceContract;
  if (!contract) {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] Divination completion contract is not configured in strict mode');
    }
    return null;
  }

  if (commerceMode === 'v2_mapping') {
    if (isStrictOnchainMode()) {
      throw new Error('[Commerce] completeDivination is a legacy writer path and is unavailable in CivilisCommerceV2 mapping-only mode');
    }
    return null;
  }

  const receipt = await executeRoleWrite('commerce', `commerce.completeDivination:${jobId}`, async () => {
    try {
      const tx = await contract.completeDivination(jobId, resultHash);
      return tx.wait();
    } catch (error) {
      throw formatOnchainError(`commerce completeDivination failed for ${jobId}`, error);
    }
  });
  return receipt?.hash ?? null;
}

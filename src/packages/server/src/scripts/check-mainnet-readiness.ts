import '../config/load-env.js';
import { ethers } from 'ethers';
import {
  getX402PaymentMode,
  getXLayerChainId,
  getXLayerNetwork,
  getXLayerRpcUrl,
  isStrictOnchainMode,
  isX402DirectWalletMode,
} from '../config/xlayer.js';
import { resolveX402ServiceTarget } from '../config/x402-service.js';
import { getSoulArchiveMode, isSoulArchiveModeExplicit } from '../config/soul-archive.js';
import {
  getSharedProvider,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';

const ACCESS_CONTROL_ABI = [
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function MAPPER_ROLE() view returns (bytes32)',
  'function acpKernel() view returns (address)',
] as const;

type AddressSource = 'v2_env' | 'legacy_env_alias' | 'unset';
type ExecutionTarget = 'mainnet' | 'testnet';

interface ContractConfigStatus {
  name: string;
  envKey: string;
  legacyAliasEnvKey?: string;
  address: string | null;
  source: AddressSource;
  configured: boolean;
  placeholder: boolean;
  roleModel: string;
  notes: string[];
}

type LayerState = 'v2_ready' | 'mixed' | 'legacy_only' | 'incomplete';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveExecutionTarget(): ExecutionTarget {
  const cliValue = process.argv
    .find((arg) => arg.startsWith('--target='))
    ?.split('=', 2)[1]
    ?.trim()
    .toLowerCase();
  const envValue = process.env.PREFLIGHT_EXPECTED_NETWORK?.trim().toLowerCase();
  const candidate = cliValue || envValue || 'mainnet';

  return candidate === 'testnet' || candidate === 'staging' ? 'testnet' : 'mainnet';
}

function redactValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return '<redacted>';
}

function isPlaceholderValue(value: string | undefined | null): boolean {
  if (!value) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === ethers.ZeroAddress.toLowerCase() ||
    normalized.includes('your-') ||
    normalized.includes('to-be-deployed') ||
    normalized.includes('placeholder') ||
    normalized.includes('tbd')
  );
}

function resolveAddress(envKey: string, legacyAliasEnvKey?: string): ContractConfigStatus {
  const primary = process.env[envKey];
  const alias = legacyAliasEnvKey ? process.env[legacyAliasEnvKey] : undefined;
  const source: AddressSource = primary
    ? 'v2_env'
    : alias
      ? 'legacy_env_alias'
      : 'unset';
  const address = primary || alias || null;
  const placeholder = isPlaceholderValue(address);
  const notes: string[] = [];

  if (source === 'legacy_env_alias' && legacyAliasEnvKey) {
    notes.push(`using_legacy_alias:${legacyAliasEnvKey}`);
  }
  if (placeholder && address) {
    notes.push('placeholder_or_zero_address');
  }

  return {
    name: envKey.replace(/_ADDRESS$/, '').toLowerCase(),
    envKey,
    legacyAliasEnvKey,
    address,
    source,
    configured: Boolean(address) && !placeholder,
    placeholder,
    roleModel: 'unknown',
    notes,
  };
}

function missingOrPlaceholder(key: string | undefined): boolean {
  if (!key) {
    return true;
  }
  return isPlaceholderValue(process.env[key]);
}

async function readMapperRole(contractAddress: string | null, signerAddress: string | null): Promise<boolean | null> {
  if (!contractAddress || !signerAddress || isPlaceholderValue(contractAddress)) {
    return null;
  }

  try {
    const contract = new ethers.Contract(contractAddress, ACCESS_CONTROL_ABI, getSharedProvider());
    const role = await contract.MAPPER_ROLE();
    return contract.hasRole(role, signerAddress);
  } catch {
    return null;
  }
}

async function readCommerceKernel(contractAddress: string | null): Promise<string | null> {
  if (!contractAddress || isPlaceholderValue(contractAddress)) {
    return null;
  }

  try {
    const contract = new ethers.Contract(contractAddress, ACCESS_CONTROL_ABI, getSharedProvider());
    const kernel = await contract.acpKernel();
    return String(kernel);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const redact = hasFlag('--redact');
  const executionTarget = resolveExecutionTarget();
  const network = getXLayerNetwork();
  const chainId = getXLayerChainId();
  const paymentMode = getX402PaymentMode();

  const signers = {
    deployer: getSharedSignerAddress('deployer'),
    treasury: getSharedSignerAddress('treasury'),
    acp: getSharedSignerAddress('acp'),
    commerce: getSharedSignerAddress('commerce'),
    identity: getSharedSignerAddress('erc8004_identity'),
    reputation: getSharedSignerAddress('erc8004_reputation'),
    validation: getSharedSignerAddress('erc8004_validation'),
    soul: getSharedSignerAddress('soul'),
  };

  const balances = Object.fromEntries(await Promise.all(
    Object.entries(signers).map(async ([key, address]) => {
      if (!address) {
        return [key, null] as const;
      }

      const balance = await getSharedProvider().getBalance(address);
      return [key, ethers.formatEther(balance)] as const;
    }),
  ));

  const acpV2 = {
    ...resolveAddress('ACP_V2_CONTRACT_ADDRESS', 'ACP_CONTRACT_ADDRESS'),
    roleModel: 'no_access_control',
  };
  const commerceV2 = {
    ...resolveAddress('CIVILIS_COMMERCE_V2_ADDRESS', 'CIVILIS_COMMERCE_ADDRESS'),
    roleModel: 'access_control_mapper',
  };
  const identityV2 = {
    ...resolveAddress('ERC8004_IDENTITY_V2_ADDRESS', 'ERC8004_IDENTITY_ADDRESS'),
    roleModel: 'owner_or_operator',
  };
  const reputationV2 = {
    ...resolveAddress('ERC8004_REPUTATION_V2_ADDRESS', 'ERC8004_REPUTATION_ADDRESS'),
    roleModel: 'client_signer_required',
  };
  const validationV2 = {
    ...resolveAddress('ERC8004_VALIDATION_V2_ADDRESS', 'ERC8004_VALIDATION_ADDRESS'),
    roleModel: 'owner_operator_request_and_assigned_validator_response',
  };

  const commerceMapperRole = await readMapperRole(commerceV2.address, signers.commerce);
  const commerceKernel = await readCommerceKernel(commerceV2.address);

  const requiredEnv: string[] = [
    'X_LAYER_RPC',
    'X_LAYER_CHAIN_ID',
    'DEPLOYER_PRIVATE_KEY',
    'TREASURY_PRIVATE_KEY',
    'ACP_PRIVATE_KEY',
    'CIVILIS_COMMERCE_PRIVATE_KEY',
    'ERC8004_IDENTITY_PRIVATE_KEY',
    'ERC8004_REPUTATION_PRIVATE_KEY',
    'ERC8004_VALIDATION_PRIVATE_KEY',
    'USDT_ADDRESS',
    'X402_SERVICE_ADDRESS',
  ].filter((key) => missingOrPlaceholder(key));

  if (isX402DirectWalletMode()) {
    for (const key of [
      'OKX_API_KEY',
      'OKX_SECRET_KEY',
      'OKX_PASSPHRASE',
      'OKX_PROJECT_ID',
    ]) {
      if (missingOrPlaceholder(key)) {
        requiredEnv.push(key);
      }
    }
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const x402Target = resolveX402ServiceTarget();
  const soulArchiveMode = getSoulArchiveMode();
  const soulArchiveModeExplicit = isSoulArchiveModeExplicit();

  if (network !== executionTarget) {
    blockers.push(`network_mismatch:expected_${executionTarget}:got_${network}`);
  }
  if (executionTarget === 'mainnet' && !isX402DirectWalletMode()) {
    blockers.push('x402_not_direct_wallet');
  } else if (executionTarget === 'testnet' && !isX402DirectWalletMode()) {
    info.push('x402_async_bridge_allowed_for_testnet');
  }
  if (requiredEnv.length) {
    blockers.push(`missing_or_placeholder_env:${requiredEnv.join(',')}`);
  }
  if (x402Target.kind === 'service_url') {
    blockers.push('x402_service_address_is_url_not_contract');
  } else if (x402Target.kind === 'invalid') {
    blockers.push('x402_service_address_invalid');
  }

  const soulMissing = !process.env.SOUL_NFT_ADDRESS || isPlaceholderValue(process.env.SOUL_NFT_ADDRESS);
  if (soulArchiveMode === 'onchain_mint') {
    if (soulMissing) {
      blockers.push('soul_nft_address_missing_or_placeholder');
    }
  } else if (executionTarget === 'mainnet' && !soulArchiveModeExplicit) {
    blockers.push('soul_archive_mode_not_explicit');
  } else if (soulMissing) {
    info.push('soul_archive_hash_only_without_contract');
  }

  for (const [label, config] of Object.entries({
    acpV2,
    commerceV2,
    identityV2,
    reputationV2,
    validationV2,
  })) {
    if (!config.address) {
      blockers.push(`missing_contract_address:${label}`);
      continue;
    }
    if (config.placeholder) {
      blockers.push(`placeholder_contract_address:${label}`);
    }
    if (config.source === 'legacy_env_alias') {
      blockers.push(`legacy_alias_in_use:${label}`);
      warnings.push(`legacy_alias_in_use:${label}`);
    }
  }

  if (!signers.acp) blockers.push('missing_signer:acp');
  if (!signers.commerce) blockers.push('missing_signer:commerce');
  if (!signers.identity) blockers.push('missing_signer:identity');
  if (!signers.reputation) blockers.push('missing_signer:reputation');
  if (!signers.validation) blockers.push('missing_signer:validation');

  if (commerceV2.configured) {
    if (commerceMapperRole === false) {
      blockers.push('missing_role:commerce.mapper');
    }
    if (commerceMapperRole === null) {
      blockers.push('unknown_role:commerce.mapper');
    }
    if (!commerceKernel || commerceKernel === ethers.ZeroAddress) {
      blockers.push('commerce_kernel_missing_or_zero');
    }
  }

  const paymentLayerState: LayerState = (
    !process.env.X402_SERVICE_ADDRESS ||
    isPlaceholderValue(process.env.X402_SERVICE_ADDRESS) ||
    x402Target.kind !== 'contract_address'
  )
    ? 'incomplete'
    : 'v2_ready';
  const protocolLayerState: LayerState =
    acpV2.configured && commerceV2.configured
      ? (acpV2.source === 'v2_env' && commerceV2.source === 'v2_env' ? 'v2_ready' : 'mixed')
      : ((acpV2.address || commerceV2.address) ? 'mixed' : 'incomplete');
  const trustLayerState: LayerState =
    identityV2.configured && reputationV2.configured && validationV2.configured
      ? (
          identityV2.source === 'v2_env' &&
          reputationV2.source === 'v2_env' &&
          validationV2.source === 'v2_env'
            ? 'v2_ready'
            : 'mixed'
        )
      : ((identityV2.address || reputationV2.address || validationV2.address) ? 'mixed' : 'incomplete');
  const overallState: LayerState =
    blockers.length === 0 &&
    paymentLayerState === 'v2_ready' &&
    protocolLayerState === 'v2_ready' &&
    trustLayerState === 'v2_ready'
      ? 'v2_ready'
      : ((protocolLayerState === 'mixed' || trustLayerState === 'mixed') ? 'mixed' : 'incomplete');

  if (overallState !== 'v2_ready') {
    info.push(`current_state:${overallState}`);
  }
  if (protocolLayerState === 'mixed' || trustLayerState === 'mixed') {
    warnings.push('mixed_cutover_state_detected');
  }
  if (paymentLayerState !== 'v2_ready') {
    warnings.push('payment_layer_not_fully_configured');
  }

  const output = {
    strictMode: isStrictOnchainMode(),
    executionTarget,
    network,
    chainId,
    rpc: redact
      ? {
          configured: !isPlaceholderValue(getXLayerRpcUrl()),
          source: executionTarget === 'mainnet' ? 'X_LAYER_RPC_or_override' : 'X_LAYER_RPC',
          value: '<redacted>',
        }
      : getXLayerRpcUrl(),
    paymentMode,
    targetProfile:
      executionTarget === 'mainnet'
        ? 'mainnet:196/direct_wallet'
        : 'testnet:1952/async_or_direct',
    directWalletActive: isX402DirectWalletMode(),
    requiredEnvMissingOrPlaceholder: requiredEnv,
    soulArchiveMode,
    signers: redact
      ? Object.fromEntries(
          Object.entries(signers).map(([key, value]) => [key, {
            configured: Boolean(value),
            value: value ? '<redacted>' : null,
          }]),
        )
      : signers,
    balances: redact
      ? Object.fromEntries(
          Object.entries(balances).map(([key, value]) => [key, value === null ? null : '<redacted>']),
        )
      : balances,
    contracts: {
      acpV2: redact ? {
        ...acpV2,
        address: acpV2.address ? '<redacted>' : null,
      } : acpV2,
      commerceV2: {
        ...(redact ? {
          ...commerceV2,
          address: commerceV2.address ? '<redacted>' : null,
        } : commerceV2),
        mapperRoleGranted: commerceMapperRole,
        acpKernel: redactValue(commerceKernel),
      },
      identityV2: redact ? {
        ...identityV2,
        address: identityV2.address ? '<redacted>' : null,
      } : identityV2,
      reputationV2: redact ? {
        ...reputationV2,
        address: reputationV2.address ? '<redacted>' : null,
      } : reputationV2,
      validationV2: redact ? {
        ...validationV2,
        address: validationV2.address ? '<redacted>' : null,
      } : validationV2,
    },
    layers: {
      payment: paymentLayerState,
      protocol: protocolLayerState,
      trust: trustLayerState,
      overall: overallState,
    },
    warnings,
    info,
    blockers,
  };

  console.log(JSON.stringify(output, null, 2));

  if (blockers.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

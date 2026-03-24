import { ethers } from 'ethers';

export type XLayerNetwork = 'mainnet' | 'testnet';
export type X402PaymentMode = 'direct_wallet' | 'async_bridge';

const OFFICIAL_XLAYER = {
  mainnet: {
    chainId: 196,
    rpcUrl: 'https://rpc.xlayer.tech',
  },
  testnet: {
    chainId: 1952,
    rpcUrl: 'https://testrpc.xlayer.tech/terigon',
  },
} as const;

function normalizeNetwork(value: string | undefined): XLayerNetwork {
  return value === 'mainnet' ? 'mainnet' : 'testnet';
}

function normalizePaymentMode(value: string | undefined): X402PaymentMode | null {
  if (value === 'direct_wallet' || value === 'direct') {
    return 'direct_wallet';
  }

  if (value === 'async_bridge' || value === 'async') {
    return 'async_bridge';
  }

  return null;
}

export function getXLayerNetwork(): XLayerNetwork {
  return normalizeNetwork(process.env.X_LAYER_NETWORK);
}

export function getXLayerChainId(): number {
  const raw = process.env.X_LAYER_CHAIN_ID;
  if (raw && /^\d+$/.test(raw)) {
    return Number(raw);
  }

  return OFFICIAL_XLAYER[getXLayerNetwork()].chainId;
}

export function getXLayerRpcUrl(): string {
  return process.env.X_LAYER_RPC || OFFICIAL_XLAYER[getXLayerNetwork()].rpcUrl;
}

export function createXLayerProvider(rpcUrl: string = getXLayerRpcUrl()): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl, undefined, {
    // X Layer RPC rejects larger batched reads under current production limits.
    batchMaxCount: 1,
  });
}

export function getX402PaymentMode(): X402PaymentMode {
  const explicit = normalizePaymentMode(process.env.X402_PAYMENT_MODE);
  if (explicit) {
    return explicit;
  }

  return getXLayerNetwork() === 'mainnet' ? 'direct_wallet' : 'async_bridge';
}

export function isX402DirectWalletMode(): boolean {
  return getX402PaymentMode() === 'direct_wallet';
}

export function getXLayerCaip(): string {
  return `eip155:${getXLayerChainId()}`;
}

export function getUsdtAddress(): string {
  return process.env.USDT_ADDRESS || '';
}

export function isStrictOnchainMode(): boolean {
  if (process.env.CIVILIS_STRICT_MODE === 'false') {
    return false;
  }

  if (process.env.CIVILIS_STRICT_MODE === 'true') {
    return true;
  }

  return true;
}

export function missingRequiredOnchainEnv(): string[] {
  if (!isStrictOnchainMode()) {
    return [];
  }

  const required = [
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
  ];

  const requiredAddressGroups = [
    ['ACP_V2_CONTRACT_ADDRESS', 'ACP_CONTRACT_ADDRESS'],
    ['CIVILIS_COMMERCE_V2_ADDRESS', 'CIVILIS_COMMERCE_ADDRESS'],
    ['ERC8004_IDENTITY_V2_ADDRESS', 'ERC8004_IDENTITY_ADDRESS'],
    ['ERC8004_REPUTATION_V2_ADDRESS', 'ERC8004_REPUTATION_ADDRESS'],
    ['ERC8004_VALIDATION_V2_ADDRESS', 'ERC8004_VALIDATION_ADDRESS'],
  ] as const;

  if (isX402DirectWalletMode()) {
    required.push(
      'OKX_API_KEY',
      'OKX_SECRET_KEY',
      'OKX_PASSPHRASE',
      'OKX_PROJECT_ID',
    );
  }

  const missing = required.filter((key) => {
    const value = process.env[key];
    return !value || value.includes('your-');
  });

  for (const [preferredKey, aliasKey] of requiredAddressGroups) {
    const preferredValue = process.env[preferredKey];
    const aliasValue = process.env[aliasKey];
    const hasPreferred = Boolean(preferredValue && !preferredValue.includes('your-'));
    const hasAlias = Boolean(aliasValue && !aliasValue.includes('your-'));

    if (!hasPreferred && !hasAlias) {
      missing.push(preferredKey);
    }
  }

  return missing;
}

export function formatOnchainError(context: string, error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`[${context}] ${error.message}`);
  }

  return new Error(`[${context}] ${String(error)}`);
}

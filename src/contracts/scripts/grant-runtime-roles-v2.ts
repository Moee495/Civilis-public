import { ethers } from 'hardhat';

function normalizeOptional(value: string | undefined): string | null {
  if (!value || value.includes('your-')) {
    return null;
  }

  return value.trim();
}

function addressFromPrivateKey(privateKey: string | undefined): string | null {
  const normalized = normalizeOptional(privateKey);
  if (!normalized) {
    return null;
  }

  return new ethers.Wallet(normalized).address;
}

function resolveRoleAddress(
  fallbackAddress: string,
  options?: {
    explicitAddress?: string;
    privateKey?: string;
  },
): string {
  const explicitAddress = normalizeOptional(options?.explicitAddress);
  const derivedAddress = addressFromPrivateKey(options?.privateKey);

  if (
    explicitAddress &&
    derivedAddress &&
    explicitAddress.toLowerCase() !== derivedAddress.toLowerCase()
  ) {
    throw new Error(
      `Role address mismatch: ${explicitAddress} does not match private key ${derivedAddress}`,
    );
  }

  return derivedAddress ?? explicitAddress ?? fallbackAddress;
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const acpAddress = normalizeOptional(process.env.ACP_V2_CONTRACT_ADDRESS);
  const commerceAddress = normalizeOptional(process.env.CIVILIS_COMMERCE_V2_ADDRESS);
  const identityAddress = normalizeOptional(process.env.ERC8004_IDENTITY_V2_ADDRESS);
  const reputationAddress = normalizeOptional(process.env.ERC8004_REPUTATION_V2_ADDRESS);
  const validationAddress = normalizeOptional(process.env.ERC8004_VALIDATION_V2_ADDRESS);

  if (!acpAddress || !commerceAddress || !identityAddress || !reputationAddress || !validationAddress) {
    throw new Error('Missing one or more v2 contract addresses in env');
  }

  const mapperAddress = resolveRoleAddress(deployerAddress, {
    explicitAddress: process.env.CIVILIS_COMMERCE_MAPPER_ADDRESS,
    privateKey: process.env.CIVILIS_COMMERCE_PRIVATE_KEY,
  });

  const accessControlAbi = [
    'function hasRole(bytes32 role, address account) view returns (bool)',
    'function grantRole(bytes32 role, address account)',
    'function MAPPER_ROLE() view returns (bytes32)',
  ] as const;

  const commerce = new ethers.Contract(commerceAddress, accessControlAbi, deployer);
  const mapperRole = await commerce.MAPPER_ROLE();
  const hasMapperRole = await commerce.hasRole(mapperRole, mapperAddress);

  if (!hasMapperRole) {
    const tx = await commerce.grantRole(mapperRole, mapperAddress);
    await tx.wait();
    console.log(`[grant-role:v2] CivilisCommerceV2 mapper -> ${mapperAddress}`);
  } else {
    console.log(`[grant-role:v2] CivilisCommerceV2 mapper already granted to ${mapperAddress}`);
  }

  console.log(JSON.stringify({
    acpV2: {
      address: acpAddress,
      runtimeRoleModel: 'none',
      note: 'ACPV2 uses protocol roles embedded in job data; no AccessControl grants required',
    },
    commerceV2: {
      address: commerceAddress,
      mapperRoleGranted: true,
      mapperAddress,
    },
    identityV2: {
      address: identityAddress,
      runtimeRoleModel: 'owner_or_operator',
      note: 'No AccessControl runtime grants; writes require owner/operator semantics',
    },
    reputationV2: {
      address: reputationAddress,
      runtimeRoleModel: 'client_signer_required',
      note: 'No AccessControl runtime grants; writes require client signer',
    },
    validationV2: {
      address: validationAddress,
      runtimeRoleModel: 'owner_operator_request_and_assigned_validator_response',
      note: 'No AccessControl runtime grants; request/response permissions are data-driven',
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

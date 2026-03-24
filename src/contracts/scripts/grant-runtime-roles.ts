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
  roleName: string,
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
      `${roleName} address mismatch: ${explicitAddress} does not match private key ${derivedAddress}`,
    );
  }

  return derivedAddress ?? explicitAddress ?? fallbackAddress;
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const identityContractAddress = process.env.ERC8004_IDENTITY_ADDRESS;
  const reputationContractAddress = process.env.ERC8004_REPUTATION_ADDRESS;
  const validationContractAddress = process.env.ERC8004_VALIDATION_ADDRESS;
  const commerceContractAddress = process.env.CIVILIS_COMMERCE_ADDRESS;
  const x402ContractAddress = process.env.X402_SERVICE_ADDRESS;
  const acpContractAddress = process.env.ACP_CONTRACT_ADDRESS;

  if (
    !identityContractAddress ||
    !reputationContractAddress ||
    !validationContractAddress ||
    !commerceContractAddress ||
    !x402ContractAddress ||
    !acpContractAddress
  ) {
    throw new Error('Missing one or more deployed contract addresses in env');
  }

  const engineAddress = resolveRoleAddress('engine', deployerAddress, {
    explicitAddress: process.env.TREASURY_ADDRESS,
    privateKey: process.env.TREASURY_PRIVATE_KEY,
  });
  const roleAddresses = {
    acp: resolveRoleAddress('acp', engineAddress, { privateKey: process.env.ACP_PRIVATE_KEY }),
    commerce: resolveRoleAddress('commerce', engineAddress, { privateKey: process.env.CIVILIS_COMMERCE_PRIVATE_KEY }),
    identity: resolveRoleAddress('erc8004_identity', engineAddress, { privateKey: process.env.ERC8004_IDENTITY_PRIVATE_KEY }),
    reputation: resolveRoleAddress('erc8004_reputation', engineAddress, { privateKey: process.env.ERC8004_REPUTATION_PRIVATE_KEY }),
    validation: resolveRoleAddress('erc8004_validation', engineAddress, { privateKey: process.env.ERC8004_VALIDATION_PRIVATE_KEY }),
    treasury: engineAddress,
  };

  const accessControlAbi = [
    'function hasRole(bytes32 role, address account) view returns (bool)',
    'function grantRole(bytes32 role, address account)',
  ];

  const engineRole = ethers.keccak256(ethers.toUtf8Bytes('ENGINE_ROLE'));
  const registrarRole = ethers.keccak256(ethers.toUtf8Bytes('REGISTRAR_ROLE'));
  const evaluatorRole = ethers.keccak256(ethers.toUtf8Bytes('EVALUATOR_ROLE'));
  const validatorRole = ethers.keccak256(ethers.toUtf8Bytes('VALIDATOR_ROLE'));

  const grants: Array<{ label: string; contract: any; role: string; target: string }> = [
    {
      label: 'Identity registrar',
      contract: new ethers.Contract(identityContractAddress, accessControlAbi, deployer),
      role: registrarRole,
      target: roleAddresses.identity,
    },
    {
      label: 'Reputation evaluator',
      contract: new ethers.Contract(reputationContractAddress, accessControlAbi, deployer),
      role: evaluatorRole,
      target: roleAddresses.reputation,
    },
    {
      label: 'Validation validator',
      contract: new ethers.Contract(validationContractAddress, accessControlAbi, deployer),
      role: validatorRole,
      target: roleAddresses.validation,
    },
    {
      label: 'CivilisCommerce engine',
      contract: new ethers.Contract(commerceContractAddress, accessControlAbi, deployer),
      role: engineRole,
      target: roleAddresses.commerce,
    },
    {
      label: 'x402 engine',
      contract: new ethers.Contract(x402ContractAddress, accessControlAbi, deployer),
      role: engineRole,
      target: roleAddresses.treasury,
    },
    {
      label: 'ACP engine',
      contract: new ethers.Contract(acpContractAddress, accessControlAbi, deployer),
      role: engineRole,
      target: roleAddresses.acp,
    },
  ];

  for (const grant of grants) {
    const hasRole = await grant.contract.hasRole(grant.role, grant.target);
    if (hasRole) {
      console.log(`[grant-role] ${grant.label} already granted to ${grant.target}`);
      continue;
    }

    const tx = await grant.contract.grantRole(grant.role, grant.target);
    await tx.wait();
    console.log(`[grant-role] ${grant.label} -> ${grant.target}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

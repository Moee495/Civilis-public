import { ethers, network } from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';

function normalizeOptional(value: string | undefined): string | null {
  if (!value || value.includes('your-')) {
    return null;
  }

  return value.trim();
}

function resolveOutputPath(): string | null {
  const configured = process.env.DEPLOY_V2_OUTPUT_PATH?.trim();

  if (!configured) {
    return path.join(__dirname, '../.env.deployed.v2');
  }

  if (configured === 'none' || configured === 'stdout') {
    return null;
  }

  return path.resolve(configured);
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddress);

  console.log(`Deploying v2 stack with account: ${deployerAddress}`);
  console.log(`Balance: ${ethers.formatEther(balance)} OKB`);

  const paymentToken = normalizeOptional(process.env.USDT_ADDRESS);
  if (!paymentToken) {
    throw new Error('USDT_ADDRESS is required for ACPV2 deployment');
  }

  const ACPV2 = await ethers.getContractFactory('ACPV2');
  const acpV2 = await ACPV2.deploy(paymentToken);
  await acpV2.waitForDeployment();

  const CivilisCommerceV2 = await ethers.getContractFactory('CivilisCommerceV2');
  const commerceV2 = await CivilisCommerceV2.deploy(await acpV2.getAddress());
  await commerceV2.waitForDeployment();

  const ERC8004IdentityRegistryV2 = await ethers.getContractFactory('ERC8004IdentityRegistryV2');
  const identityV2 = await ERC8004IdentityRegistryV2.deploy();
  await identityV2.waitForDeployment();

  const ERC8004ReputationRegistryV2 = await ethers.getContractFactory('ERC8004ReputationRegistryV2');
  const reputationV2 = await ERC8004ReputationRegistryV2.deploy();
  await reputationV2.waitForDeployment();
  await (await reputationV2.initialize(await identityV2.getAddress())).wait();

  const ERC8004ValidationRegistryV2 = await ethers.getContractFactory('ERC8004ValidationRegistryV2');
  const validationV2 = await ERC8004ValidationRegistryV2.deploy();
  await validationV2.waitForDeployment();
  await (await validationV2.initialize(await identityV2.getAddress())).wait();

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    order: [
      'ACPV2(paymentToken)',
      'CivilisCommerceV2(acpKernel)',
      'ERC8004IdentityRegistryV2()',
      'ERC8004ReputationRegistryV2() + initialize(identityRegistry)',
      'ERC8004ValidationRegistryV2() + initialize(identityRegistry)',
    ],
    contracts: {
      ACP_V2_CONTRACT_ADDRESS: await acpV2.getAddress(),
      CIVILIS_COMMERCE_V2_ADDRESS: await commerceV2.getAddress(),
      ERC8004_IDENTITY_V2_ADDRESS: await identityV2.getAddress(),
      ERC8004_REPUTATION_V2_ADDRESS: await reputationV2.getAddress(),
      ERC8004_VALIDATION_V2_ADDRESS: await validationV2.getAddress(),
    },
  };

  const envOutput = [
    '# Civilis v2 deployment output',
    `# ${deployment.deployedAt}`,
    `# network=${deployment.network}`,
    `ACP_V2_CONTRACT_ADDRESS=${deployment.contracts.ACP_V2_CONTRACT_ADDRESS}`,
    `CIVILIS_COMMERCE_V2_ADDRESS=${deployment.contracts.CIVILIS_COMMERCE_V2_ADDRESS}`,
    `ERC8004_IDENTITY_V2_ADDRESS=${deployment.contracts.ERC8004_IDENTITY_V2_ADDRESS}`,
    `ERC8004_REPUTATION_V2_ADDRESS=${deployment.contracts.ERC8004_REPUTATION_V2_ADDRESS}`,
    `ERC8004_VALIDATION_V2_ADDRESS=${deployment.contracts.ERC8004_VALIDATION_V2_ADDRESS}`,
    '',
    '# Transitional aliases for older tooling',
    `ACP_CONTRACT_ADDRESS=${deployment.contracts.ACP_V2_CONTRACT_ADDRESS}`,
    `CIVILIS_COMMERCE_ADDRESS=${deployment.contracts.CIVILIS_COMMERCE_V2_ADDRESS}`,
    `ERC8004_IDENTITY_ADDRESS=${deployment.contracts.ERC8004_IDENTITY_V2_ADDRESS}`,
    `ERC8004_REPUTATION_ADDRESS=${deployment.contracts.ERC8004_REPUTATION_V2_ADDRESS}`,
    `ERC8004_VALIDATION_ADDRESS=${deployment.contracts.ERC8004_VALIDATION_V2_ADDRESS}`,
  ].join('\n');

  const outputPath = resolveOutputPath();
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, envOutput);
  }

  console.log(JSON.stringify(deployment, null, 2));
  console.log(
    outputPath
      ? `Wrote v2 deployment output to ${outputPath}`
      : 'Skipped env output file write (DEPLOY_V2_OUTPUT_PATH=none)',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

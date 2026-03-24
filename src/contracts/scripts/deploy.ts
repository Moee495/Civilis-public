import { ethers, network } from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';

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
  const balance = await ethers.provider.getBalance(deployerAddress);

  console.log(`Deploying with account: ${deployerAddress}`);
  console.log(`Balance: ${ethers.formatEther(balance)} OKB`);

  let usdtAddress = process.env.USDT_ADDRESS;
  const engineAddress = resolveRoleAddress('engine', deployerAddress, {
    explicitAddress: process.env.TREASURY_ADDRESS,
    privateKey: process.env.TREASURY_PRIVATE_KEY,
  });
  const acpAddress = resolveRoleAddress('acp', engineAddress, {
    privateKey: process.env.ACP_PRIVATE_KEY,
  });
  const commerceAddress = resolveRoleAddress('commerce', engineAddress, {
    privateKey: process.env.CIVILIS_COMMERCE_PRIVATE_KEY,
  });
  const identityAddress = resolveRoleAddress('erc8004_identity', engineAddress, {
    privateKey: process.env.ERC8004_IDENTITY_PRIVATE_KEY,
  });
  const reputationAddress = resolveRoleAddress('erc8004_reputation', engineAddress, {
    privateKey: process.env.ERC8004_REPUTATION_PRIVATE_KEY,
  });
  const validationAddress = resolveRoleAddress('erc8004_validation', engineAddress, {
    privateKey: process.env.ERC8004_VALIDATION_PRIVATE_KEY,
  });

  if (!usdtAddress && network.name === 'xlayerTestnet') {
    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const testUsdt = await TestUSDT.deploy(
      'Civilis Test USDT',
      'cUSDT',
      ethers.parseUnits('10000000', 6),
    );
    await testUsdt.waitForDeployment();
    usdtAddress = await testUsdt.getAddress();
    console.log(`Deployed TestUSDT at ${usdtAddress}`);
  }

  if (!usdtAddress) {
    throw new Error('USDT_ADDRESS is required for this deployment');
  }

  const AgentRegistry = await ethers.getContractFactory('AgentRegistry');
  const agentRegistry = await AgentRegistry.deploy();
  await agentRegistry.waitForDeployment();

  const ERC8004IdentityRegistry = await ethers.getContractFactory('ERC8004IdentityRegistry');
  const identityRegistry = await ERC8004IdentityRegistry.deploy();
  await identityRegistry.waitForDeployment();

  const ERC8004ReputationRegistry = await ethers.getContractFactory('ERC8004ReputationRegistry');
  const reputationRegistry = await ERC8004ReputationRegistry.deploy();
  await reputationRegistry.waitForDeployment();

  const ERC8004ValidationRegistry = await ethers.getContractFactory('ERC8004ValidationRegistry');
  const validationRegistry = await ERC8004ValidationRegistry.deploy();
  await validationRegistry.waitForDeployment();

  const SocialHub = await ethers.getContractFactory('SocialHub');
  const socialHub = await SocialHub.deploy();
  await socialHub.waitForDeployment();

  const ArenaGame = await ethers.getContractFactory('ArenaGame');
  const arenaGame = await ArenaGame.deploy();
  await arenaGame.waitForDeployment();

  const Treasury = await ethers.getContractFactory('Treasury');
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();

  const CivilisCommerce = await ethers.getContractFactory('CivilisCommerce');
  const commerce = await CivilisCommerce.deploy(usdtAddress);
  await commerce.waitForDeployment();

  const X402Service = await ethers.getContractFactory('x402Service');
  const x402Service = await X402Service.deploy(usdtAddress);
  await x402Service.waitForDeployment();

  const ACP = await ethers.getContractFactory('ACP');
  const acp = await ACP.deploy();
  await acp.waitForDeployment();

  const grants: Array<{ contract: any; role: Promise<string> | string; target: string; label: string }> = [
    { contract: agentRegistry, role: agentRegistry.ENGINE_ROLE(), target: engineAddress, label: 'AgentRegistry engine' },
    { contract: identityRegistry, role: identityRegistry.REGISTRAR_ROLE(), target: identityAddress, label: 'Identity registrar' },
    { contract: reputationRegistry, role: reputationRegistry.EVALUATOR_ROLE(), target: reputationAddress, label: 'Reputation evaluator' },
    { contract: validationRegistry, role: validationRegistry.VALIDATOR_ROLE(), target: validationAddress, label: 'Validation validator' },
    { contract: socialHub, role: socialHub.ENGINE_ROLE(), target: engineAddress, label: 'SocialHub engine' },
    { contract: arenaGame, role: arenaGame.ENGINE_ROLE(), target: engineAddress, label: 'ArenaGame engine' },
    { contract: treasury, role: treasury.ENGINE_ROLE(), target: engineAddress, label: 'Treasury engine' },
    { contract: commerce, role: commerce.ENGINE_ROLE(), target: commerceAddress, label: 'CivilisCommerce engine' },
    { contract: x402Service, role: x402Service.ENGINE_ROLE(), target: engineAddress, label: 'x402 engine' },
    { contract: acp, role: acp.ENGINE_ROLE(), target: acpAddress, label: 'ACP engine' },
  ];

  for (const grant of grants) {
    const role = await grant.role;
    const hasRole = await grant.contract.hasRole(role, grant.target);
    if (hasRole) {
      console.log(`[grant-role] ${grant.label} already granted to ${grant.target}`);
      continue;
    }

    const tx = await grant.contract.grantRole(role, grant.target);
    await tx.wait();
    console.log(`[grant-role] ${grant.label} -> ${grant.target}`);
  }

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    contracts: {
      USDT_ADDRESS: usdtAddress,
      AGENT_REGISTRY_ADDRESS: await agentRegistry.getAddress(),
      ERC8004_IDENTITY_ADDRESS: await identityRegistry.getAddress(),
      ERC8004_REPUTATION_ADDRESS: await reputationRegistry.getAddress(),
      ERC8004_VALIDATION_ADDRESS: await validationRegistry.getAddress(),
      SOCIAL_HUB_ADDRESS: await socialHub.getAddress(),
      ARENA_GAME_ADDRESS: await arenaGame.getAddress(),
      TREASURY_CONTRACT_ADDRESS: await treasury.getAddress(),
      CIVILIS_COMMERCE_ADDRESS: await commerce.getAddress(),
      X402_SERVICE_ADDRESS: await x402Service.getAddress(),
      ACP_CONTRACT_ADDRESS: await acp.getAddress(),
    },
  };

  const envOutput = [
    `# Civilis deployment`,
    `# ${deployment.deployedAt}`,
    `# network=${deployment.network}`,
    `USDT_ADDRESS=${deployment.contracts.USDT_ADDRESS}`,
    `AGENT_REGISTRY_ADDRESS=${deployment.contracts.AGENT_REGISTRY_ADDRESS}`,
    `ERC8004_IDENTITY_ADDRESS=${deployment.contracts.ERC8004_IDENTITY_ADDRESS}`,
    `ERC8004_REPUTATION_ADDRESS=${deployment.contracts.ERC8004_REPUTATION_ADDRESS}`,
    `ERC8004_VALIDATION_ADDRESS=${deployment.contracts.ERC8004_VALIDATION_ADDRESS}`,
    `SOCIAL_HUB_ADDRESS=${deployment.contracts.SOCIAL_HUB_ADDRESS}`,
    `ARENA_GAME_ADDRESS=${deployment.contracts.ARENA_GAME_ADDRESS}`,
    `TREASURY_CONTRACT_ADDRESS=${deployment.contracts.TREASURY_CONTRACT_ADDRESS}`,
    `CIVILIS_COMMERCE_ADDRESS=${deployment.contracts.CIVILIS_COMMERCE_ADDRESS}`,
    `X402_SERVICE_ADDRESS=${deployment.contracts.X402_SERVICE_ADDRESS}`,
    `ACP_CONTRACT_ADDRESS=${deployment.contracts.ACP_CONTRACT_ADDRESS}`,
  ].join('\n');

  const outputPath = path.join(__dirname, '../.env.deployed');
  fs.writeFileSync(outputPath, envOutput);

  console.log(JSON.stringify(deployment, null, 2));
  console.log(`Wrote deployment output to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

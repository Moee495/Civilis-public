import { ethers, network } from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const treasuryAddress = process.env.TREASURY_ADDRESS || deployerAddress;
  let usdtAddress = process.env.USDT_ADDRESS;

  console.log(`Deploying x402 with account: ${deployerAddress}`);

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
    throw new Error('USDT_ADDRESS is required to deploy x402Service');
  }

  const X402Service = await ethers.getContractFactory('x402Service');
  const x402Service = await X402Service.deploy(usdtAddress);
  await x402Service.waitForDeployment();

  const engineRole = await x402Service.ENGINE_ROLE();
  if (treasuryAddress.toLowerCase() !== deployerAddress.toLowerCase()) {
    const tx = await x402Service.grantRole(engineRole, treasuryAddress);
    await tx.wait();
  }

  const contractAddress = await x402Service.getAddress();
  const output = [
    `# x402 deployment ${new Date().toISOString()}`,
    `# network=${network.name}`,
    `USDT_ADDRESS=${usdtAddress}`,
    `X402_SERVICE_ADDRESS=${contractAddress}`,
  ].join('\n');

  const outputPath = path.join(__dirname, '../.env.x402');
  fs.writeFileSync(outputPath, output);

  console.log(
    JSON.stringify(
      {
        network: network.name,
        deployer: deployerAddress,
        treasuryAddress,
        usdtAddress,
        x402ServiceAddress: contractAddress,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote x402 env output to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

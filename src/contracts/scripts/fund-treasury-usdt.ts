import { ethers } from 'hardhat';

async function main(): Promise<void> {
  const treasuryAddress = process.env.TREASURY_ADDRESS;
  const usdtAddress = process.env.USDT_ADDRESS;
  const amount = Number(process.env.TREASURY_TESTNET_USDT_TOPUP_AMOUNT || '1000');

  if (!treasuryAddress) {
    throw new Error('TREASURY_ADDRESS not set');
  }
  if (!usdtAddress) {
    throw new Error('USDT_ADDRESS not set');
  }

  const [deployer] = await ethers.getSigners();
  const erc20 = await ethers.getContractAt(
    [
      'function decimals() view returns (uint8)',
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)',
    ],
    usdtAddress,
    deployer,
  );

  const decimals = await erc20.decimals();
  const before = await erc20.balanceOf(treasuryAddress);
  const tx = await erc20.transfer(treasuryAddress, ethers.parseUnits(amount.toString(), decimals));
  const receipt = await tx.wait();
  const after = await erc20.balanceOf(treasuryAddress);

  console.log(
    JSON.stringify(
      {
        success: true,
        deployer: await deployer.getAddress(),
        treasuryAddress,
        amount,
        txHash: receipt?.hash ?? null,
        before: ethers.formatUnits(before, decimals),
        after: ethers.formatUnits(after, decimals),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

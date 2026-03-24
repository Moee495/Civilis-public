import { ethers } from 'hardhat';

async function main(): Promise<void> {
  const address = process.env.X402_SERVICE_ADDRESS;
  if (!address) {
    throw new Error('X402_SERVICE_ADDRESS is required');
  }

  const abi = [
    'function getPaymentCount() view returns (uint256)',
    'function getBalance(address agent) view returns (uint256)',
  ];

  const provider = ethers.provider;
  const contract = new ethers.Contract(address, abi, provider);
  const sampleAgent = ethers.getAddress(`0x${ethers.id('oracle_1').slice(-40)}`);

  const [paymentCount, oracle1Balance] = await Promise.all([
    contract.getPaymentCount(),
    contract.getBalance(sampleAgent),
  ]);

  console.log(
    JSON.stringify(
      {
        paymentCount: Number(paymentCount),
        oracle1Balance: ethers.formatUnits(oracle1Balance, 6),
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

/**
 * Fund Agent Wallets with USDT on X Layer
 *
 * Run: npx tsx scripts/fund-agents.ts
 *
 * Transfers USDT from deployer wallet to each agent wallet.
 * Funding plan (from PRD):
 *   2 Scouts:    2 USDT each = 4 USDT (registration only)
 *   2 Analysts: 15 USDT each = 30 USDT (7 days of signal purchases)
 *   1 Executor: 30 USDT (advice purchases + trade capital)
 *   Treasury:    5 USDT (buffer)
 *   Total: ~69 USDT
 */

import { ethers } from "ethers";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

async function main() {
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    console.error("❌ DEPLOYER_PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  const rpcUrl =
    process.env.X_LAYER_RPC || "https://testrpc.xlayer.tech/terigon";
  const usdtAddress = process.env.USDT_ADDRESS;
  const x402Address = process.env.X402_SERVICE_ADDRESS;

  if (!usdtAddress) {
    console.error("❌ USDT_ADDRESS not set in .env");
    process.exit(1);
  }

  if (!x402Address) {
    console.error("❌ X402_SERVICE_ADDRESS not set in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployer = new ethers.Wallet(deployerKey, provider);
  const perAgentAmount = Number(process.env.AGENT_TESTNET_FUND_AMOUNT || "10");
  const treasuryAmount = Number(process.env.TREASURY_TESTNET_FUND_AMOUNT || "100");

  console.log(`\n💰 Funding Agent Wallet Balances Through x402`);
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Network:  X Layer Testnet\n`);

  const erc20ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
  ];
  const x402ABI = [
    "function depositFor(address agent, uint256 amount)",
  ];

  const usdt = new ethers.Contract(usdtAddress, erc20ABI, deployer);
  const x402 = new ethers.Contract(x402Address, x402ABI, deployer);
  const decimals = await usdt.decimals();
  const deployerBalance = await usdt.balanceOf(deployer.address);
  const deployerBalanceFormatted = ethers.formatUnits(deployerBalance, decimals);

  console.log(`   Deployer USDT balance: $${deployerBalanceFormatted}\n`);

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://civilis:civilis@localhost:5432/civilis",
  });

  const agents = await pool.query(
    "SELECT agent_id, name, wallet_address FROM agents WHERE is_alive = true ORDER BY agent_id"
  );

  const totalNeeded = agents.rowCount * perAgentAmount + treasuryAmount;
  if (parseFloat(deployerBalanceFormatted) < totalNeeded) {
    console.error(
      `❌ Insufficient USDT. Need $${totalNeeded}, have $${deployerBalanceFormatted}`
    );
    process.exit(1);
  }

  const totalApproval = ethers.parseUnits(totalNeeded.toString(), decimals);
  const approveTx = await usdt.approve(x402Address, totalApproval);
  await approveTx.wait();
  console.log(`   Approved ${x402Address} for ${totalNeeded} USDT\n`);

  for (const agent of agents.rows) {
    console.log(`  💸 ${agent.name}: $${perAgentAmount} USDT credit → ${agent.wallet_address}`);

    try {
      const amountWei = ethers.parseUnits(perAgentAmount.toString(), decimals);
      const tx = await x402.depositFor(agent.wallet_address, amountWei);
      const receipt = await tx.wait();
      console.log(`     ✅ tx: ${receipt.hash}`);
    } catch (err: any) {
      console.error(`     ❌ Failed: ${err.message}`);
    }
  }

  const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
  console.log(`\n  🏦 Treasury: $${treasuryAmount} USDT credit → ${treasuryAddress}`);
  const treasuryTx = await x402.depositFor(
    treasuryAddress,
    ethers.parseUnits(treasuryAmount.toString(), decimals)
  );
  await treasuryTx.wait();
  console.log(`     ✅ tx: ${treasuryTx.hash}`);

  console.log(`\n🎉 Funding complete!\n`);

  await pool.end();
}

main().catch(console.error);

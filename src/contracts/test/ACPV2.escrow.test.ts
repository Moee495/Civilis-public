import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ACPV2 escrow flows', function () {
  async function deployFixture() {
    const [deployer, client, provider, evaluator, stranger] = await ethers.getSigners();

    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy('Test USDT', 'tUSDT', ethers.parseUnits('1000000', 6));
    await token.waitForDeployment();

    const ACPV2 = await ethers.getContractFactory('ACPV2');
    const acp = await ACPV2.deploy(await token.getAddress());
    await acp.waitForDeployment();

    await token.mint(client.address, ethers.parseUnits('1000', 6));

    return { deployer, client, provider, evaluator, stranger, token, acp };
  }

  async function fundedJob(acp: any, token: any, client: any, provider: any, evaluator: any, amount: bigint) {
    const expiry = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    const jobId = await acp.getJobCount();
    await acp.connect(client).createJob(provider.address, evaluator.address, expiry, 'escrow-job', ethers.ZeroAddress);
    await acp.connect(client).setBudget(jobId, amount, '0x');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(jobId, amount, '0x');
    return { jobId, expiry };
  }

  it('pulls ERC-20 escrow into the contract on fund', async function () {
    const { client, provider, evaluator, token, acp } = await deployFixture();
    const amount = ethers.parseUnits('50', 6);
    const clientBefore = await token.balanceOf(client.address);

    const { jobId } = await fundedJob(acp, token, client, provider, evaluator, amount);

    expect(await token.balanceOf(await acp.getAddress())).to.equal(amount);
    expect(await token.balanceOf(client.address)).to.equal(clientBefore - amount);
    expect(jobId).to.equal(0n);
  });

  it('releases net provider amount and zero fee on complete in the no-fee path', async function () {
    const { client, provider, evaluator, token, acp } = await deployFixture();
    const amount = ethers.parseUnits('30', 6);

    const { jobId } = await fundedJob(acp, token, client, provider, evaluator, amount);
    await acp.connect(provider).submit(jobId, ethers.id('deliverable'), '0x');

    const providerBefore = await token.balanceOf(provider.address);

    await expect(acp.connect(evaluator).complete(jobId, ethers.id('reason'), '0x'))
      .to.emit(acp, 'PaymentReleased')
      .withArgs(jobId, provider.address, amount, 0n);

    expect(await token.balanceOf(provider.address)).to.equal(providerBefore + amount);
    expect(await token.balanceOf(await acp.getAddress())).to.equal(0n);
  });

  it('refunds the client on evaluator rejection from Funded', async function () {
    const { client, provider, evaluator, token, acp } = await deployFixture();
    const amount = ethers.parseUnits('18', 6);
    const clientBefore = await token.balanceOf(client.address);

    const { jobId } = await fundedJob(acp, token, client, provider, evaluator, amount);

    await expect(acp.connect(evaluator).reject(jobId, ethers.id('funded-reject'), '0x'))
      .to.emit(acp, 'Refunded')
      .withArgs(jobId, client.address, amount);

    expect(await token.balanceOf(client.address)).to.equal(clientBefore);
    expect(await token.balanceOf(await acp.getAddress())).to.equal(0n);
  });

  it('refunds the client on evaluator rejection from Submitted', async function () {
    const { client, provider, evaluator, token, acp } = await deployFixture();
    const amount = ethers.parseUnits('22', 6);
    const clientBefore = await token.balanceOf(client.address);

    const { jobId } = await fundedJob(acp, token, client, provider, evaluator, amount);
    await acp.connect(provider).submit(jobId, ethers.id('deliverable'), '0x');

    await expect(acp.connect(evaluator).reject(jobId, ethers.id('submitted-reject'), '0x'))
      .to.emit(acp, 'Refunded')
      .withArgs(jobId, client.address, amount);

    expect(await token.balanceOf(client.address)).to.equal(clientBefore);
    expect(await token.balanceOf(await acp.getAddress())).to.equal(0n);
  });

  it('refunds the client after expiry from Funded and Submitted', async function () {
    const { client, provider, evaluator, token, acp } = await deployFixture();
    const fundedAmount = ethers.parseUnits('11', 6);
    const submittedAmount = ethers.parseUnits('13', 6);
    const clientStart = await token.balanceOf(client.address);

    const funded = await fundedJob(acp, token, client, provider, evaluator, fundedAmount);
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(funded.expiry) + 1]);
    await ethers.provider.send('evm_mine', []);
    await expect(acp.claimRefund(funded.jobId))
      .to.emit(acp, 'Refunded')
      .withArgs(funded.jobId, client.address, fundedAmount);

    const expiry2 = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    await acp.connect(client).createJob(provider.address, evaluator.address, expiry2, 'submitted-job', ethers.ZeroAddress);
    await acp.connect(client).setBudget(1, submittedAmount, '0x');
    await token.connect(client).approve(await acp.getAddress(), submittedAmount);
    await acp.connect(client).fund(1, submittedAmount, '0x');
    await acp.connect(provider).submit(1, ethers.id('deliverable-2'), '0x');

    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(expiry2) + 1]);
    await ethers.provider.send('evm_mine', []);
    await expect(acp.connect(provider).claimRefund(1))
      .to.emit(acp, 'Refunded')
      .withArgs(1n, client.address, submittedAmount);

    expect(await token.balanceOf(client.address)).to.equal(clientStart);
    expect(await token.balanceOf(await acp.getAddress())).to.equal(0n);
  });
});

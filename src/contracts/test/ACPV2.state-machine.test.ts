import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ACPV2 state machine', function () {
  async function deployFixture() {
    const [deployer, client, provider, evaluator, outsider, feeSink] =
      await ethers.getSigners();

    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy('Test USDT', 'tUSDT', ethers.parseUnits('1000000', 6));
    await token.waitForDeployment();

    const ACPV2 = await ethers.getContractFactory('ACPV2');
    const acp = await ACPV2.deploy(await token.getAddress());
    await acp.waitForDeployment();

    await token.mint(client.address, ethers.parseUnits('1000', 6));

    return { deployer, client, provider, evaluator, outsider, feeSink, token, acp };
  }

  async function createOpenJob(
    acp: any,
    client: any,
    provider: string,
    evaluator: string,
    hook: string = ethers.ZeroAddress,
  ) {
    const expiry = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    const jobId = await acp.getJobCount();
    await expect(
      acp.connect(client).createJob(provider, evaluator, expiry, 'test-job', hook),
    ).to.emit(acp, 'JobCreated');
    return { jobId, expiry };
  }

  it('allows provider to be unset at creation and set later only by the client while open', async function () {
    const { client, provider, evaluator, outsider, token, acp } = await deployFixture();
    const { jobId } = await createOpenJob(
      acp,
      client,
      ethers.ZeroAddress,
      evaluator.address,
      ethers.ZeroAddress,
    );
    const job = await acp.getJob(jobId);

    expect(await acp.paymentToken()).to.equal(await token.getAddress());
    expect(job.client).to.equal(client.address);
    expect(job.provider).to.equal(ethers.ZeroAddress);
    expect(job.evaluator).to.equal(evaluator.address);
    expect(job.description).to.equal('test-job');
    expect(job.hook).to.equal(ethers.ZeroAddress);
    expect(job.status).to.equal(0n);

    await expect(
      acp.connect(outsider).setProvider(jobId, provider.address, '0x'),
    ).to.be.revertedWith('Only client');

    await expect(
      acp.connect(client).setProvider(jobId, provider.address, '0x'),
    ).to.emit(acp, 'ProviderSet');

    await expect(
      acp.connect(client).setProvider(jobId, provider.address, '0x'),
    ).to.be.revertedWith('Provider already set');
  });

  it('requires future expiry and non-zero evaluator at creation', async function () {
    const { client, provider, evaluator, acp } = await deployFixture();
    const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp);

    await expect(
      acp.connect(client).createJob(provider.address, ethers.ZeroAddress, now + 3600n, 'bad', ethers.ZeroAddress),
    ).to.be.revertedWith('Invalid evaluator');

    await expect(
      acp.connect(client).createJob(provider.address, evaluator.address, now, 'bad', ethers.ZeroAddress),
    ).to.be.revertedWith('Expiry must be future');
  });

  it('allows client and provider to set budget while Open and rejects outsiders or non-Open updates', async function () {
    const { client, provider, evaluator, outsider, token, acp } = await deployFixture();
    const { jobId } = await createOpenJob(acp, client, provider.address, evaluator.address);
    const clientAmount = ethers.parseUnits('9', 6);
    const providerAmount = ethers.parseUnits('10', 6);

    await expect(
      acp.connect(outsider).setBudget(jobId, ethers.parseUnits('10', 6), '0x'),
    ).to.be.revertedWith('Only client or provider');

    await expect(
      acp.connect(client).setBudget(jobId, clientAmount, '0x'),
    ).to.emit(acp, 'BudgetSet');

    await expect(
      acp.connect(provider).setBudget(jobId, providerAmount, '0x'),
    ).to.emit(acp, 'BudgetSet');

    await token.connect(client).approve(await acp.getAddress(), providerAmount);
    await acp.connect(client).fund(jobId, providerAmount, '0x');

    await expect(
      acp.connect(client).setBudget(jobId, providerAmount, '0x'),
    ).to.be.revertedWith('Job not open');
  });

  it('enforces expectedBudget and provider-set preconditions on fund', async function () {
    const { client, provider, evaluator, outsider, token, acp } = await deployFixture();
    const { jobId } = await createOpenJob(acp, client, ethers.ZeroAddress, evaluator.address);
    const amount = ethers.parseUnits('25', 6);

    await expect(
      acp.connect(client).fund(jobId, amount, '0x'),
    ).to.be.revertedWith('Budget is zero');

    await expect(acp.connect(client).setBudget(jobId, amount, '0x')).to.emit(acp, 'BudgetSet');

    await expect(
      acp.connect(outsider).fund(jobId, amount, '0x'),
    ).to.be.revertedWith('Only client');

    await expect(
      acp.connect(client).fund(jobId, amount, '0x'),
    ).to.be.revertedWith('Provider not set');

    await expect(acp.connect(client).setProvider(jobId, provider.address, '0x')).to.emit(acp, 'ProviderSet');
    await token.connect(client).approve(await acp.getAddress(), amount);

    await expect(
      acp.connect(client).fund(jobId, amount + 1n, '0x'),
    ).to.be.revertedWith('Budget mismatch');

    await expect(acp.connect(client).fund(jobId, amount, '0x')).to.emit(acp, 'JobFunded');
  });

  it('enforces provider-only submit and evaluator-only completion from Submitted', async function () {
    const { client, provider, evaluator, outsider, token, acp } = await deployFixture();
    const { jobId } = await createOpenJob(acp, client, provider.address, evaluator.address);
    const amount = ethers.parseUnits('40', 6);

    await acp.connect(client).setBudget(jobId, amount, '0x');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(jobId, amount, '0x');

    await expect(
      acp.connect(evaluator).complete(jobId, ethers.ZeroHash, '0x'),
    ).to.be.revertedWith('Job not submitted');

    await expect(
      acp.connect(outsider).submit(jobId, ethers.id('deliverable'), '0x'),
    ).to.be.revertedWith('Only provider');

    await expect(
      acp.connect(provider).submit(jobId, ethers.id('deliverable'), '0x'),
    ).to.emit(acp, 'JobSubmitted');

    await expect(
      acp.connect(outsider).complete(jobId, ethers.id('reason'), '0x'),
    ).to.be.revertedWith('Only evaluator');

    await expect(
      acp.connect(evaluator).complete(jobId, ethers.id('reason'), '0x'),
    ).to.emit(acp, 'JobCompleted');

    await expect(
      acp.connect(client).claimRefund(jobId),
    ).to.be.revertedWith('Refund unavailable');
  });

  it('allows client reject only from Open and evaluator reject from Funded/Submitted', async function () {
    const { client, provider, evaluator, outsider, token, acp } = await deployFixture();
    const open = await createOpenJob(acp, client, provider.address, evaluator.address);
    const amount = ethers.parseUnits('15', 6);

    await expect(
      acp.connect(outsider).reject(open.jobId, ethers.ZeroHash, '0x'),
    ).to.be.revertedWith('Only client');

    await expect(
      acp.connect(client).reject(open.jobId, ethers.id('open-reject'), '0x'),
    ).to.emit(acp, 'JobRejected');

    const funded = await createOpenJob(acp, client, provider.address, evaluator.address);
    await acp.connect(client).setBudget(funded.jobId, amount, '0x');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(funded.jobId, amount, '0x');

    await expect(
      acp.connect(client).reject(funded.jobId, ethers.ZeroHash, '0x'),
    ).to.be.revertedWith('Only evaluator');

    await expect(
      acp.connect(evaluator).reject(funded.jobId, ethers.id('funded-reject'), '0x'),
    ).to.emit(acp, 'JobRejected');
  });

  it('allows claimRefund only from Funded or Submitted after expiry and keeps terminal states final', async function () {
    const { client, provider, evaluator, token, acp } = await deployFixture();
    const amount = ethers.parseUnits('12', 6);

    const open = await createOpenJob(acp, client, provider.address, evaluator.address);
    await expect(acp.connect(client).claimRefund(open.jobId)).to.be.revertedWith('Refund unavailable');

    const funded = await createOpenJob(acp, client, provider.address, evaluator.address);
    await acp.connect(client).setBudget(funded.jobId, amount, '0x');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(funded.jobId, amount, '0x');

    await expect(acp.connect(client).claimRefund(funded.jobId)).to.be.revertedWith('Not expired');

    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(funded.expiry) + 1]);
    await ethers.provider.send('evm_mine', []);

    await expect(acp.connect(client).claimRefund(funded.jobId)).to.emit(acp, 'JobExpired');
    await expect(
      acp.connect(client).setBudget(funded.jobId, amount, '0x'),
    ).to.be.revertedWith('Job not open');
  });
});

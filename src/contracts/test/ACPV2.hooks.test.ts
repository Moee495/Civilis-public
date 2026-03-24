import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ACPV2 hooks', function () {
  async function deployFixture() {
    const [client, provider, evaluator, outsider] = await ethers.getSigners();

    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy('Test USDT', 'tUSDT', ethers.parseUnits('1000000', 6));
    await token.waitForDeployment();

    const MockACPHook = await ethers.getContractFactory('MockACPHook');
    const hook = await MockACPHook.deploy();
    await hook.waitForDeployment();

    const ACPV2 = await ethers.getContractFactory('ACPV2');
    const acp = await ACPV2.deploy(await token.getAddress());
    await acp.waitForDeployment();

    await token.mint(client.address, ethers.parseUnits('1000', 6));

    return { client, provider, evaluator, outsider, token, hook, acp };
  }

  async function createJobWithHook(
    acp: any,
    client: any,
    provider: string,
    evaluator: string,
    hookAddress: string,
  ) {
    const expiry = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    const jobId = await acp.getJobCount();
    await acp.connect(client).createJob(provider, evaluator, expiry, 'hooked-job', hookAddress);
    return { jobId, expiry };
  }

  it('keeps the original kernel path unchanged when hook is address(0)', async function () {
    const { client, provider, evaluator, token, acp } = await deployFixture();
    const amount = ethers.parseUnits('21', 6);
    const expiry = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);

    await acp.connect(client).createJob(provider.address, evaluator.address, expiry, 'no-hook', ethers.ZeroAddress);
    await acp.connect(client).setBudget(0, amount, '0x1234');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(0, amount, '0xabcd');
    await acp.connect(provider).submit(0, ethers.id('deliverable'), '0xbeef');
    await expect(acp.connect(evaluator).complete(0, ethers.id('reason'), '0xcafe'))
      .to.emit(acp, 'PaymentReleased')
      .withArgs(0n, provider.address, amount, 0n);
  });

  it('calls beforeAction and afterAction for setProvider, setBudget, fund, submit, and complete with EIP-aligned encoding', async function () {
    const { client, provider, evaluator, token, hook, acp } = await deployFixture();
    const { jobId } = await createJobWithHook(
      acp,
      client,
      ethers.ZeroAddress,
      evaluator.address,
      await hook.getAddress(),
    );
    const amount = ethers.parseUnits('8', 6);
    const deliverable = ethers.id('deliverable');
    const reason = ethers.id('reason');
    const setProviderOpt = '0x1111';
    const setBudgetOpt = '0x2222';
    const fundOpt = '0x3333';
    const submitOpt = '0x4444';
    const completeOpt = '0x5555';
    const coder = ethers.AbiCoder.defaultAbiCoder();

    const setProviderSelector = acp.interface.getFunction('setProvider')!.selector;
    const setBudgetSelector = acp.interface.getFunction('setBudget')!.selector;
    const fundSelector = acp.interface.getFunction('fund')!.selector;
    const submitSelector = acp.interface.getFunction('submit')!.selector;
    const completeSelector = acp.interface.getFunction('complete')!.selector;

    await expect(acp.connect(client).setProvider(jobId, provider.address, setProviderOpt))
      .to.emit(hook, 'BeforeCalled')
      .withArgs(jobId, setProviderSelector, coder.encode(['address', 'bytes'], [provider.address, setProviderOpt]))
      .and.to.emit(hook, 'AfterCalled')
      .withArgs(jobId, setProviderSelector, coder.encode(['address', 'bytes'], [provider.address, setProviderOpt]));

    await expect(acp.connect(client).setBudget(jobId, amount, setBudgetOpt))
      .to.emit(hook, 'BeforeCalled')
      .withArgs(jobId, setBudgetSelector, coder.encode(['uint256', 'bytes'], [amount, setBudgetOpt]))
      .and.to.emit(hook, 'AfterCalled')
      .withArgs(jobId, setBudgetSelector, coder.encode(['uint256', 'bytes'], [amount, setBudgetOpt]));

    await token.connect(client).approve(await acp.getAddress(), amount);
    await expect(acp.connect(client).fund(jobId, amount, fundOpt))
      .to.emit(hook, 'BeforeCalled')
      .withArgs(jobId, fundSelector, fundOpt)
      .and.to.emit(hook, 'AfterCalled')
      .withArgs(jobId, fundSelector, fundOpt);

    await expect(acp.connect(provider).submit(jobId, deliverable, submitOpt))
      .to.emit(hook, 'BeforeCalled')
      .withArgs(jobId, submitSelector, coder.encode(['bytes32', 'bytes'], [deliverable, submitOpt]))
      .and.to.emit(hook, 'AfterCalled')
      .withArgs(jobId, submitSelector, coder.encode(['bytes32', 'bytes'], [deliverable, submitOpt]));

    await expect(acp.connect(evaluator).complete(jobId, reason, completeOpt))
      .to.emit(hook, 'BeforeCalled')
      .withArgs(jobId, completeSelector, coder.encode(['bytes32', 'bytes'], [reason, completeOpt]))
      .and.to.emit(hook, 'AfterCalled')
      .withArgs(jobId, completeSelector, coder.encode(['bytes32', 'bytes'], [reason, completeOpt]));
  });

  it('calls hooks for reject with EIP-aligned encoding', async function () {
    const { client, provider, evaluator, token, hook, acp } = await deployFixture();
    const { jobId } = await createJobWithHook(
      acp,
      client,
      provider.address,
      evaluator.address,
      await hook.getAddress(),
    );
    const amount = ethers.parseUnits('9', 6);
    const reason = ethers.id('reject-reason');
    const rejectOpt = '0x6666';
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const rejectSelector = acp.interface.getFunction('reject')!.selector;

    await acp.connect(client).setBudget(jobId, amount, '0x');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(jobId, amount, '0x');

    await expect(acp.connect(evaluator).reject(jobId, reason, rejectOpt))
      .to.emit(hook, 'BeforeCalled')
      .withArgs(jobId, rejectSelector, coder.encode(['bytes32', 'bytes'], [reason, rejectOpt]))
      .and.to.emit(hook, 'AfterCalled')
      .withArgs(jobId, rejectSelector, coder.encode(['bytes32', 'bytes'], [reason, rejectOpt]));
  });

  it('keeps claimRefund non-hookable even when a hook is configured', async function () {
    const { client, provider, evaluator, outsider, token, hook, acp } = await deployFixture();
    const { jobId, expiry } = await createJobWithHook(
      acp,
      client,
      provider.address,
      evaluator.address,
      await hook.getAddress(),
    );
    const amount = ethers.parseUnits('7', 6);

    await acp.connect(client).setBudget(jobId, amount, '0x');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(jobId, amount, '0x');

    const beforeCount = await hook.beforeCount();
    const afterCount = await hook.afterCount();

    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(expiry) + 1]);
    await ethers.provider.send('evm_mine', []);

    await expect(acp.connect(outsider).claimRefund(jobId))
      .to.emit(acp, 'JobExpired')
      .withArgs(jobId, outsider.address);

    expect(await hook.beforeCount()).to.equal(beforeCount);
    expect(await hook.afterCount()).to.equal(afterCount);
  });

  it('reverts the core action when the before hook reverts', async function () {
    const { client, provider, evaluator, hook, acp } = await deployFixture();
    const { jobId } = await createJobWithHook(
      acp,
      client,
      provider.address,
      evaluator.address,
      await hook.getAddress(),
    );
    const amount = ethers.parseUnits('5', 6);
    const selector = acp.interface.getFunction('setBudget')!.selector;

    await hook.setRevertBefore(selector, true);

    await expect(
      acp.connect(client).setBudget(jobId, amount, '0x7777'),
    ).to.be.revertedWith('Hook before revert');

    const job = await acp.getJob(jobId);
    expect(job.budget).to.equal(0n);
  });

  it('reverts the core action when the after hook reverts and rolls state and funds back', async function () {
    const { client, provider, evaluator, token, hook, acp } = await deployFixture();
    const { jobId } = await createJobWithHook(
      acp,
      client,
      provider.address,
      evaluator.address,
      await hook.getAddress(),
    );
    const amount = ethers.parseUnits('14', 6);
    const selector = acp.interface.getFunction('complete')!.selector;

    await acp.connect(client).setBudget(jobId, amount, '0x');
    await token.connect(client).approve(await acp.getAddress(), amount);
    await acp.connect(client).fund(jobId, amount, '0x');
    await acp.connect(provider).submit(jobId, ethers.id('deliverable'), '0x');

    const providerBefore = await token.balanceOf(provider.address);
    const escrowBefore = await token.balanceOf(await acp.getAddress());

    await hook.setRevertAfter(selector, true);

    await expect(
      acp.connect(evaluator).complete(jobId, ethers.id('reason'), '0x8888'),
    ).to.be.revertedWith('Hook after revert');

    const job = await acp.getJob(jobId);
    expect(job.status).to.equal(2n);
    expect(await token.balanceOf(provider.address)).to.equal(providerBefore);
    expect(await token.balanceOf(await acp.getAddress())).to.equal(escrowBefore);
  });
});

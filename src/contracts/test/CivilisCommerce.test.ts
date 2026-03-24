import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('CivilisCommerce', function () {
  it('creates and settles an arena job', async function () {
    const [owner, other] = await ethers.getSigners();
    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy(
      'Civilis Test USDT',
      'cUSDT',
      ethers.parseUnits('1000', 6),
    );
    await token.waitForDeployment();
    const Commerce = await ethers.getContractFactory('CivilisCommerce');
    const commerce = await Commerce.deploy(await token.getAddress());
    await commerce.waitForDeployment();

    await expect(
      commerce.createArenaJob('oracle', 'hawk', owner.address, other.address, 1_000_000, 300),
    ).to.emit(commerce, 'JobCreated');

    const job = await commerce.getJob(1);
    expect(job.budget).to.equal(2_000_000n);

    await expect(commerce.settleArenaJob(1, 1, 2, 200_000, 1_800_000))
      .to.emit(commerce, 'JobCompleted');
  });

  it('creates and completes a divination job', async function () {
    const [owner] = await ethers.getSigners();
    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy(
      'Civilis Test USDT',
      'cUSDT',
      ethers.parseUnits('1000', 6),
    );
    await token.waitForDeployment();
    const Commerce = await ethers.getContractFactory('CivilisCommerce');
    const commerce = await Commerce.deploy(await token.getAddress());
    await commerce.waitForDeployment();

    await commerce.createDivinationJob('oracle', 'mbti', owner.address, 10_000);
    await commerce.completeDivination(
      1,
      ethers.keccak256(ethers.toUtf8Bytes('INTJ')),
    );

    const job = await commerce.getJob(1);
    expect(job.status).to.equal(3); // Completed
  });
});

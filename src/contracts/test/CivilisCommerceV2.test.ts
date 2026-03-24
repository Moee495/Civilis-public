import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('CivilisCommerceV2', function () {
  async function deployFixture() {
    const [deployer, client, provider, evaluator, outsider] = await ethers.getSigners();

    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy(
      'Civilis Test USDT',
      'cUSDT',
      ethers.parseUnits('1000000', 6),
    );
    await token.waitForDeployment();

    const ACPV2 = await ethers.getContractFactory('ACPV2');
    const acp = await ACPV2.deploy(await token.getAddress());
    await acp.waitForDeployment();

    const Commerce = await ethers.getContractFactory('CivilisCommerceV2');
    const commerce = await Commerce.deploy(await acp.getAddress());
    await commerce.waitForDeployment();

    return { deployer, client, provider, evaluator, outsider, token, acp, commerce };
  }

  async function createOpenJob(acp: any, client: any, provider: string, evaluator: string) {
    const expiry = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    const jobId = await acp.getJobCount();
    await acp.connect(client).createJob(provider, evaluator, expiry, 'commerce-job', ethers.ZeroAddress);
    return jobId;
  }

  it('maps and reads all supported Civilis business types without duplicating escrow state', async function () {
    const { client, provider, evaluator, acp, commerce } = await deployFixture();

    const arenaJobId = await createOpenJob(acp, client, provider.address, evaluator.address);
    const intelJobId = await createOpenJob(acp, client, provider.address, evaluator.address);
    const divinationJobId = await createOpenJob(acp, client, provider.address, evaluator.address);
    const predictionJobId = await createOpenJob(acp, client, provider.address, evaluator.address);

    const arenaRef = ethers.id('arena:match:1');
    const intelRef = ethers.id('intel:listing:1');
    const divinationRef = ethers.id('divination:oracle:1');
    const predictionRef = ethers.id('prediction:round:1');

    await expect(
      commerce.mapBusiness(arenaRef, 0, ethers.encodeBytes32String('match'), arenaJobId),
    ).to.emit(commerce, 'BusinessMapped');
    await expect(
      commerce.mapBusiness(intelRef, 1, ethers.encodeBytes32String('purchase'), intelJobId),
    ).to.emit(commerce, 'BusinessMapped');
    await expect(
      commerce.mapBusiness(divinationRef, 2, ethers.encodeBytes32String('oracle'), divinationJobId),
    ).to.emit(commerce, 'BusinessMapped');
    await expect(
      commerce.mapBusiness(predictionRef, 3, ethers.encodeBytes32String('round'), predictionJobId),
    ).to.emit(commerce, 'BusinessMapped');

    const arena = await commerce.getBusinessLink(arenaRef);
    expect(arena.jobId).to.equal(arenaJobId);
    expect(arena.businessType).to.equal(0n);
    expect(arena.businessSubtype).to.equal(ethers.encodeBytes32String('match'));
    expect(arena.status).to.equal(0n);

    const intel = await commerce.getBusinessLink(intelRef);
    expect(intel.businessType).to.equal(1n);

    const divination = await commerce.getBusinessLink(divinationRef);
    expect(divination.businessType).to.equal(2n);

    const prediction = await commerce.getBusinessLink(predictionRef);
    expect(prediction.businessType).to.equal(3n);

    expect(await commerce.getBusinessRefForJob(arenaJobId)).to.equal(arenaRef);
    expect(await commerce.acpKernel()).to.equal(await acp.getAddress());
  });

  it('rejects duplicate business refs, duplicate ACP job mappings, and invalid ACP references', async function () {
    const { client, provider, evaluator, outsider, acp, commerce } = await deployFixture();
    const jobId = await createOpenJob(acp, client, provider.address, evaluator.address);
    const otherJobId = await createOpenJob(acp, client, provider.address, evaluator.address);
    const businessRef = ethers.id('arena:duplicate');

    await expect(
      commerce.connect(outsider).mapBusiness(businessRef, 0, ethers.encodeBytes32String('match'), jobId),
    ).to.be.revertedWithCustomError(commerce, 'AccessControlUnauthorizedAccount');

    await expect(
      commerce.mapBusiness(ethers.ZeroHash, 0, ethers.encodeBytes32String('match'), jobId),
    ).to.be.revertedWith('Invalid business ref');

    await expect(
      commerce.mapBusiness(ethers.id('missing-job'), 0, ethers.encodeBytes32String('match'), otherJobId + 100n),
    ).to.be.revertedWith('Invalid ACP job');

    await commerce.mapBusiness(businessRef, 0, ethers.encodeBytes32String('match'), jobId);

    await expect(
      commerce.mapBusiness(businessRef, 1, ethers.encodeBytes32String('intel'), otherJobId),
    ).to.be.revertedWith('Business ref already mapped');

    await expect(
      commerce.mapBusiness(ethers.id('new-ref'), 1, ethers.encodeBytes32String('intel'), jobId),
    ).to.be.revertedWith('ACP job already mapped');
  });

  it('enforces mapping lifecycle and rejects unknown refs or repeated close operations', async function () {
    const { client, provider, evaluator, outsider, acp, commerce } = await deployFixture();
    const jobId = await createOpenJob(acp, client, provider.address, evaluator.address);
    const businessRef = ethers.id('prediction:lifecycle');
    const statusInfo = ethers.id('oracle-finalized');

    await expect(
      commerce.connect(outsider).closeMapping(businessRef, statusInfo),
    ).to.be.revertedWithCustomError(commerce, 'AccessControlUnauthorizedAccount');

    await expect(
      commerce.closeMapping(businessRef, statusInfo),
    ).to.be.revertedWith('Unknown business ref');

    await commerce.mapBusiness(businessRef, 3, ethers.encodeBytes32String('round'), jobId);

    await expect(
      commerce.closeMapping(businessRef, statusInfo),
    ).to.emit(commerce, 'MappingStatusUpdated');

    const link = await commerce.getBusinessLink(businessRef);
    expect(link.status).to.equal(1n);
    expect(link.statusInfo).to.equal(statusInfo);

    await expect(
      commerce.closeMapping(businessRef, statusInfo),
    ).to.be.revertedWith('Link not active');
  });
});

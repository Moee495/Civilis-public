import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ERC8004ValidationRegistryV2', function () {
  async function deployFixture() {
    const [owner, operator, validator, validatorTwo, outsider] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory('ERC8004IdentityRegistryV2');
    const identity = await Identity.deploy();
    await identity.waitForDeployment();
    await identity.connect(owner)['register(string)']('ipfs://agent-1');
    await identity.connect(owner).approve(operator.address, 1);

    const Validation = await ethers.getContractFactory('ERC8004ValidationRegistryV2');
    const validation = await Validation.deploy();
    await validation.waitForDeployment();
    await validation.initialize(await identity.getAddress());

    return { owner, operator, validator, validatorTwo, outsider, identity, validation };
  }

  it('binds identityRegistry and restricts validationRequest to owner/operator', async function () {
    const { owner, operator, validator, outsider, validation, identity } = await deployFixture();

    expect(await validation.getIdentityRegistry()).to.equal(await identity.getAddress());
    await expect(validation.initialize(await identity.getAddress())).to.be.revertedWith('Already initialized');

    await expect(
      validation.connect(outsider).validationRequest(validator.address, 1, 'ipfs://req-1', ethers.id('req-1')),
    ).to.be.revertedWith('Not owner or operator');

    await expect(
      validation.connect(owner).validationRequest(validator.address, 1, 'ipfs://req-1', ethers.id('req-1')),
    ).to.emit(validation, 'ValidationRequest');

    await expect(
      validation.connect(operator).validationRequest(validator.address, 1, 'ipfs://req-2', ethers.id('req-2')),
    ).to.emit(validation, 'ValidationRequest');
  });

  it('requires the assigned validator and supports progressive response updates', async function () {
    const { owner, validator, validatorTwo, outsider, validation } = await deployFixture();
    const requestHash = ethers.id('req-progressive');

    await validation.connect(owner).validationRequest(validator.address, 1, 'ipfs://req-progressive', requestHash);

    await expect(
      validation.connect(validatorTwo).validationResponse(requestHash, 80, 'ipfs://resp-1', ethers.id('resp-1'), 'soft'),
    ).to.be.revertedWith('Only assigned validator');

    await expect(
      validation.connect(validator).validationResponse(requestHash, 101, 'ipfs://resp-1', ethers.id('resp-1'), 'soft'),
    ).to.be.revertedWith('Response out of range');

    await expect(
      validation.connect(validator).validationResponse(requestHash, 80, 'ipfs://resp-1', ethers.id('resp-1'), 'soft'),
    ).to.emit(validation, 'ValidationResponse');

    await expect(
      validation.connect(validator).validationResponse(requestHash, 100, 'ipfs://resp-2', ethers.id('resp-2'), 'hard'),
    ).to.emit(validation, 'ValidationResponse');

    const status = await validation.getValidationStatus(requestHash);
    expect(status.validatorAddress).to.equal(validator.address);
    expect(status.agentId).to.equal(1n);
    expect(status.response).to.equal(100n);
    expect(status.responseHash).to.equal(ethers.id('resp-2'));
    expect(status.tag).to.equal('hard');

    const summary = await validation.getSummary(1, [], '');
    expect(summary.count).to.equal(1n);
    expect(summary.averageResponse).to.equal(100n);

    await expect(
      validation.connect(outsider).getValidationStatus(ethers.id('missing')),
    ).to.be.revertedWith('Validation not found');
  });

  it('supports validator/tag-filtered summaries and registry readers', async function () {
    const { owner, validator, validatorTwo, validation } = await deployFixture();
    const hashA = ethers.id('req-a');
    const hashB = ethers.id('req-b');

    await validation.connect(owner).validationRequest(validator.address, 1, 'ipfs://req-a', hashA);
    await validation.connect(owner).validationRequest(validatorTwo.address, 1, 'ipfs://req-b', hashB);

    await validation.connect(validator).validationResponse(hashA, 80, 'ipfs://resp-a', ethers.id('resp-a'), 'verified');
    await validation.connect(validatorTwo).validationResponse(hashB, 60, 'ipfs://resp-b', ethers.id('resp-b'), 'warning');

    const allSummary = await validation.getSummary(1, [], '');
    expect(allSummary.count).to.equal(2n);
    expect(allSummary.averageResponse).to.equal(70n);

    const filteredSummary = await validation.getSummary(1, [validator.address], 'verified');
    expect(filteredSummary.count).to.equal(1n);
    expect(filteredSummary.averageResponse).to.equal(80n);

    const agentValidations = await validation.getAgentValidations(1);
    expect(agentValidations).to.deep.equal([hashA, hashB]);

    const validatorRequests = await validation.getValidatorRequests(validator.address);
    expect(validatorRequests).to.deep.equal([hashA]);
  });
});

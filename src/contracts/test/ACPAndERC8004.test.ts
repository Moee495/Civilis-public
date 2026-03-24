import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ACP and ERC-8004 role-aware flows', function () {
  it('creates ACP jobs for real client/provider addresses and enforces actor permissions', async function () {
    const [admin, client, provider, evaluator, outsider] = await ethers.getSigners();
    const ACP = await ethers.getContractFactory('ACP');
    const acp = await ACP.deploy();
    await acp.waitForDeployment();

    const expiry = (await ethers.provider.getBlock('latest'))!.timestamp + 3600;
    await expect(
      acp.createJobFor(
        client.address,
        provider.address,
        evaluator.address,
        expiry,
        'intel_buy_1_behavior_pattern',
        ethers.ZeroAddress,
      ),
    ).to.emit(acp, 'JobCreated');

    const job = await acp.getJob(0);
    expect(job.client).to.equal(client.address);
    expect(job.provider).to.equal(provider.address);
    expect(job.evaluator).to.equal(evaluator.address);

    await expect(acp.connect(outsider).fund(0, '0x')).to.be.revertedWith(
      'Only client or engine can fund',
    );
    await expect(acp.connect(client).fund(0, '0x')).to.emit(acp, 'JobFunded');

    await expect(
      acp.connect(outsider).submit(0, ethers.ZeroHash, '0x'),
    ).to.be.revertedWith('Only provider or engine can submit');
    await expect(
      acp.connect(provider).submit(0, ethers.ZeroHash, '0x'),
    ).to.emit(acp, 'JobSubmitted');

    await expect(
      acp.connect(outsider).complete(0, ethers.ZeroHash, '0x'),
    ).to.be.revertedWith('Only evaluator or engine can complete');
    await expect(
      acp.connect(evaluator).complete(0, ethers.ZeroHash, '0x'),
    ).to.emit(acp, 'JobCompleted');
  });

  it('mints ERC-8004 identity to the real owner and aggregates reputation across known clients', async function () {
    const [admin, owner, clientA, clientB] = await ethers.getSigners();
    const Identity = await ethers.getContractFactory('ERC8004IdentityRegistry');
    const identity = await Identity.deploy();
    await identity.waitForDeployment();

    const metadata = [
      {
        metadataKey: 'platform',
        metadataValue: ethers.toUtf8Bytes('civilis'),
      },
    ];

    await expect(identity.registerFor(owner.address, 'ipfs://oracle-card', metadata))
      .to.emit(identity, 'Registered')
      .withArgs(1n, 'ipfs://oracle-card', owner.address);

    expect(await identity.ownerOf(1)).to.equal(owner.address);
    expect(await identity.getAgentWallet(1)).to.equal(owner.address);

    const Reputation = await ethers.getContractFactory('ERC8004ReputationRegistry');
    const reputation = await Reputation.deploy();
    await reputation.waitForDeployment();

    await expect(
      reputation.giveFeedbackFrom(clientA.address, 1, 80, 0, 'pd_cooperation', 'arena', '', '', ethers.ZeroHash),
    ).to.emit(reputation, 'NewFeedback');
    await expect(
      reputation.giveFeedbackFrom(clientB.address, 1, 60, 0, 'pd_cooperation', 'arena', '', '', ethers.ZeroHash),
    ).to.emit(reputation, 'NewFeedback');

    const summary = await reputation.getSummary(1, [], 'pd_cooperation', 'arena');
    expect(summary.count).to.equal(2n);
    expect(summary.summaryValue).to.equal(70n);

    const clients = await reputation.getKnownClients(1);
    expect(clients).to.deep.equal([clientA.address, clientB.address]);
  });

  it('requires VALIDATOR_ROLE for ERC-8004 validation writes', async function () {
    const [admin, outsider] = await ethers.getSigners();
    const Validation = await ethers.getContractFactory('ERC8004ValidationRegistry');
    const validation = await Validation.deploy();
    await validation.waitForDeployment();

    const requestHash = ethers.id('intel_request_1');

    await expect(
      validation
        .connect(outsider)
        .validationRequest(admin.address, 1, 'civilis://intel/1', requestHash),
    ).to.be.reverted;

    await expect(
      validation.validationRequest(admin.address, 1, 'civilis://intel/1', requestHash),
    ).to.emit(validation, 'ValidationRequest');

    await expect(
      validation
        .connect(outsider)
        .validationResponse(requestHash, 80, 'civilis://intel/1/result', ethers.id('resp'), 'verified'),
    ).to.be.reverted;

    await expect(
      validation.validationResponse(requestHash, 80, 'civilis://intel/1/result', ethers.id('resp'), 'verified'),
    ).to.emit(validation, 'ValidationResponse');

    const summary = await validation.getSummary(1, [], 'verified');
    expect(summary.count).to.equal(1n);
    expect(summary.averageResponse).to.equal(80n);
  });
});

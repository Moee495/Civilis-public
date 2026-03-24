import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ERC8004ReputationRegistryV2', function () {
  async function deployFixture() {
    const [owner, operator, clientA, clientB, responder] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory('ERC8004IdentityRegistryV2');
    const identity = await Identity.deploy();
    await identity.waitForDeployment();
    await identity.connect(owner)['register(string)']('ipfs://agent-1');
    await identity.connect(owner).approve(operator.address, 1);

    const Reputation = await ethers.getContractFactory('ERC8004ReputationRegistryV2');
    const reputation = await Reputation.deploy();
    await reputation.waitForDeployment();
    await reputation.initialize(await identity.getAddress());

    return { owner, operator, clientA, clientB, responder, identity, reputation };
  }

  it('binds identityRegistry and enforces submitter restrictions and decimals', async function () {
    const { owner, operator, clientA, reputation, identity } = await deployFixture();

    expect(await reputation.getIdentityRegistry()).to.equal(await identity.getAddress());
    await expect(reputation.initialize(await identity.getAddress())).to.be.revertedWith('Already initialized');

    await expect(
      reputation.connect(owner).giveFeedback(1, 80, 0, 'quality', 'arena', '', '', ethers.ZeroHash),
    ).to.be.revertedWith('Owner/operator cannot feedback');

    await expect(
      reputation.connect(operator).giveFeedback(1, 80, 0, 'quality', 'arena', '', '', ethers.ZeroHash),
    ).to.be.revertedWith('Owner/operator cannot feedback');

    await expect(
      reputation.connect(clientA).giveFeedback(1, 80, 19, 'quality', 'arena', '', '', ethers.ZeroHash),
    ).to.be.revertedWith('Invalid valueDecimals');
  });

  it('uses 1-indexed feedback, appendResponse, non-empty client filter summary, and reader utilities', async function () {
    const { clientA, clientB, responder, reputation } = await deployFixture();

    await expect(
      reputation.connect(clientA).giveFeedback(1, 8000, 2, 'quality', 'arena', 'https://endpoint/1', 'ipfs://fb-1', ethers.id('fb1')),
    ).to.emit(reputation, 'NewFeedback').withArgs(
      1n,
      clientA.address,
      1n,
      8000n,
      2n,
      'quality',
      'quality',
      'arena',
      'https://endpoint/1',
      'ipfs://fb-1',
      ethers.id('fb1'),
    );

    await expect(
      reputation.connect(clientA).giveFeedback(1, 6000, 2, 'quality', 'arena', 'https://endpoint/2', 'ipfs://fb-2', ethers.id('fb2')),
    ).to.emit(reputation, 'NewFeedback').withArgs(
      1n,
      clientA.address,
      2n,
      6000n,
      2n,
      'quality',
      'quality',
      'arena',
      'https://endpoint/2',
      'ipfs://fb-2',
      ethers.id('fb2'),
    );

    await expect(
      reputation.connect(clientB).giveFeedback(1, 10000, 2, 'quality', 'arena', 'https://endpoint/3', 'ipfs://fb-3', ethers.id('fb3')),
    ).to.emit(reputation, 'NewFeedback');

    await expect(reputation.getSummary(1, [], 'quality', 'arena')).to.be.revertedWith('Client filter required');

    const summary = await reputation.getSummary(1, [clientA.address, clientB.address], 'quality', 'arena');
    expect(summary.count).to.equal(3n);
    expect(summary.summaryValueDecimals).to.equal(18n);
    expect(summary.summaryValue).to.equal(ethers.parseUnits('80', 18));

    await expect(
      reputation.connect(responder).appendResponse(1, clientA.address, 1, 'ipfs://resp-1', ethers.id('resp1')),
    ).to.emit(reputation, 'ResponseAppended');
    await expect(
      reputation.connect(responder).appendResponse(1, clientA.address, 1, 'ipfs://resp-2', ethers.id('resp2')),
    ).to.emit(reputation, 'ResponseAppended');

    expect(await reputation.getResponseCount(1, clientA.address, 1, [])).to.equal(2n);
    expect(await reputation.getResponseCount(1, clientA.address, 1, [responder.address])).to.equal(2n);

    const feedback = await reputation.readFeedback(1, clientA.address, 2);
    expect(feedback.value).to.equal(6000n);
    expect(feedback.valueDecimals).to.equal(2n);

    const clients = await reputation.getClients(1);
    expect(clients).to.deep.equal([clientA.address, clientB.address]);
    expect(await reputation.getLastIndex(1, clientA.address)).to.equal(2n);

    const allFeedback = await reputation.readAllFeedback(1, [], 'quality', 'arena', false);
    expect(allFeedback.clients.length).to.equal(3);
    expect(allFeedback.feedbackIndexes.map((x: bigint) => Number(x))).to.deep.equal([1, 2, 1]);
  });

  it('revokes feedback by the submitter and excludes revoked items from summary by default', async function () {
    const { clientA, reputation } = await deployFixture();

    await reputation.connect(clientA).giveFeedback(1, 5000, 2, 'uptime', 'ops', '', '', ethers.ZeroHash);
    await reputation.connect(clientA).giveFeedback(1, 7000, 2, 'uptime', 'ops', '', '', ethers.ZeroHash);

    await expect(reputation.connect(clientA).revokeFeedback(1, 1))
      .to.emit(reputation, 'FeedbackRevoked')
      .withArgs(1n, clientA.address, 1n);

    const summary = await reputation.getSummary(1, [clientA.address], 'uptime', 'ops');
    expect(summary.count).to.equal(1n);
    expect(summary.summaryValue).to.equal(ethers.parseUnits('70', 18));

    const allIncludingRevoked = await reputation.readAllFeedback(1, [clientA.address], 'uptime', 'ops', true);
    expect(allIncludingRevoked.revokedStatuses).to.deep.equal([true, false]);
  });
});

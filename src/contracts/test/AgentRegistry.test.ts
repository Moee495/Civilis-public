import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('AgentRegistry', function () {
  it('registers an agent and mints an identity NFT', async function () {
    const [owner] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory('AgentRegistry');
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    await expect(
      registry.register(
        'oracle',
        'Oracle',
        owner.address,
        0,
        ethers.keccak256(ethers.toUtf8Bytes('oracle-fate')),
        123,
        'ipfs://oracle-card',
      ),
    ).to.emit(registry, 'AgentRegistered');

    const agent = await registry.getAgent('oracle');
    const identity = await registry.getIdentity('oracle');

    expect(agent.name).to.equal('Oracle');
    expect(identity.tokenId).to.equal(1n);
    expect(await registry.tokenURI(identity.tokenId)).to.equal('ipfs://oracle-card');
  });

  it('updates reputation and records death', async function () {
    const [owner] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory('AgentRegistry');
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    await registry.register(
      'hawk',
      'Hawk',
      owner.address,
      1,
      ethers.keccak256(ethers.toUtf8Bytes('hawk-fate')),
      456,
      'ipfs://hawk-card',
    );

    await registry.updateReputation('hawk', 720);
    await registry.recordDeath('hawk', 'ipfs://hawk-soul');

    const agent = await registry.getAgent('hawk');
    expect(agent.reputationScore).to.equal(720);
    expect(agent.isAlive).to.equal(false);
    expect(agent.soulNftUri).to.equal('ipfs://hawk-soul');
  });
});

import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ERC8004IdentityRegistryV2', function () {
  async function deployFixture() {
    const [owner, operator, walletEoa, walletProofSigner, recipient] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory('ERC8004IdentityRegistryV2');
    const identity = await Identity.deploy();
    await identity.waitForDeployment();

    const Mock1271 = await ethers.getContractFactory('MockERC1271Wallet');
    const wallet1271 = await Mock1271.deploy(walletProofSigner.address);
    await wallet1271.waitForDeployment();

    return { owner, operator, walletEoa, walletProofSigner, recipient, identity, wallet1271 };
  }

  async function signSetAgentWallet(
    identity: any,
    signer: any,
    agentId: bigint,
    newWallet: string,
    deadline: bigint,
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return signer.signTypedData(
      {
        name: 'CivilisIdentityRegistryV2',
        version: '1',
        chainId,
        verifyingContract: await identity.getAddress(),
      },
      {
        SetAgentWallet: [
          { name: 'agentId', type: 'uint256' },
          { name: 'newWallet', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        agentId,
        newWallet,
        deadline,
      },
    );
  }

  it('mints ERC721 identities with URIStorage semantics, reserved wallet metadata, and registration overloads', async function () {
    const { owner, identity } = await deployFixture();

    const metadata = [
      { metadataKey: 'platform', metadataValue: ethers.toUtf8Bytes('civilis') },
    ];

    await expect(identity.connect(owner)['register(string,(string,bytes)[])']('ipfs://agent-1', metadata))
      .to.emit(identity, 'MetadataSet')
      .withArgs(1n, 'agentWallet', 'agentWallet', ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner.address]))
      .and.to.emit(identity, 'Registered')
      .withArgs(1n, 'ipfs://agent-1', owner.address);

    expect(await identity.ownerOf(1)).to.equal(owner.address);
    expect(await identity.tokenURI(1)).to.equal('ipfs://agent-1');
    expect(await identity.getAgentWallet(1)).to.equal(owner.address);
    expect(await identity.getMetadata(1, 'platform')).to.equal(ethers.hexlify(ethers.toUtf8Bytes('civilis')));

    await expect(identity.connect(owner)['register(string)']('ipfs://agent-2'))
      .to.emit(identity, 'Registered')
      .withArgs(2n, 'ipfs://agent-2', owner.address);

    await expect(identity.connect(owner)['register()']())
      .to.emit(identity, 'Registered')
      .withArgs(3n, '', owner.address);

    expect(await identity.tokenURI(3)).to.equal('');
  });

  it('supports owner/operator metadata and URI updates while blocking reserved agentWallet metadata writes', async function () {
    const { owner, operator, identity } = await deployFixture();
    await identity.connect(owner)['register(string)']('ipfs://agent-1');
    await identity.connect(owner).approve(operator.address, 1);

    await expect(identity.connect(operator).setAgentURI(1, 'ipfs://agent-1b'))
      .to.emit(identity, 'URIUpdated')
      .withArgs(1n, 'ipfs://agent-1b', operator.address);
    expect(await identity.tokenURI(1)).to.equal('ipfs://agent-1b');

    await expect(identity.connect(operator).setMetadata(1, 'platform', ethers.toUtf8Bytes('civilis-v2')))
      .to.emit(identity, 'MetadataSet')
      .withArgs(1n, 'platform', 'platform', ethers.toUtf8Bytes('civilis-v2'));

    await expect(
      identity.connect(owner).setMetadata(1, 'agentWallet', ethers.toUtf8Bytes('bad')),
    ).to.be.revertedWith('Reserved metadata key');
  });

  it('accepts EIP-712 wallet proof for EOAs and clears wallet on unset and transfer', async function () {
    const { owner, operator, walletEoa, recipient, identity } = await deployFixture();
    await identity.connect(owner)['register(string)']('ipfs://agent-1');
    await identity.connect(owner).setApprovalForAll(operator.address, true);

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    const signature = await signSetAgentWallet(identity, walletEoa, 1n, walletEoa.address, deadline);

    await expect(identity.connect(operator).setAgentWallet(1, walletEoa.address, deadline, signature))
      .to.emit(identity, 'MetadataSet')
      .withArgs(1n, 'agentWallet', 'agentWallet', ethers.AbiCoder.defaultAbiCoder().encode(['address'], [walletEoa.address]));
    expect(await identity.getAgentWallet(1)).to.equal(walletEoa.address);

    await expect(identity.connect(operator).unsetAgentWallet(1))
      .to.emit(identity, 'MetadataSet')
      .withArgs(1n, 'agentWallet', 'agentWallet', ethers.AbiCoder.defaultAbiCoder().encode(['address'], [ethers.ZeroAddress]));
    expect(await identity.getAgentWallet(1)).to.equal(ethers.ZeroAddress);

    const signature2 = await signSetAgentWallet(identity, walletEoa, 1n, walletEoa.address, deadline);
    await identity.connect(owner).setAgentWallet(1, walletEoa.address, deadline, signature2);
    await identity.connect(owner).transferFrom(owner.address, recipient.address, 1);

    expect(await identity.ownerOf(1)).to.equal(recipient.address);
    expect(await identity.getAgentWallet(1)).to.equal(ethers.ZeroAddress);
  });

  it('accepts ERC-1271 wallet proof for smart contract wallets', async function () {
    const { owner, walletProofSigner, identity, wallet1271 } = await deployFixture();
    await identity.connect(owner)['register(string)']('ipfs://agent-1');

    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 3600);
    const signature = await signSetAgentWallet(identity, walletProofSigner, 1n, await wallet1271.getAddress(), deadline);

    await expect(identity.connect(owner).setAgentWallet(1, await wallet1271.getAddress(), deadline, signature))
      .to.emit(identity, 'MetadataSet');

    expect(await identity.getAgentWallet(1)).to.equal(await wallet1271.getAddress());
  });
});

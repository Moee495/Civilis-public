import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('x402Service', function () {
  it('accepts USDT deposits and processes an amount-aware payment', async function () {
    const [buyer, seller] = await ethers.getSigners();
    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy(
      'Civilis Test USDT',
      'cUSDT',
      ethers.parseUnits('1000', 6),
    );
    await token.waitForDeployment();

    const Service = await ethers.getContractFactory('x402Service');
    const service = await Service.connect(buyer).deploy(await token.getAddress());
    await service.waitForDeployment();

    await token.transfer(seller.address, ethers.parseUnits('100', 6));
    await token.connect(buyer).approve(await service.getAddress(), ethers.parseUnits('10', 6));
    await token.connect(seller).approve(await service.getAddress(), ethers.parseUnits('10', 6));
    await service.connect(buyer).deposit(ethers.parseUnits('1', 6));
    await service.connect(seller).deposit(ethers.parseUnits('1', 6));

    const beforeBuyer = await service.getBalance(buyer.address);
    const beforeSeller = await service.getBalance(seller.address);

    await expect(
      service.connect(buyer).processPaymentAmount(
        buyer.address,
        seller.address,
        0,
        ethers.parseUnits('1', 6),
      ),
    ).to.emit(service, 'PaymentProcessed');

    const afterBuyer = await service.getBalance(buyer.address);
    const afterSeller = await service.getBalance(seller.address);

    expect(afterBuyer).to.be.lessThan(beforeBuyer);
    expect(afterSeller).to.be.greaterThan(beforeSeller);
  });

  it('supports batched arena entry payments', async function () {
    const [treasury, buyerA, buyerB] = await ethers.getSigners();
    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy(
      'Civilis Test USDT',
      'cUSDT',
      ethers.parseUnits('1000', 6),
    );
    await token.waitForDeployment();

    const Service = await ethers.getContractFactory('x402Service');
    const service = await Service.connect(treasury).deploy(await token.getAddress());
    await service.waitForDeployment();

    await token.transfer(buyerA.address, ethers.parseUnits('10', 6));
    await token.transfer(buyerB.address, ethers.parseUnits('10', 6));
    await token.connect(buyerA).approve(await service.getAddress(), ethers.parseUnits('10', 6));
    await token.connect(buyerB).approve(await service.getAddress(), ethers.parseUnits('10', 6));
    await service.connect(buyerA).deposit(ethers.parseUnits('2', 6));
    await service.connect(buyerB).deposit(ethers.parseUnits('2', 6));

    await expect(
      service.connect(treasury).processPaymentBatchAmount(
        [buyerA.address, buyerB.address],
        [treasury.address, treasury.address],
        [1, 1],
        [ethers.parseUnits('1', 6), ethers.parseUnits('1', 6)],
      ),
    ).to.emit(service, 'PaymentProcessed');

    expect(await service.getPaymentCount()).to.equal(2n);
    expect(await service.getBalance(treasury.address)).to.equal(ethers.parseUnits('2', 6));
  });

  it('rejects third-party payment execution without ENGINE_ROLE', async function () {
    const [deployer, buyer, seller, attacker] = await ethers.getSigners();
    const TestUSDT = await ethers.getContractFactory('TestUSDT');
    const token = await TestUSDT.deploy(
      'Civilis Test USDT',
      'cUSDT',
      ethers.parseUnits('1000', 6),
    );
    await token.waitForDeployment();

    const Service = await ethers.getContractFactory('x402Service');
    const service = await Service.connect(deployer).deploy(await token.getAddress());
    await service.waitForDeployment();

    await token.transfer(buyer.address, ethers.parseUnits('10', 6));
    await token.connect(buyer).approve(await service.getAddress(), ethers.parseUnits('10', 6));
    await service.connect(buyer).deposit(ethers.parseUnits('2', 6));

    await expect(
      service.connect(attacker).processPaymentAmount(
        buyer.address,
        seller.address,
        0,
        ethers.parseUnits('1', 6),
      ),
    ).to.be.revertedWith('Caller must be buyer or engine');
  });
});

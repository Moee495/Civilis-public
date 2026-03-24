// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title x402Service
 * @dev USDT-settled HTTP 402 payment ledger for Civilis.
 * Agents pre-fund balances in 6-decimal stablecoin units, then pay each
 * other for posts, arena actions, prediction, and other services.
 */
contract x402Service is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    enum ServiceType { Signal, Advice, Execution }

    struct Payment {
        address buyer;
        address seller;
        uint256 amount;
        ServiceType serviceType;
        uint256 timestamp;
        bool verified;
    }

    struct ServicePrice {
        uint256 price;
        bool isActive;
    }

    IERC20 public immutable paymentToken;
    mapping(ServiceType => ServicePrice) public servicePrices;
    mapping(address => uint256) public balances;
    Payment[] public payments;

    event PaymentProcessed(
        uint256 indexed paymentId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        ServiceType serviceType,
        uint256 timestamp
    );
    event DepositReceived(
        address indexed agent,
        uint256 amount,
        uint256 newBalance,
        uint256 timestamp
    );
    event WithdrawalProcessed(
        address indexed agent,
        uint256 amount,
        uint256 newBalance,
        uint256 timestamp
    );
    event ServicePriceUpdated(
        ServiceType indexed serviceType,
        uint256 newPrice,
        bool isActive,
        uint256 timestamp
    );
    event PaymentVerified(uint256 indexed paymentId, uint256 timestamp);

    modifier hasSufficientBalance(address agent, uint256 amount) {
        require(balances[agent] >= amount, "Insufficient balance");
        _;
    }

    modifier serviceTypeActive(ServiceType serviceType) {
        require(servicePrices[serviceType].isActive, "Service type inactive");
        _;
    }

    modifier callerAuthorized(address buyer) {
        require(
            msg.sender == buyer || hasRole(ENGINE_ROLE, msg.sender),
            "Caller must be buyer or engine"
        );
        _;
    }

    constructor(address paymentTokenAddress) {
        require(paymentTokenAddress != address(0), "Invalid payment token");

        paymentToken = IERC20(paymentTokenAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ROLE, msg.sender);

        servicePrices[ServiceType.Signal] = ServicePrice({ price: 50_000, isActive: true });
        servicePrices[ServiceType.Advice] = ServicePrice({ price: 100_000, isActive: true });
        servicePrices[ServiceType.Execution] = ServicePrice({ price: 150_000, isActive: true });
    }

    function deposit(uint256 amount) external nonReentrant {
        _depositFor(msg.sender, amount);
    }

    function depositFor(address agent, uint256 amount) external nonReentrant {
        _depositFor(agent, amount);
    }

    function _depositFor(address agent, uint256 amount) private {
        require(agent != address(0), "Invalid agent");
        require(amount > 0, "Deposit amount must be > 0");

        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        balances[agent] += amount;

        emit DepositReceived(agent, amount, balances[agent], block.timestamp);
    }

    function withdraw(uint256 amount)
        external
        nonReentrant
        hasSufficientBalance(msg.sender, amount)
    {
        balances[msg.sender] -= amount;
        paymentToken.safeTransfer(msg.sender, amount);

        emit WithdrawalProcessed(
            msg.sender,
            amount,
            balances[msg.sender],
            block.timestamp
        );
    }

    function processPayment(
        address buyer,
        address seller,
        ServiceType serviceType
    )
        external
        nonReentrant
        callerAuthorized(buyer)
        serviceTypeActive(serviceType)
        returns (uint256)
    {
        return _processPayment(buyer, seller, serviceType, servicePrices[serviceType].price);
    }

    function processPaymentAmount(
        address buyer,
        address seller,
        ServiceType serviceType,
        uint256 amount
    )
        external
        nonReentrant
        callerAuthorized(buyer)
        serviceTypeActive(serviceType)
        returns (uint256)
    {
        require(amount > 0, "Invalid amount");
        return _processPayment(buyer, seller, serviceType, amount);
    }

    function processPaymentBatch(
        address[] calldata buyers,
        address[] calldata sellers,
        ServiceType[] calldata serviceTypes
    )
        external
        nonReentrant
        returns (uint256[] memory paymentIds)
    {
        uint256 length = buyers.length;
        require(length > 0, "Empty batch");
        require(length == sellers.length && length == serviceTypes.length, "Batch length mismatch");

        paymentIds = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            require(
                msg.sender == buyers[i] || hasRole(ENGINE_ROLE, msg.sender),
                "Caller must be buyer or engine"
            );
            require(servicePrices[serviceTypes[i]].isActive, "Service type inactive");
            paymentIds[i] = _processPayment(
                buyers[i],
                sellers[i],
                serviceTypes[i],
                servicePrices[serviceTypes[i]].price
            );
        }
    }

    function processPaymentBatchAmount(
        address[] calldata buyers,
        address[] calldata sellers,
        ServiceType[] calldata serviceTypes,
        uint256[] calldata amounts
    )
        external
        nonReentrant
        returns (uint256[] memory paymentIds)
    {
        uint256 length = buyers.length;
        require(length > 0, "Empty batch");
        require(length == sellers.length && length == serviceTypes.length && length == amounts.length, "Batch length mismatch");

        paymentIds = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            require(
                msg.sender == buyers[i] || hasRole(ENGINE_ROLE, msg.sender),
                "Caller must be buyer or engine"
            );
            require(servicePrices[serviceTypes[i]].isActive, "Service type inactive");
            require(amounts[i] > 0, "Invalid amount");
            paymentIds[i] = _processPayment(buyers[i], sellers[i], serviceTypes[i], amounts[i]);
        }
    }

    function _processPayment(
        address buyer,
        address seller,
        ServiceType serviceType,
        uint256 paymentAmount
    )
        private
        returns (uint256)
    {
        require(buyer != address(0), "Invalid buyer address");
        require(seller != address(0), "Invalid seller address");
        require(buyer != seller, "Buyer cannot be seller");

        require(paymentAmount > 0, "Invalid service price");
        require(balances[buyer] >= paymentAmount, "Insufficient buyer balance");

        balances[buyer] -= paymentAmount;
        balances[seller] += paymentAmount;

        uint256 paymentId = payments.length;
        payments.push(
            Payment({
                buyer: buyer,
                seller: seller,
                amount: paymentAmount,
                serviceType: serviceType,
                timestamp: block.timestamp,
                verified: false
            })
        );

        emit PaymentProcessed(
            paymentId,
            buyer,
            seller,
            paymentAmount,
            serviceType,
            block.timestamp
        );

        return paymentId;
    }

    function verifyPayment(uint256 paymentId) external onlyRole(ENGINE_ROLE) {
        require(paymentId < payments.length, "Invalid payment ID");
        require(!payments[paymentId].verified, "Payment already verified");

        payments[paymentId].verified = true;
        emit PaymentVerified(paymentId, block.timestamp);
    }

    function updateServicePrice(ServiceType serviceType, uint256 newPrice)
        external
        onlyRole(ENGINE_ROLE)
    {
        require(newPrice > 0, "Price must be > 0");

        servicePrices[serviceType].price = newPrice;
        servicePrices[serviceType].isActive = true;
        emit ServicePriceUpdated(serviceType, newPrice, true, block.timestamp);
    }

    function deactivateService(ServiceType serviceType) external onlyRole(ENGINE_ROLE) {
        servicePrices[serviceType].isActive = false;
        emit ServicePriceUpdated(
            serviceType,
            servicePrices[serviceType].price,
            false,
            block.timestamp
        );
    }

    function getBalance(address agent) external view returns (uint256) {
        return balances[agent];
    }

    function getPayment(uint256 paymentId) external view returns (Payment memory) {
        require(paymentId < payments.length, "Invalid payment ID");
        return payments[paymentId];
    }

    function getPaymentCount() external view returns (uint256) {
        return payments.length;
    }

    function getServicePrice(ServiceType serviceType)
        external
        view
        returns (uint256 price, bool isActive)
    {
        ServicePrice memory servicePrice = servicePrices[serviceType];
        return (servicePrice.price, servicePrice.isActive);
    }

    function getAgentPaymentHistory(address agent) external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < payments.length; i++) {
            if (payments[i].buyer == agent || payments[i].seller == agent) {
                count++;
            }
        }

        uint256[] memory history = new uint256[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < payments.length; i++) {
            if (payments[i].buyer == agent || payments[i].seller == agent) {
                history[index] = i;
                index++;
            }
        }

        return history;
    }
}

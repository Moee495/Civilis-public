// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract Treasury is AccessControl {
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    uint256 public totalDeposits;
    uint256 public totalDistributed;

    struct Distribution {
        string recipientAgentId;
        uint256 amount;
        string reason;
        uint256 timestamp;
    }

    Distribution[] private distributions;

    event Deposited(uint256 amount, string source);
    event Distributed(string recipientAgentId, uint256 amount, string reason);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ROLE, msg.sender);
    }

    function deposit(uint256 amount, string calldata source) external onlyRole(ENGINE_ROLE) {
        totalDeposits += amount;
        emit Deposited(amount, source);
    }

    function distribute(
        string calldata recipientAgentId,
        uint256 amount,
        string calldata reason
    ) external onlyRole(ENGINE_ROLE) {
        totalDistributed += amount;
        distributions.push(
            Distribution({
                recipientAgentId: recipientAgentId,
                amount: amount,
                reason: reason,
                timestamp: block.timestamp
            })
        );

        emit Distributed(recipientAgentId, amount, reason);
    }

    function getDistributionCount() external view returns (uint256) {
        return distributions.length;
    }

    function getDistribution(uint256 index) external view returns (Distribution memory) {
        return distributions[index];
    }
}

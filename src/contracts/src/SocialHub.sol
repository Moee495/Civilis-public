// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract SocialHub is AccessControl {
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    struct SocialAction {
        string actionType;
        string fromAgentId;
        string toAgentId;
        uint256 amount;
        uint256 timestamp;
    }

    SocialAction[] private actions;
    uint256 public totalSocialVolume;

    event SocialActionRecorded(
        string actionType,
        string fromAgentId,
        string toAgentId,
        uint256 amount
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ROLE, msg.sender);
    }

    function recordAction(
        string calldata actionType,
        string calldata fromAgentId,
        string calldata toAgentId,
        uint256 amount
    ) external onlyRole(ENGINE_ROLE) {
        actions.push(
            SocialAction({
                actionType: actionType,
                fromAgentId: fromAgentId,
                toAgentId: toAgentId,
                amount: amount,
                timestamp: block.timestamp
            })
        );

        totalSocialVolume += amount;
        emit SocialActionRecorded(actionType, fromAgentId, toAgentId, amount);
    }

    function getActionCount() external view returns (uint256) {
        return actions.length;
    }

    function getRecentActions(uint256 offset, uint256 limit)
        external
        view
        returns (SocialAction[] memory)
    {
        require(offset <= actions.length, "Offset out of bounds");
        uint256 end = offset + limit > actions.length ? actions.length : offset + limit;
        SocialAction[] memory result = new SocialAction[](end - offset);

        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = actions[i];
        }

        return result;
    }
}

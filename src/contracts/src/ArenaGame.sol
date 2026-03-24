// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ArenaGame is AccessControl {
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    struct MatchData {
        uint256 id;
        string playerA;
        string playerB;
        uint256 entryFee;
        uint256 prizePool;
        uint8 playerAAction;
        uint8 playerBAction;
        uint256 playerAPayout;
        uint256 playerBPayout;
        bool isSettled;
        uint256 createdAt;
        uint256 settledAt;
    }

    MatchData[] private matches;
    uint256 public totalPrizeDistributed;

    event MatchCreated(uint256 indexed matchId, string playerA, string playerB, uint256 prizePool);
    event MatchSettled(uint256 indexed matchId, uint8 actionA, uint8 actionB, uint256 payoutA, uint256 payoutB);

    // ERC-8183 compatible lifecycle
    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt
    );
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ROLE, msg.sender);
    }

    function createMatch(
        string calldata playerA,
        string calldata playerB,
        uint256 entryFee,
        address clientAddress,
        address providerAddress
    ) external onlyRole(ENGINE_ROLE) returns (uint256 matchId) {
        matchId = matches.length;
        matches.push(
            MatchData({
                id: matchId,
                playerA: playerA,
                playerB: playerB,
                entryFee: entryFee,
                prizePool: entryFee * 2,
                playerAAction: 0,
                playerBAction: 0,
                playerAPayout: 0,
                playerBPayout: 0,
                isSettled: false,
                createdAt: block.timestamp,
                settledAt: 0
            })
        );

        emit MatchCreated(matchId, playerA, playerB, entryFee * 2);
        emit JobCreated(matchId, clientAddress, providerAddress, address(this), block.timestamp + 300);
    }

    function settleMatch(
        uint256 matchId,
        uint8 actionA,
        uint8 actionB,
        uint256 payoutA,
        uint256 payoutB
    ) external onlyRole(ENGINE_ROLE) {
        MatchData storage m = matches[matchId];
        require(!m.isSettled, "Already settled");

        m.playerAAction = actionA;
        m.playerBAction = actionB;
        m.playerAPayout = payoutA;
        m.playerBPayout = payoutB;
        m.isSettled = true;
        m.settledAt = block.timestamp;
        totalPrizeDistributed += payoutA + payoutB;

        bytes32 deliverable = keccak256(abi.encodePacked(actionA, actionB));
        bytes32 reason = keccak256(abi.encodePacked(payoutA, payoutB));

        emit MatchSettled(matchId, actionA, actionB, payoutA, payoutB);
        emit JobSubmitted(matchId, address(this), deliverable);
        emit JobCompleted(matchId, address(this), reason);
    }

    function getMatch(uint256 matchId) external view returns (MatchData memory) {
        return matches[matchId];
    }

    function getMatchCount() external view returns (uint256) {
        return matches.length;
    }
}

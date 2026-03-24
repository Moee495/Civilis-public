// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ERC8004ReputationRegistry is AccessControl {
    bytes32 public constant EVALUATOR_ROLE = keccak256("EVALUATOR_ROLE");

    struct FeedbackRecord {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
        bool isRevoked;
    }

    mapping(uint256 => mapping(address => FeedbackRecord[])) private feedbackByAgent;
    mapping(uint256 => address[]) private feedbackClientsByAgent;
    mapping(uint256 => mapping(address => bool)) private seenFeedbackClient;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(EVALUATOR_ROLE, msg.sender);
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        _giveFeedback(
            msg.sender,
            agentId,
            value,
            valueDecimals,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    function giveFeedbackFrom(
        address clientAddress,
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external onlyRole(EVALUATOR_ROLE) {
        _giveFeedback(
            clientAddress,
            agentId,
            value,
            valueDecimals,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    function _giveFeedback(
        address clientAddress,
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        require(clientAddress != address(0), "Invalid client");

        FeedbackRecord memory record = FeedbackRecord({
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            endpoint: endpoint,
            feedbackURI: feedbackURI,
            feedbackHash: feedbackHash,
            isRevoked: false
        });

        if (!seenFeedbackClient[agentId][clientAddress]) {
            seenFeedbackClient[agentId][clientAddress] = true;
            feedbackClientsByAgent[agentId].push(clientAddress);
        }

        feedbackByAgent[agentId][clientAddress].push(record);
        uint64 feedbackIndex = uint64(feedbackByAgent[agentId][clientAddress].length - 1);

        emit NewFeedback(
            agentId,
            clientAddress,
            feedbackIndex,
            value,
            valueDecimals,
            tag1,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex < feedbackByAgent[agentId][msg.sender].length, "Feedback not found");
        feedbackByAgent[agentId][msg.sender][feedbackIndex].isRevoked = true;
    }

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        int256 total = 0;
        uint64 matched = 0;
        bool decimalsSet = false;
        address[] memory clients;

        if (clientAddresses.length == 0) {
            address[] storage knownClients = feedbackClientsByAgent[agentId];
            clients = new address[](knownClients.length);
            for (uint256 i = 0; i < knownClients.length; i++) {
                clients[i] = knownClients[i];
            }
        } else {
            clients = clientAddresses;
        }

        for (uint256 i = 0; i < clients.length; i++) {
            FeedbackRecord[] storage items = feedbackByAgent[agentId][clients[i]];
            for (uint256 j = 0; j < items.length; j++) {
                FeedbackRecord storage item = items[j];
                if (item.isRevoked) continue;
                if (bytes(tag1).length > 0 && keccak256(bytes(item.tag1)) != keccak256(bytes(tag1))) continue;
                if (bytes(tag2).length > 0 && keccak256(bytes(item.tag2)) != keccak256(bytes(tag2))) continue;
                total += item.value;
                matched += 1;
                if (!decimalsSet) {
                    summaryValueDecimals = item.valueDecimals;
                    decimalsSet = true;
                }
            }
        }

        if (matched == 0) {
            return (0, 0, 0);
        }

        return (matched, int128(total / int256(uint256(matched))), summaryValueDecimals);
    }

    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) external view returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked) {
        require(feedbackIndex < feedbackByAgent[agentId][clientAddress].length, "Feedback not found");
        FeedbackRecord storage item = feedbackByAgent[agentId][clientAddress][feedbackIndex];
        return (item.value, item.valueDecimals, item.tag1, item.tag2, item.isRevoked);
    }

    function getKnownClients(uint256 agentId) external view returns (address[] memory) {
        return feedbackClientsByAgent[agentId];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract ERC8004ReputationRegistryV2 {
    struct FeedbackRecord {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    address private identityRegistry;
    bool private initialized;

    mapping(uint256 => mapping(address => FeedbackRecord[])) private feedbackByAgent;
    mapping(uint256 => address[]) private feedbackClientsByAgent;
    mapping(uint256 => mapping(address => bool)) private seenFeedbackClient;
    mapping(uint256 => mapping(address => mapping(uint64 => uint64))) private responseCounts;
    mapping(uint256 => mapping(address => mapping(uint64 => mapping(address => uint64)))) private responseCountsByResponder;

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

    event FeedbackRevoked(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 indexed feedbackIndex
    );

    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

    function initialize(address identityRegistry_) external {
        require(!initialized, "Already initialized");
        require(identityRegistry_ != address(0), "Invalid identity registry");

        identityRegistry = identityRegistry_;
        initialized = true;
    }

    function getIdentityRegistry() external view returns (address) {
        return identityRegistry;
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
        _requireInitialized();
        require(_agentExists(agentId), "Agent not found");
        require(valueDecimals <= 18, "Invalid valueDecimals");
        require(!_isOwnerOrOperator(agentId, msg.sender), "Owner/operator cannot feedback");

        if (!seenFeedbackClient[agentId][msg.sender]) {
            seenFeedbackClient[agentId][msg.sender] = true;
            feedbackClientsByAgent[agentId].push(msg.sender);
        }

        feedbackByAgent[agentId][msg.sender].push(
            FeedbackRecord({
                value: value,
                valueDecimals: valueDecimals,
                tag1: tag1,
                tag2: tag2,
                isRevoked: false
            })
        );

        uint64 feedbackIndex = uint64(feedbackByAgent[agentId][msg.sender].length);

        emit NewFeedback(
            agentId,
            msg.sender,
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
        FeedbackRecord storage feedback = _getFeedback(agentId, msg.sender, feedbackIndex);
        feedback.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        _getFeedback(agentId, clientAddress, feedbackIndex);
        responseCounts[agentId][clientAddress][feedbackIndex] += 1;
        responseCountsByResponder[agentId][clientAddress][feedbackIndex][msg.sender] += 1;

        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        _requireInitialized();
        require(_agentExists(agentId), "Agent not found");
        require(clientAddresses.length > 0, "Client filter required");

        int256 totalScaled = 0;

        for (uint256 i = 0; i < clientAddresses.length; i++) {
            FeedbackRecord[] storage items = feedbackByAgent[agentId][clientAddresses[i]];
            for (uint256 j = 0; j < items.length; j++) {
                FeedbackRecord storage item = items[j];
                if (item.isRevoked) continue;
                if (bytes(tag1).length > 0 && keccak256(bytes(item.tag1)) != keccak256(bytes(tag1))) continue;
                if (bytes(tag2).length > 0 && keccak256(bytes(item.tag2)) != keccak256(bytes(tag2))) continue;

                totalScaled += _scaleTo18(item.value, item.valueDecimals);
                count += 1;
            }
        }

        if (count == 0) {
            return (0, 0, 0);
        }

        summaryValueDecimals = 18;
        summaryValue = int128(totalScaled / int256(uint256(count)));
    }

    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    )
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        FeedbackRecord storage feedback = _getFeedback(agentId, clientAddress, feedbackIndex);
        return (feedback.value, feedback.valueDecimals, feedback.tag1, feedback.tag2, feedback.isRevoked);
    }

    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    )
        external
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        )
    {
        _requireInitialized();
        require(_agentExists(agentId), "Agent not found");

        address[] memory selectedClients = _resolveClients(agentId, clientAddresses);
        uint256 matchCount = _countMatchingFeedback(agentId, selectedClients, tag1, tag2, includeRevoked);

        clients = new address[](matchCount);
        feedbackIndexes = new uint64[](matchCount);
        values = new int128[](matchCount);
        valueDecimals = new uint8[](matchCount);
        tag1s = new string[](matchCount);
        tag2s = new string[](matchCount);
        revokedStatuses = new bool[](matchCount);

        uint256 cursor = 0;
        for (uint256 i = 0; i < selectedClients.length; i++) {
            FeedbackRecord[] storage items = feedbackByAgent[agentId][selectedClients[i]];
            for (uint256 j = 0; j < items.length; j++) {
                FeedbackRecord storage item = items[j];
                if (!includeRevoked && item.isRevoked) continue;
                if (bytes(tag1).length > 0 && keccak256(bytes(item.tag1)) != keccak256(bytes(tag1))) continue;
                if (bytes(tag2).length > 0 && keccak256(bytes(item.tag2)) != keccak256(bytes(tag2))) continue;

                clients[cursor] = selectedClients[i];
                feedbackIndexes[cursor] = uint64(j + 1);
                values[cursor] = item.value;
                valueDecimals[cursor] = item.valueDecimals;
                tag1s[cursor] = item.tag1;
                tag2s[cursor] = item.tag2;
                revokedStatuses[cursor] = item.isRevoked;
                cursor += 1;
            }
        }
    }

    function getResponseCount(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        address[] calldata responders
    ) external view returns (uint64 count) {
        _getFeedback(agentId, clientAddress, feedbackIndex);

        if (responders.length == 0) {
            return responseCounts[agentId][clientAddress][feedbackIndex];
        }

        for (uint256 i = 0; i < responders.length; i++) {
            count += responseCountsByResponder[agentId][clientAddress][feedbackIndex][responders[i]];
        }
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return feedbackClientsByAgent[agentId];
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(feedbackByAgent[agentId][clientAddress].length);
    }

    function _requireInitialized() internal view {
        require(initialized, "Not initialized");
    }

    function _agentExists(uint256 agentId) internal view returns (bool) {
        if (!initialized) {
            return false;
        }

        try IERC721(identityRegistry).ownerOf(agentId) returns (address owner) {
            return owner != address(0);
        } catch {
            return false;
        }
    }

    function _isOwnerOrOperator(uint256 agentId, address actor) internal view returns (bool) {
        address owner;
        try IERC721(identityRegistry).ownerOf(agentId) returns (address resolvedOwner) {
            owner = resolvedOwner;
        } catch {
            return false;
        }

        return
            actor == owner ||
            IERC721(identityRegistry).getApproved(agentId) == actor ||
            IERC721(identityRegistry).isApprovedForAll(owner, actor);
    }

    function _getFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) internal view returns (FeedbackRecord storage feedback) {
        require(feedbackIndex > 0, "Feedback not found");
        uint256 zeroIndexed = uint256(feedbackIndex - 1);
        require(zeroIndexed < feedbackByAgent[agentId][clientAddress].length, "Feedback not found");
        return feedbackByAgent[agentId][clientAddress][zeroIndexed];
    }

    function _scaleTo18(int128 value, uint8 valueDecimals) internal pure returns (int256) {
        return int256(value) * int256(10 ** uint256(18 - valueDecimals));
    }

    function _resolveClients(
        uint256 agentId,
        address[] calldata clientAddresses
    ) internal view returns (address[] memory clients) {
        if (clientAddresses.length == 0) {
            address[] storage knownClients = feedbackClientsByAgent[agentId];
            clients = new address[](knownClients.length);
            for (uint256 i = 0; i < knownClients.length; i++) {
                clients[i] = knownClients[i];
            }
        } else {
            clients = new address[](clientAddresses.length);
            for (uint256 i = 0; i < clientAddresses.length; i++) {
                clients[i] = clientAddresses[i];
            }
        }
    }

    function _countMatchingFeedback(
        uint256 agentId,
        address[] memory clients,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    ) internal view returns (uint256 matchCount) {
        for (uint256 i = 0; i < clients.length; i++) {
            FeedbackRecord[] storage items = feedbackByAgent[agentId][clients[i]];
            for (uint256 j = 0; j < items.length; j++) {
                FeedbackRecord storage item = items[j];
                if (!includeRevoked && item.isRevoked) continue;
                if (bytes(tag1).length > 0 && keccak256(bytes(item.tag1)) != keccak256(bytes(tag1))) continue;
                if (bytes(tag2).length > 0 && keccak256(bytes(item.tag2)) != keccak256(bytes(tag2))) continue;
                matchCount += 1;
            }
        }
    }
}

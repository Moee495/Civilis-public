// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract ERC8004ValidationRegistryV2 {
    struct ValidationRecord {
        address validatorAddress;
        uint256 agentId;
        bytes32 requestHash;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool exists;
        bool hasResponse;
    }

    address private identityRegistry;
    bool private initialized;

    mapping(bytes32 => ValidationRecord) private validations;
    mapping(uint256 => bytes32[]) private agentValidationHashes;
    mapping(address => bytes32[]) private validatorRequestHashes;

    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );

    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
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

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        _requireInitialized();
        require(_isOwnerOrOperator(agentId, msg.sender), "Not owner or operator");
        require(validatorAddress != address(0), "Invalid validator");
        require(bytes(requestURI).length > 0, "Invalid requestURI");
        require(requestHash != bytes32(0), "Invalid requestHash");
        require(!validations[requestHash].exists, "Request already exists");

        validations[requestHash] = ValidationRecord({
            validatorAddress: validatorAddress,
            agentId: agentId,
            requestHash: requestHash,
            response: 0,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: block.timestamp,
            exists: true,
            hasResponse: false
        });

        agentValidationHashes[agentId].push(requestHash);
        validatorRequestHashes[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationRecord storage record = validations[requestHash];
        require(record.exists, "Validation not found");
        require(msg.sender == record.validatorAddress, "Only assigned validator");
        require(response <= 100, "Response out of range");

        record.response = response;
        record.responseHash = responseHash;
        record.tag = tag;
        record.lastUpdate = block.timestamp;
        record.hasResponse = true;

        emit ValidationResponse(
            record.validatorAddress,
            record.agentId,
            requestHash,
            response,
            responseURI,
            responseHash,
            tag
        );
    }

    function getValidationStatus(
        bytes32 requestHash
    )
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        ValidationRecord storage record = validations[requestHash];
        require(record.exists, "Validation not found");
        return (
            record.validatorAddress,
            record.agentId,
            record.response,
            record.responseHash,
            record.tag,
            record.lastUpdate
        );
    }

    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    ) external view returns (uint64 count, uint8 averageResponse) {
        _requireInitialized();
        require(_agentExists(agentId), "Agent not found");

        uint256 totalResponse = 0;
        bytes32[] storage requestHashes = agentValidationHashes[agentId];

        for (uint256 i = 0; i < requestHashes.length; i++) {
            ValidationRecord storage record = validations[requestHashes[i]];
            if (!record.hasResponse) continue;
            if (validatorAddresses.length > 0 && !_containsAddress(validatorAddresses, record.validatorAddress)) continue;
            if (bytes(tag).length > 0 && keccak256(bytes(record.tag)) != keccak256(bytes(tag))) continue;

            count += 1;
            totalResponse += record.response;
        }

        if (count == 0) {
            return (0, 0);
        }

        averageResponse = uint8(totalResponse / count);
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes) {
        return agentValidationHashes[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes) {
        return validatorRequestHashes[validatorAddress];
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

    function _containsAddress(
        address[] calldata addresses,
        address candidate
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < addresses.length; i++) {
            if (addresses[i] == candidate) {
                return true;
            }
        }
        return false;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ERC8004ValidationRegistry is AccessControl {
    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");

    struct ValidationRecord {
        address validatorAddress;
        uint256 agentId;
        string requestURI;
        bytes32 requestHash;
        uint8 response;
        string responseURI;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
    }

    struct SummaryStat {
        uint64 count;
        uint256 totalResponse;
    }

    mapping(bytes32 => ValidationRecord) private validations;
    mapping(uint256 => mapping(bytes32 => SummaryStat)) private summaries;

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

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VALIDATOR_ROLE, msg.sender);
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external onlyRole(VALIDATOR_ROLE) {
        validations[requestHash] = ValidationRecord({
            validatorAddress: validatorAddress,
            agentId: agentId,
            requestURI: requestURI,
            requestHash: requestHash,
            response: 0,
            responseURI: "",
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: block.timestamp
        });

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external onlyRole(VALIDATOR_ROLE) {
        ValidationRecord storage record = validations[requestHash];
        require(record.requestHash != bytes32(0), "Validation not found");

        record.response = response;
        record.responseURI = responseURI;
        record.responseHash = responseHash;
        record.tag = tag;
        record.lastUpdate = block.timestamp;

        bytes32 tagHash = keccak256(bytes(tag));
        summaries[record.agentId][tagHash].count += 1;
        summaries[record.agentId][tagHash].totalResponse += response;

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

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate)
    {
        ValidationRecord storage record = validations[requestHash];
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
        address[] calldata,
        string calldata tag
    ) external view returns (uint64 count, uint8 averageResponse) {
        SummaryStat storage stat = summaries[agentId][keccak256(bytes(tag))];
        if (stat.count == 0) {
            return (0, 0);
        }

        return (stat.count, uint8(stat.totalResponse / stat.count));
    }
}

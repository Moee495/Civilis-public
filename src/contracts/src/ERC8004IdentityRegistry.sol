// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract ERC8004IdentityRegistry is ERC721, AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    uint256 private nextAgentId = 1;

    mapping(uint256 => string) private agentUris;
    mapping(uint256 => address) private agentWallets;
    mapping(uint256 => mapping(bytes32 => bytes)) private metadataValues;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    constructor() ERC721("Civilis Identity Registry", "CIVID") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRAR_ROLE, msg.sender);
    }

    function register(
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId) {
        return _register(msg.sender, agentURI, metadata);
    }

    function registerFor(
        address owner,
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external onlyRole(REGISTRAR_ROLE) returns (uint256 agentId) {
        return _register(owner, agentURI, metadata);
    }

    function _register(
        address owner,
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) internal returns (uint256 agentId) {
        require(owner != address(0), "Invalid owner");

        agentId = nextAgentId++;
        _safeMint(owner, agentId);
        agentUris[agentId] = agentURI;
        agentWallets[agentId] = owner;

        for (uint256 i = 0; i < metadata.length; i++) {
            metadataValues[agentId][keccak256(bytes(metadata[i].metadataKey))] = metadata[i].metadataValue;
        }

        emit Registered(agentId, agentURI, owner);
    }

    function setAgentWallet(uint256 agentId, address wallet) external onlyRole(REGISTRAR_ROLE) {
        require(_ownerOf(agentId) != address(0), "Agent not found");
        require(wallet != address(0), "Invalid wallet");
        agentWallets[agentId] = wallet;
    }

    function transferAgent(uint256 agentId, address newOwner) external onlyRole(REGISTRAR_ROLE) {
        require(_ownerOf(agentId) != address(0), "Agent not found");
        require(newOwner != address(0), "Invalid owner");
        address previousOwner = ownerOf(agentId);
        _transfer(previousOwner, newOwner, agentId);
        agentWallets[agentId] = newOwner;
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(_ownerOf(agentId) != address(0), "Agent not found");
        require(
            _isAuthorized(ownerOf(agentId), msg.sender, agentId) || hasRole(REGISTRAR_ROLE, msg.sender),
            "Not authorized"
        );
        agentUris[agentId] = newURI;
    }

    function setMetadata(
        uint256 agentId,
        string calldata metadataKey,
        bytes calldata metadataValue
    ) external {
        require(_ownerOf(agentId) != address(0), "Agent not found");
        require(
            _isAuthorized(ownerOf(agentId), msg.sender, agentId) || hasRole(REGISTRAR_ROLE, msg.sender),
            "Not authorized"
        );
        metadataValues[agentId][keccak256(bytes(metadataKey))] = metadataValue;
    }

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        return metadataValues[agentId][keccak256(bytes(metadataKey))];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return agentWallets[agentId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "Agent not found");
        return agentUris[tokenId];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract ERC8004IdentityRegistryV2 is ERC721URIStorage, EIP712 {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    bytes32 private constant SET_AGENT_WALLET_TYPEHASH =
        keccak256("SetAgentWallet(uint256 agentId,address newWallet,uint256 deadline)");
    bytes32 private constant AGENT_WALLET_KEY_HASH = keccak256("agentWallet");
    string private constant AGENT_WALLET_KEY = "agentWallet";

    uint256 private nextAgentId = 1;

    mapping(uint256 => address) private agentWallets;
    mapping(uint256 => mapping(bytes32 => bytes)) private metadataValues;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId,
        string indexed indexedMetadataKey,
        string metadataKey,
        bytes metadataValue
    );
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    constructor()
        ERC721("Civilis Identity Registry V2", "CIVID2")
        EIP712("CivilisIdentityRegistryV2", "1")
    {}

    function register(
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId) {
        MetadataEntry[] memory copied = new MetadataEntry[](metadata.length);
        for (uint256 i = 0; i < metadata.length; i++) {
            copied[i] = metadata[i];
        }
        return _register(msg.sender, agentURI, copied);
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        MetadataEntry[] memory empty;
        return _register(msg.sender, agentURI, empty);
    }

    function register() external returns (uint256 agentId) {
        MetadataEntry[] memory empty;
        return _register(msg.sender, "", empty);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");

        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function setMetadata(
        uint256 agentId,
        string calldata metadataKey,
        bytes calldata metadataValue
    ) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        require(keccak256(bytes(metadataKey)) != AGENT_WALLET_KEY_HASH, "Reserved metadata key");

        metadataValues[agentId][keccak256(bytes(metadataKey))] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getMetadata(
        uint256 agentId,
        string calldata metadataKey
    ) external view returns (bytes memory) {
        ownerOf(agentId);
        if (keccak256(bytes(metadataKey)) == AGENT_WALLET_KEY_HASH) {
            return abi.encode(agentWallets[agentId]);
        }
        return metadataValues[agentId][keccak256(bytes(metadataKey))];
    }

    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");
        require(newWallet != address(0), "Invalid wallet");
        require(block.timestamp <= deadline, "Signature expired");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(SET_AGENT_WALLET_TYPEHASH, agentId, newWallet, deadline))
        );
        require(
            SignatureChecker.isValidSignatureNowCalldata(newWallet, digest, signature),
            "Invalid wallet proof"
        );

        agentWallets[agentId] = newWallet;
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encode(newWallet));
    }

    function unsetAgentWallet(uint256 agentId) external {
        address owner = ownerOf(agentId);
        require(_isAuthorized(owner, msg.sender, agentId), "Not authorized");

        agentWallets[agentId] = address(0);
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encode(address(0)));
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        ownerOf(agentId);
        return agentWallets[agentId];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _register(
        address owner,
        string memory agentURI,
        MetadataEntry[] memory metadata
    ) internal returns (uint256 agentId) {
        agentId = nextAgentId++;
        _safeMint(owner, agentId);
        _setTokenURI(agentId, agentURI);
        agentWallets[agentId] = owner;

        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encode(owner));

        for (uint256 i = 0; i < metadata.length; i++) {
            require(
                keccak256(bytes(metadata[i].metadataKey)) != AGENT_WALLET_KEY_HASH,
                "Reserved metadata key"
            );
            metadataValues[agentId][keccak256(bytes(metadata[i].metadataKey))] = metadata[i].metadataValue;
            emit MetadataSet(
                agentId,
                metadata[i].metadataKey,
                metadata[i].metadataKey,
                metadata[i].metadataValue
            );
        }

        emit Registered(agentId, agentURI, owner);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address previousOwner) {
        previousOwner = super._update(to, tokenId, auth);

        if (previousOwner != address(0) && to != address(0) && previousOwner != to) {
            agentWallets[tokenId] = address(0);
            emit MetadataSet(tokenId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encode(address(0)));
        }
    }
}

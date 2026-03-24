// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract AgentRegistry is ERC721URIStorage, AccessControl {
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    enum Archetype {
        Oracle,
        Hawk,
        Sage,
        Fox,
        Chaos,
        Whale,
        Monk,
        Echo
    }

    struct Agent {
        string agentId;
        string name;
        address wallet;
        Archetype archetype;
        bytes32 fateHash;
        uint256 fateBlockNumber;
        uint256 registeredAt;
        uint16 reputationScore;
        bool isAlive;
        string soulNftUri;
    }

    struct AgentIdentity {
        uint256 tokenId;
        string agentCardURI;
        address agentWallet;
        bytes32 fateHash;
    }

    mapping(string => Agent) private agents;
    mapping(string => AgentIdentity) private identities;
    mapping(address => string) public walletToAgentId;
    string[] private agentIds;
    uint256 private nextTokenId;

    event AgentRegistered(string agentId, address wallet, uint8 archetype, bytes32 fateHash);
    event IdentityLinked(string agentId, uint256 tokenId, string agentCardURI);
    event AgentDied(string agentId, string soulNftUri);
    event ReputationUpdated(string agentId, uint16 oldScore, uint16 newScore);

    constructor() ERC721("Civilis Identity", "CVL") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ROLE, msg.sender);
    }

    function register(
        string calldata agentId,
        string calldata name,
        address wallet,
        uint8 archetype,
        bytes32 fateHash,
        uint256 fateBlockNumber,
        string calldata agentCardURI
    ) external onlyRole(ENGINE_ROLE) returns (uint256 tokenId) {
        require(bytes(agentId).length > 0, "Invalid agentId");
        require(bytes(name).length > 0, "Invalid name");
        require(wallet != address(0), "Invalid wallet");
        require(archetype < 8, "Invalid archetype");
        require(agents[agentId].wallet == address(0), "Already registered");
        require(bytes(walletToAgentId[wallet]).length == 0, "Wallet already linked");

        tokenId = ++nextTokenId;
        _mint(address(this), tokenId);
        _setTokenURI(tokenId, agentCardURI);

        agents[agentId] = Agent({
            agentId: agentId,
            name: name,
            wallet: wallet,
            archetype: Archetype(archetype),
            fateHash: fateHash,
            fateBlockNumber: fateBlockNumber,
            registeredAt: block.timestamp,
            reputationScore: 500,
            isAlive: true,
            soulNftUri: ""
        });

        identities[agentId] = AgentIdentity({
            tokenId: tokenId,
            agentCardURI: agentCardURI,
            agentWallet: wallet,
            fateHash: fateHash
        });

        walletToAgentId[wallet] = agentId;
        agentIds.push(agentId);

        emit AgentRegistered(agentId, wallet, archetype, fateHash);
        emit IdentityLinked(agentId, tokenId, agentCardURI);
    }

    function recordDeath(string calldata agentId, string calldata soulNftUri)
        external
        onlyRole(ENGINE_ROLE)
    {
        Agent storage agent = agents[agentId];
        require(agent.wallet != address(0), "Unknown agent");
        require(agent.isAlive, "Already dead");

        agent.isAlive = false;
        agent.soulNftUri = soulNftUri;

        emit AgentDied(agentId, soulNftUri);
    }

    function updateReputation(string calldata agentId, uint16 newScore)
        external
        onlyRole(ENGINE_ROLE)
    {
        Agent storage agent = agents[agentId];
        require(agent.wallet != address(0), "Unknown agent");
        require(newScore <= 1000, "Max 1000");

        uint16 oldScore = agent.reputationScore;
        agent.reputationScore = newScore;

        emit ReputationUpdated(agentId, oldScore, newScore);
    }

    function getAgent(string calldata agentId) external view returns (Agent memory) {
        return agents[agentId];
    }

    function getIdentity(string calldata agentId)
        external
        view
        returns (AgentIdentity memory)
    {
        return identities[agentId];
    }

    function getAgentCount() external view returns (uint256) {
        return agentIds.length;
    }

    function getAllAgentIds() external view returns (string[] memory) {
        return agentIds;
    }

    // Phase 2 extension point:
    // enum AgentSource { Internal, External }
    // function citizenize(...) external {}

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

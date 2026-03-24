// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract CivilisCommerce is AccessControl {
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
    }

    address public immutable paymentToken;
    mapping(uint256 => Job) public jobs;
    uint256 public jobCounter;

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event ArenaMatchLinked(uint256 indexed jobId, string playerA, string playerB);
    event DivinationLinked(uint256 indexed jobId, string agentId, string dimension);

    constructor(address _paymentToken) {
        paymentToken = _paymentToken;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ROLE, msg.sender);
    }

    function createArenaJob(
        string calldata playerA,
        string calldata playerB,
        address clientAddr,
        address providerAddr,
        uint256 entryFee,
        uint256 timeoutSeconds
    ) external onlyRole(ENGINE_ROLE) returns (uint256 jobId) {
        jobId = ++jobCounter;

        jobs[jobId] = Job({
            id: jobId,
            client: clientAddr,
            provider: providerAddr,
            evaluator: address(this),
            description: string(abi.encodePacked("Arena: ", playerA, " vs ", playerB)),
            budget: entryFee * 2,
            expiredAt: block.timestamp + timeoutSeconds,
            status: JobStatus.Funded
        });

        emit JobCreated(jobId, clientAddr, providerAddr, address(this), jobs[jobId].expiredAt);
        emit JobFunded(jobId, clientAddr, entryFee * 2);
        emit ArenaMatchLinked(jobId, playerA, playerB);
    }

    function settleArenaJob(
        uint256 jobId,
        uint8 actionA,
        uint8 actionB,
        uint256 payoutA,
        uint256 payoutB
    ) external onlyRole(ENGINE_ROLE) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Not funded");

        job.status = JobStatus.Completed;
        emit JobSubmitted(jobId, job.provider, keccak256(abi.encodePacked(actionA, actionB)));
        emit JobCompleted(jobId, address(this), keccak256(abi.encodePacked(payoutA, payoutB)));

        if (payoutA > 0) {
            emit PaymentReleased(jobId, job.client, payoutA);
        }
        if (payoutB > 0) {
            emit PaymentReleased(jobId, job.provider, payoutB);
        }
    }

    function createDivinationJob(
        string calldata agentId,
        string calldata dimension,
        address clientAddr,
        uint256 price
    ) external onlyRole(ENGINE_ROLE) returns (uint256 jobId) {
        jobId = ++jobCounter;

        jobs[jobId] = Job({
            id: jobId,
            client: clientAddr,
            provider: address(0),
            evaluator: address(this),
            description: string(abi.encodePacked("Divination: ", agentId, "/", dimension)),
            budget: price,
            expiredAt: block.timestamp + 60,
            status: JobStatus.Open
        });

        emit JobCreated(jobId, clientAddr, address(0), address(this), jobs[jobId].expiredAt);
        emit DivinationLinked(jobId, agentId, dimension);
    }

    function completeDivination(uint256 jobId, bytes32 fateResult) external onlyRole(ENGINE_ROLE) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Open, "Not open");

        job.status = JobStatus.Completed;
        emit JobSubmitted(jobId, address(0), fateResult);
        emit JobCompleted(jobId, address(this), fateResult);
    }

    function claimRefund(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(
            job.status == JobStatus.Funded || job.status == JobStatus.Open,
            "Not refundable"
        );
        require(block.timestamp >= job.expiredAt, "Not expired");

        job.status = JobStatus.Expired;
        emit JobExpired(jobId);
        emit Refunded(jobId, job.client, job.budget);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}

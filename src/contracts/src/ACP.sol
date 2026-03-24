// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ACP is AccessControl {
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
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
        bytes32 deliverable;
        bytes32 reason;
    }

    Job[] private jobs;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ROLE, msg.sender);
    }

    function createJobFor(
        address client,
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external onlyRole(ENGINE_ROLE) returns (uint256 jobId) {
        return _createJob(client, provider, evaluator, expiredAt, description, hook);
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        return _createJob(msg.sender, provider, evaluator, expiredAt, description, hook);
    }

    function _createJob(
        address client,
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) internal returns (uint256 jobId) {
        require(client != address(0), "Invalid client");
        require(provider != address(0), "Invalid provider");
        require(evaluator != address(0), "Invalid evaluator");

        jobId = jobs.length;
        jobs.push(
            Job({
                client: client,
                provider: provider,
                evaluator: evaluator,
                description: description,
                budget: 0,
                expiredAt: expiredAt,
                status: JobStatus.Open,
                hook: hook,
                deliverable: bytes32(0),
                reason: bytes32(0)
            })
        );

        emit JobCreated(jobId, client, provider, evaluator, expiredAt, hook);
    }

    function setProvider(uint256 jobId, address provider_) external onlyRole(ENGINE_ROLE) {
        jobs[jobId].provider = provider_;
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external onlyRole(ENGINE_ROLE) {
        jobs[jobId].budget = amount;
    }

    function fund(uint256 jobId, bytes calldata) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Open || job.status == JobStatus.Funded, "Invalid status");
        require(
            msg.sender == job.client || hasRole(ENGINE_ROLE, msg.sender),
            "Only client or engine can fund"
        );
        job.status = JobStatus.Funded;
        emit JobFunded(jobId, job.client, job.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Not funded");
        require(
            msg.sender == job.provider || hasRole(ENGINE_ROLE, msg.sender),
            "Only provider or engine can submit"
        );
        job.status = JobStatus.Submitted;
        job.deliverable = deliverable;
        emit JobSubmitted(jobId, job.provider, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded || job.status == JobStatus.Submitted, "Invalid status");
        require(
            msg.sender == job.evaluator || hasRole(ENGINE_ROLE, msg.sender),
            "Only evaluator or engine can complete"
        );
        job.status = JobStatus.Completed;
        job.reason = reason;
        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, job.budget);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded || job.status == JobStatus.Submitted, "Invalid status");
        require(
            msg.sender == job.evaluator || msg.sender == job.client || hasRole(ENGINE_ROLE, msg.sender),
            "Only client, evaluator, or engine can reject"
        );
        job.status = JobStatus.Rejected;
        job.reason = reason;
        emit JobRejected(jobId, msg.sender, reason);
        emit Refunded(jobId, job.client, job.budget);
    }

    function claimRefund(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Open || job.status == JobStatus.Funded, "Refund unavailable");
        require(block.timestamp >= job.expiredAt, "Not expired");
        require(
            msg.sender == job.client || hasRole(ENGINE_ROLE, msg.sender),
            "Only client or engine can claim refund"
        );
        job.status = JobStatus.Expired;
        emit Refunded(jobId, job.client, job.budget);
    }

    function getJob(uint256 jobId)
        external
        view
        returns (
            address client,
            address provider,
            address evaluator,
            string memory description,
            uint256 budget,
            uint256 expiredAt,
            uint8 status,
            address hook
        )
    {
        Job storage job = jobs[jobId];
        return (
            job.client,
            job.provider,
            job.evaluator,
            job.description,
            job.budget,
            job.expiredAt,
            uint8(job.status),
            job.hook
        );
    }

    function getJobCount() external view returns (uint256) {
        return jobs.length;
    }
}

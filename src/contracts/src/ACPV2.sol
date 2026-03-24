// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IACPV2.sol";
import "./interfaces/IACPHook.sol";

/// @title ACPV2
/// @notice Minimal ERC-8183-style escrow kernel with OPTIONAL hook support.
/// @dev This implementation intentionally limits scope to the minimal path
///      approved for Gate C2. It uses a single ERC-20 payment token per
///      contract, supports OPTIONAL per-job hooks for the six hookable core
///      actions, keeps `claimRefund(...)` non-hookable, and always emits
///      `feeAmount = 0` on completion.
contract ACPV2 is IACPV2, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    address public immutable override paymentToken;

    Job[] private jobs;

    constructor(address paymentToken_) {
        require(paymentToken_ != address(0), "Invalid payment token");
        paymentToken = paymentToken_;
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external override returns (uint256 jobId) {
        require(evaluator != address(0), "Invalid evaluator");
        require(expiredAt > block.timestamp, "Expiry must be future");
        require(hook == address(0) || hook.code.length > 0, "Invalid hook");

        jobId = jobs.length;
        jobs.push(
            Job({
                client: msg.sender,
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

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    function setProvider(
        uint256 jobId,
        address provider,
        bytes calldata optParams
    ) external override nonReentrant {
        Job storage job = _getJob(jobId);
        require(job.status == JobStatus.Open, "Job not open");
        require(msg.sender == job.client, "Only client");
        require(job.provider == address(0), "Provider already set");
        require(provider != address(0), "Invalid provider");

        bytes4 selector = this.setProvider.selector;
        bytes memory data = abi.encode(provider, optParams);
        _beforeHook(job, jobId, selector, data);

        job.provider = provider;
        emit ProviderSet(jobId, msg.sender, provider);

        _afterHook(job, jobId, selector, data);
    }

    function setBudget(
        uint256 jobId,
        uint256 amount,
        bytes calldata optParams
    ) external override nonReentrant {
        Job storage job = _getJob(jobId);
        require(job.status == JobStatus.Open, "Job not open");
        require(
            msg.sender == job.client || msg.sender == job.provider,
            "Only client or provider"
        );

        bytes4 selector = this.setBudget.selector;
        bytes memory data = abi.encode(amount, optParams);
        _beforeHook(job, jobId, selector, data);

        job.budget = amount;
        emit BudgetSet(jobId, msg.sender, amount);

        _afterHook(job, jobId, selector, data);
    }

    function fund(
        uint256 jobId,
        uint256 expectedBudget,
        bytes calldata optParams
    ) external override nonReentrant {
        Job storage job = _getJob(jobId);
        require(job.status == JobStatus.Open, "Job not open");
        require(msg.sender == job.client, "Only client");
        require(job.budget > 0, "Budget is zero");
        require(job.provider != address(0), "Provider not set");
        require(job.budget == expectedBudget, "Budget mismatch");

        bytes4 selector = this.fund.selector;
        bytes memory data = optParams;
        _beforeHook(job, jobId, selector, data);

        job.status = JobStatus.Funded;
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), job.budget);

        emit JobFunded(jobId, msg.sender, job.budget);

        _afterHook(job, jobId, selector, data);
    }

    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata optParams
    ) external override nonReentrant {
        Job storage job = _getJob(jobId);
        require(job.status == JobStatus.Funded, "Job not funded");
        require(msg.sender == job.provider, "Only provider");

        bytes4 selector = this.submit.selector;
        bytes memory data = abi.encode(deliverable, optParams);
        _beforeHook(job, jobId, selector, data);

        job.status = JobStatus.Submitted;
        job.deliverable = deliverable;

        emit JobSubmitted(jobId, msg.sender, deliverable);

        _afterHook(job, jobId, selector, data);
    }

    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external override nonReentrant {
        Job storage job = _getJob(jobId);
        require(job.status == JobStatus.Submitted, "Job not submitted");
        require(msg.sender == job.evaluator, "Only evaluator");

        bytes4 selector = this.complete.selector;
        bytes memory data = abi.encode(reason, optParams);
        _beforeHook(job, jobId, selector, data);

        uint256 providerAmount = job.budget;
        job.status = JobStatus.Completed;
        job.reason = reason;

        IERC20(paymentToken).safeTransfer(job.provider, providerAmount);

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, providerAmount, 0);

        _afterHook(job, jobId, selector, data);
    }

    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external override nonReentrant {
        Job storage job = _getJob(jobId);

        if (job.status == JobStatus.Open) {
            require(msg.sender == job.client, "Only client");
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            require(msg.sender == job.evaluator, "Only evaluator");
        } else {
            revert("Invalid reject status");
        }

        bytes4 selector = this.reject.selector;
        bytes memory data = abi.encode(reason, optParams);
        _beforeHook(job, jobId, selector, data);

        JobStatus priorStatus = job.status;
        uint256 refundAmount = job.budget;

        job.status = JobStatus.Rejected;
        job.reason = reason;

        emit JobRejected(jobId, msg.sender, reason);

        if (priorStatus == JobStatus.Funded || priorStatus == JobStatus.Submitted) {
            IERC20(paymentToken).safeTransfer(job.client, refundAmount);
            emit Refunded(jobId, job.client, refundAmount);
        }

        _afterHook(job, jobId, selector, data);
    }

    function claimRefund(uint256 jobId) external override nonReentrant {
        Job storage job = _getJob(jobId);
        require(
            job.status == JobStatus.Funded || job.status == JobStatus.Submitted,
            "Refund unavailable"
        );
        require(block.timestamp >= job.expiredAt, "Not expired");

        uint256 refundAmount = job.budget;
        job.status = JobStatus.Expired;

        IERC20(paymentToken).safeTransfer(job.client, refundAmount);

        emit Refunded(jobId, job.client, refundAmount);
        emit JobExpired(jobId, msg.sender);
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
            address hook,
            bytes32 deliverable,
            bytes32 reason
        )
    {
        Job storage job = _getJob(jobId);
        return (
            job.client,
            job.provider,
            job.evaluator,
            job.description,
            job.budget,
            job.expiredAt,
            uint8(job.status),
            job.hook,
            job.deliverable,
            job.reason
        );
    }

    function getJobCount() external view returns (uint256) {
        return jobs.length;
    }

    function _getJob(uint256 jobId) internal view returns (Job storage job) {
        require(jobId < jobs.length, "Invalid job");
        return jobs[jobId];
    }

    function _beforeHook(
        Job storage job,
        uint256 jobId,
        bytes4 selector,
        bytes memory data
    ) internal {
        if (job.hook != address(0)) {
            IACPHook(job.hook).beforeAction(jobId, selector, data);
        }
    }

    function _afterHook(
        Job storage job,
        uint256 jobId,
        bytes4 selector,
        bytes memory data
    ) internal {
        if (job.hook != address(0)) {
            IACPHook(job.hook).afterAction(jobId, selector, data);
        }
    }
}

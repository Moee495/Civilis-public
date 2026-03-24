// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IACPV2
/// @notice Originally drafted in Gate B to freeze the minimal ERC-8183
///         protocol surface for Civilis v2.
/// @dev The normative source is ERC-8183 Draft (created 2026-02-25, scanned
///      2026-03-21). This interface intentionally excludes repo-specific helper
///      paths such as `createJobFor(...)`.
///      This draft freezes the single-payment-token-per-contract model from
///      ERC-8183 `Job Data`; later gates should not silently switch to a
///      per-job token model without revisiting this interface. Current
///      implementations may choose to support the OPTIONAL hook model while
///      still honoring this surface.
interface IACPV2 {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );

    event ProviderSet(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider
    );

    event BudgetSet(
        uint256 indexed jobId,
        address indexed caller,
        uint256 amount
    );

    event JobFunded(
        uint256 indexed jobId,
        address indexed client,
        uint256 amount
    );

    event JobSubmitted(
        uint256 indexed jobId,
        address indexed provider,
        bytes32 deliverable
    );

    event JobCompleted(
        uint256 indexed jobId,
        address indexed evaluator,
        bytes32 reason
    );

    event JobRejected(
        uint256 indexed jobId,
        address indexed rejector,
        bytes32 reason
    );

    event PaymentReleased(
        uint256 indexed jobId,
        address indexed provider,
        uint256 providerAmount,
        uint256 feeAmount
    );

    event Refunded(
        uint256 indexed jobId,
        address indexed client,
        uint256 amount
    );

    event JobExpired(
        uint256 indexed jobId,
        address indexed caller
    );

    /// @notice Returns the ERC-20 token address used for escrow in this
    ///         contract-wide payment model.
    function paymentToken() external view returns (address token);

    /// @notice Creates an Open job.
    /// @dev `provider` may be zero; if so, the client must later call
    ///      `setProvider(...)` before funding. `hook` may be `address(0)` for
    ///      the no-hook path.
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    /// @notice Sets the provider for a previously unassigned Open job.
    /// @dev `optParams` is forwarded to the job hook when `hook != address(0)`.
    function setProvider(
        uint256 jobId,
        address provider,
        bytes calldata optParams
    ) external;

    /// @notice Sets the negotiated budget while the job is Open.
    /// @dev `optParams` is forwarded to the job hook when `hook != address(0)`.
    function setBudget(
        uint256 jobId,
        uint256 amount,
        bytes calldata optParams
    ) external;

    /// @notice Funds the job escrow using the current budget value.
    /// @dev `expectedBudget` is the front-running protection argument defined by
    ///      ERC-8183. `optParams` is forwarded to the job hook when
    ///      `hook != address(0)`.
    function fund(
        uint256 jobId,
        uint256 expectedBudget,
        bytes calldata optParams
    ) external;

    /// @notice Submits provider work for evaluation.
    /// @dev `deliverable` is a bytes32 reference such as a content hash or
    ///      attestation commitment. `optParams` is forwarded to the job hook
    ///      when `hook != address(0)`.
    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata optParams
    ) external;

    /// @notice Completes a Submitted job and releases escrow.
    /// @dev `reason` may be zero or an attestation hash. `optParams` is
    ///      forwarded to the job hook when `hook != address(0)`.
    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external;

    /// @notice Rejects an Open, Funded, or Submitted job under the role rules
    ///         defined by ERC-8183.
    /// @dev `optParams` is forwarded to the job hook when `hook != address(0)`.
    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external;

    /// @notice Claims a refund after expiry from Funded or Submitted.
    /// @dev ERC-8183 marks `claimRefund(...)` as non-hookable.
    function claimRefund(uint256 jobId) external;
}

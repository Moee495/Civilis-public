// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IACPV2ReadView
/// @notice Minimal read-only ACP surface needed by CivilisCommerceV2.
interface IACPV2ReadView {
    function getJobCount() external view returns (uint256);
}

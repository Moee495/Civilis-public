// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IACPHook {
    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external;

    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IACPHook.sol";

contract MockACPHook is IACPHook {
    event BeforeCalled(uint256 indexed jobId, bytes4 indexed selector, bytes data);
    event AfterCalled(uint256 indexed jobId, bytes4 indexed selector, bytes data);

    uint256 public beforeCount;
    uint256 public afterCount;
    uint256 public lastBeforeJobId;
    uint256 public lastAfterJobId;
    bytes4 public lastBeforeSelector;
    bytes4 public lastAfterSelector;
    bytes public lastBeforeData;
    bytes public lastAfterData;

    bool public revertAnyBefore;
    bool public revertAnyAfter;
    bytes4 public revertBeforeSelector;
    bytes4 public revertAfterSelector;

    function setRevertBefore(bytes4 selector, bool enabled) external {
        revertBeforeSelector = selector;
        revertAnyBefore = enabled;
    }

    function setRevertAfter(bytes4 selector, bool enabled) external {
        revertAfterSelector = selector;
        revertAnyAfter = enabled;
    }

    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external override {
        if (revertAnyBefore && (revertBeforeSelector == bytes4(0) || revertBeforeSelector == selector)) {
            revert("Hook before revert");
        }

        beforeCount += 1;
        lastBeforeJobId = jobId;
        lastBeforeSelector = selector;
        lastBeforeData = data;

        emit BeforeCalled(jobId, selector, data);
    }

    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external override {
        if (revertAnyAfter && (revertAfterSelector == bytes4(0) || revertAfterSelector == selector)) {
            revert("Hook after revert");
        }

        afterCount += 1;
        lastAfterJobId = jobId;
        lastAfterSelector = selector;
        lastAfterData = data;

        emit AfterCalled(jobId, selector, data);
    }
}

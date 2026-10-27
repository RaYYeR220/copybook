// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Claims a margin bank without being one of its registered perp pools.
contract FakePool {
    address public immutable marginBank;

    constructor(address bank_) {
        marginBank = bank_;
    }
}

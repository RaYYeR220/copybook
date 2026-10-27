// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMarginBank} from "../../src/interfaces/IDreamPerps.sol";

contract MockMarginBank is IMarginBank {
    mapping(address => mapping(address => Position)) internal _positions;
    mapping(address => int256) internal _equity;
    mapping(address => bool) public isPool;

    function registerPool(address pool) external {
        isPool[pool] = true;
    }

    function setEquity(address account, int256 equity) external {
        _equity[account] = equity;
    }

    function getPosition(address account, address pool) external view returns (Position memory) {
        return _positions[account][pool];
    }

    function getAccountHealth(address account) external view returns (int256, uint256, uint256, uint256) {
        return (_equity[account], 0, 0, 0);
    }

    /// @dev Called by a registered pool; the position is keyed to the calling pool.
    function applyFill(address account, int256 delta) external {
        require(isPool[msg.sender], "MockMarginBank: not pool");
        Position storage p = _positions[account][msg.sender];
        p.size = int128(int256(p.size) + delta);
        p.lastUpdatedTimestampNs = uint64(block.timestamp * 1e9);
        emit PositionUpdated(account, msg.sender, p.size, p.avgEntryPrice, 0, p.entryFundingIndex);
    }
}

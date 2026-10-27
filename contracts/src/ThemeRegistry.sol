// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Leg} from "./Types.sol";
import {IMarginBank} from "./interfaces/IDreamPerps.sol";

/// Creator-owned weight vectors over perp markets the margin bank registered. Followers mirror a theme;
/// subscribers watch ThemeRebalanced (indexed themeId) to resync. Every follower pays to re-check its
/// book on a rebalance, so a rebalance must change the legs and comes at most once per
/// MIN_REBALANCE_INTERVAL. Every leg weighs at least MIN_LEG_WEIGHT_BPS either way: a follower whose
/// allocation sizes the smallest leg below its venue minimum gets the whole set held back (the
/// basket opens all legs or none), so the app shows that minimum allocation before following.
contract ThemeRegistry {
    error NotCreator();
    error UnknownTheme();
    error NoLegs();
    error TooManyLegs();
    error ZeroWeight();
    error WeightTooSmall();
    error DuplicatePool();
    error GrossTooHigh();
    error ForeignPool();
    error NoChange();
    error RebalanceTooSoon();

    event ThemeCreated(uint256 indexed themeId, address indexed creator, string name);
    event ThemeRebalanced(uint256 indexed themeId, uint32 version);

    uint256 public constant MAX_LEGS = 8;
    uint256 public constant MAX_GROSS_BPS = 30_000;
    /// @dev Smallest |weightBps| of a leg, so a creator cannot shrink a leg to dust that followers can
    /// only ever reduce.
    uint256 public constant MIN_LEG_WEIGHT_BPS = 500;
    /// @dev Seconds between a theme's creation or rebalance and its next rebalance.
    uint256 public constant MIN_REBALANCE_INTERVAL = 60;
    bytes32 public constant THEME_REBALANCED_TOPIC = keccak256("ThemeRebalanced(uint256,uint32)");

    struct Theme {
        address creator;
        uint32 version;
        uint64 updatedAt; // creation or last rebalance
        string name;
        string uri;
        Leg[] legs;
    }

    address public immutable marginBank;
    uint256 public themeCount;
    mapping(uint256 => Theme) internal _themes;

    constructor(address marginBank_) {
        marginBank = marginBank_;
    }

    function createTheme(string calldata name, string calldata uri, Leg[] calldata legs)
        external
        returns (uint256 themeId)
    {
        _validate(legs);
        themeId = ++themeCount;
        Theme storage t = _themes[themeId];
        t.creator = msg.sender;
        t.version = 1;
        t.updatedAt = uint64(block.timestamp);
        t.name = name;
        t.uri = uri;
        _store(t, legs);
        emit ThemeCreated(themeId, msg.sender, name);
    }

    /// @notice Replaces the legs. Reverts NoChange when `legs` holds the same (pool, weight) pairs as now,
    /// in any order, and RebalanceTooSoon within MIN_REBALANCE_INTERVAL of the last change.
    function rebalance(uint256 themeId, Leg[] calldata legs) external {
        Theme storage t = _theme(themeId);
        if (t.creator != msg.sender) revert NotCreator();
        if (block.timestamp < t.updatedAt + MIN_REBALANCE_INTERVAL) revert RebalanceTooSoon();
        _validate(legs);
        if (_same(t.legs, legs)) revert NoChange();
        delete t.legs;
        _store(t, legs);
        t.updatedAt = uint64(block.timestamp);
        uint32 v = ++t.version;
        emit ThemeRebalanced(themeId, v);
    }

    function legsOf(uint256 themeId) external view returns (Leg[] memory) {
        return _theme(themeId).legs;
    }

    function versionOf(uint256 themeId) external view returns (uint32) {
        return _theme(themeId).version;
    }

    function themeOf(uint256 themeId)
        external
        view
        returns (address creator, string memory name, string memory uri, uint32 version)
    {
        Theme storage t = _theme(themeId);
        return (t.creator, t.name, t.uri, t.version);
    }

    function _theme(uint256 themeId) internal view returns (Theme storage t) {
        t = _themes[themeId];
        if (t.creator == address(0)) revert UnknownTheme();
    }

    /// @dev Pools are unique within a theme, so the same pairs in any order means the same length and every
    /// new pair present now.
    function _same(Leg[] storage cur, Leg[] calldata next) internal view returns (bool) {
        uint256 n = next.length;
        if (cur.length != n) return false;
        for (uint256 i; i < n; ++i) {
            bool found;
            for (uint256 j; j < n; ++j) {
                if (cur[j].pool == next[i].pool && cur[j].weightBps == next[i].weightBps) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    function _store(Theme storage t, Leg[] calldata legs) internal {
        for (uint256 i; i < legs.length; ++i) {
            t.legs.push(legs[i]);
        }
    }

    function _validate(Leg[] calldata legs) internal view {
        uint256 n = legs.length;
        if (n == 0) revert NoLegs();
        if (n > MAX_LEGS) revert TooManyLegs();
        uint256 gross;
        for (uint256 i; i < n; ++i) {
            int32 w = legs[i].weightBps;
            if (w == 0) revert ZeroWeight();
            int256 w256 = w;
            uint256 abs = uint256(w256 > 0 ? w256 : -w256);
            if (abs < MIN_LEG_WEIGHT_BPS) revert WeightTooSmall();
            gross += abs;
            address pool = legs[i].pool;
            for (uint256 j; j < i; ++j) {
                if (legs[j].pool == pool) revert DuplicatePool();
            }
            if (!IMarginBank(marginBank).isPerpPoolRegistered(pool)) revert ForeignPool();
        }
        if (gross > MAX_GROSS_BPS) revert GrossTooHigh();
    }
}

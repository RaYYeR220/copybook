// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Policy, SourceKind} from "./Types.sol";

library PolicyLib {
    error InvalidPolicy(uint8 field);

    uint256 internal constant BPS = 1e4;
    uint32 internal constant MAX_SCALE_BPS = 100_000;
    uint16 internal constant MAX_BAND_BPS = 500;
    uint16 internal constant MIN_EXIT_BAND_BPS = 100;

    // field ids: 1 scaleBps, 2 allocation, 3 maxNotional, 4 bandBps.
    // maxTotalNotional == 0 (no total cap) and equityFloor == 0 (stop off) are valid.
    function validate(Policy memory p, SourceKind kind) internal pure {
        if (kind == SourceKind.Trader) {
            if (p.scaleBps == 0 || p.scaleBps > MAX_SCALE_BPS) revert InvalidPolicy(1);
        } else {
            if (p.allocation == 0) revert InvalidPolicy(2);
        }
        if (p.maxNotional == 0) revert InvalidPolicy(3);
        if (p.bandBps == 0 || p.bandBps > MAX_BAND_BPS) revert InvalidPolicy(4);
    }

    // rounds toward zero
    function traderTarget(int256 sourceSize, uint32 scaleBps) internal pure returns (int256) {
        return sourceSize * int256(uint256(scaleBps)) / int256(BPS);
    }

    // magnitude rounded down, sign of weight kept
    function themeTarget(uint128 allocation, int32 weightBps, uint256 mark, uint256 oneBase)
        internal
        pure
        returns (int256)
    {
        if (weightBps == 0) return 0;
        bool neg = weightBps < 0;
        uint256 w = neg ? uint256(-int256(weightBps)) : uint256(int256(weightBps));
        uint256 qty = uint256(allocation) * w * oneBase / (BPS * mark);
        return neg ? -int256(qty) : int256(qty);
    }

    function clampNotional(int256 target, uint256 mark, uint256 oneBase, uint128 maxNotional)
        internal
        pure
        returns (int256 clamped, bool capped)
    {
        if (notional(target, mark, oneBase) <= maxNotional) return (target, false);
        uint256 qty = uint256(maxNotional) * oneBase / mark;
        return (target < 0 ? -int256(qty) : int256(qty), true);
    }

    function notional(int256 size, uint256 mark, uint256 oneBase) internal pure returns (uint256) {
        uint256 abs = size < 0 ? uint256(-size) : uint256(size);
        return abs * mark / oneBase;
    }

    // Rounds outward (reach), used for exits.
    // bid: ceil to tick of mark*(1+band); ask: floor to tick of mark*(1-band)
    function bandPrice(uint256 mark, uint16 bandBps, bool isBid, uint256 tick) internal pure returns (uint256) {
        if (isBid) {
            uint256 raw = mark * (BPS + bandBps) / BPS;
            if (mark * (BPS + bandBps) % BPS != 0) raw += 1;
            return (raw + tick - 1) / tick * tick;
        }
        return mark * (BPS - bandBps) / BPS / tick * tick;
    }

    // Rounds inward, used for increases: the limit never lies beyond mark*(1 +/- band).
    // bid: floor to tick of mark*(1+band); ask: ceil to tick of mark*(1-band)
    function bandPriceInward(uint256 mark, uint16 bandBps, bool isBid, uint256 tick) internal pure returns (uint256) {
        if (isBid) return mark * (BPS + bandBps) / BPS / tick * tick;
        uint256 raw = mark * (BPS - bandBps) / BPS;
        if (mark * (BPS - bandBps) % BPS != 0) raw += 1;
        return (raw + tick - 1) / tick * tick;
    }

    function exitBand(uint16 bandBps) internal pure returns (uint16) {
        uint256 b = uint256(bandBps) * 2;
        return b < MIN_EXIT_BAND_BPS ? MIN_EXIT_BAND_BPS : uint16(b);
    }

    function toLots(uint256 qty, uint256 lot) internal pure returns (uint256) {
        return qty / lot * lot;
    }

    // reduce shrinks |current| toward 0; a flip is a full reduce plus an increase on the other side
    function split(int256 current, int256 target)
        internal
        pure
        returns (uint256 reduceQty, bool reduceIsBid, uint256 increaseQty, bool increaseIsBid)
    {
        if (current >= 0) {
            reduceIsBid = false; // closing a long sells
            if (target >= current) {
                increaseQty = uint256(target - current);
                increaseIsBid = true;
            } else if (target >= 0) {
                reduceQty = uint256(current - target);
            } else {
                reduceQty = uint256(current);
                increaseQty = uint256(-target);
                increaseIsBid = false;
            }
        } else {
            reduceIsBid = true; // closing a short buys
            if (target <= current) {
                increaseQty = uint256(current - target);
                increaseIsBid = false;
            } else if (target <= 0) {
                reduceQty = uint256(target - current);
            } else {
                reduceQty = uint256(-current);
                increaseQty = uint256(target);
                increaseIsBid = true;
            }
        }
    }
}

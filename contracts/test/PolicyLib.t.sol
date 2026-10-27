// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {Policy, SourceKind} from "../src/Types.sol";

contract PolicyHarness {
    function validate(Policy memory p, SourceKind k) external pure {
        PolicyLib.validate(p, k);
    }
}

contract PolicyLibTest is Test {
    PolicyHarness h = new PolicyHarness();

    uint256 constant MARK = 80_000e18;
    uint256 constant ONE = 1e8;
    uint256 constant TICK = 1e17;

    function _ok() internal pure returns (Policy memory p) {
        p = Policy({
            scaleBps: 10_000, allocation: 20e18, maxNotional: 100e18, maxTotalNotional: 0, bandBps: 50, equityFloor: 0
        });
    }

    function _expectField(uint8 f) internal {
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.InvalidPolicy.selector, f));
    }

    function test_validate_accepts() public view {
        h.validate(_ok(), SourceKind.Trader);
        h.validate(_ok(), SourceKind.Theme);
        Policy memory p = _ok();
        p.scaleBps = 100_000;
        p.bandBps = 500;
        h.validate(p, SourceKind.Trader);
    }

    function test_validate_rejects() public {
        Policy memory p = _ok();
        p.scaleBps = 0;
        _expectField(1);
        h.validate(p, SourceKind.Trader);

        p = _ok();
        p.scaleBps = 100_001;
        _expectField(1);
        h.validate(p, SourceKind.Trader);

        p = _ok();
        p.allocation = 0;
        _expectField(2);
        h.validate(p, SourceKind.Theme);

        p = _ok();
        p.maxNotional = 0;
        _expectField(3);
        h.validate(p, SourceKind.Trader);

        p = _ok();
        p.bandBps = 0;
        _expectField(4);
        h.validate(p, SourceKind.Trader);

        p = _ok();
        p.bandBps = 501;
        _expectField(4);
        h.validate(p, SourceKind.Theme);
    }

    function test_validate_ignoresIrrelevantKindField() public view {
        Policy memory p = _ok();
        p.scaleBps = 0;
        h.validate(p, SourceKind.Theme);
        p = _ok();
        p.allocation = 0;
        h.validate(p, SourceKind.Trader);
    }

    function test_traderTarget() public pure {
        assertEq(PolicyLib.traderTarget(50_000, 10_000), 50_000);
        assertEq(PolicyLib.traderTarget(-120_000, 2_500), -30_000);
        assertEq(PolicyLib.traderTarget(7, 5_000), 3);
        assertEq(PolicyLib.traderTarget(-7, 5_000), -3);
    }

    function test_themeTarget() public pure {
        assertEq(PolicyLib.themeTarget(20e18, 5000, MARK, ONE), 12_500);
        assertEq(PolicyLib.themeTarget(20e18, -5000, MARK, ONE), -12_500);
        assertEq(PolicyLib.themeTarget(20e18, 0, MARK, ONE), 0);
        // magnitude rounds down for both signs
        assertEq(PolicyLib.themeTarget(1e18, 3333, MARK, ONE), 416);
        assertEq(PolicyLib.themeTarget(1e18, -3333, MARK, ONE), -416);
    }

    function test_clampNotional() public pure {
        (int256 c, bool capped) = PolicyLib.clampNotional(1e8, MARK, ONE, 100e18);
        assertEq(c, 125_000);
        assertTrue(capped);
        (c, capped) = PolicyLib.clampNotional(-1e8, MARK, ONE, 100e18);
        assertEq(c, -125_000);
        assertTrue(capped);
        (c, capped) = PolicyLib.clampNotional(100_000, MARK, ONE, 100e18);
        assertEq(c, 100_000);
        assertFalse(capped);
        (c, capped) = PolicyLib.clampNotional(125_000, MARK, ONE, 100e18);
        assertEq(c, 125_000);
        assertFalse(capped);
    }

    function test_notional() public pure {
        assertEq(PolicyLib.notional(1e8, MARK, ONE), MARK);
        assertEq(PolicyLib.notional(-1e8, MARK, ONE), MARK);
        assertEq(PolicyLib.notional(1, MARK, ONE), 80_000e10);
    }

    function test_bandPrice() public pure {
        assertEq(PolicyLib.bandPrice(MARK, 50, true, TICK), 80_400e18);
        assertEq(PolicyLib.bandPrice(MARK, 50, false, TICK), 79_600e18);
        // off-tick: 80_400.07035 ceils to 80_400.1; 79_600.06965 floors to 79_600.0
        uint256 m = 80_000_070_000_000_000_000_000;
        assertEq(PolicyLib.bandPrice(m, 50, true, TICK), 80_400_100_000_000_000_000_000);
        assertEq(PolicyLib.bandPrice(m, 50, false, TICK), 79_600e18);
    }

    function test_bandPriceInward() public pure {
        assertEq(PolicyLib.bandPriceInward(MARK, 50, true, TICK), 80_400e18);
        assertEq(PolicyLib.bandPriceInward(MARK, 50, false, TICK), 79_600e18);
        // off-tick: 80_400.07035 floors to 80_400.0; 79_600.06965 ceils to 79_600.1
        uint256 m = 80_000_070_000_000_000_000_000;
        uint256 bid = PolicyLib.bandPriceInward(m, 50, true, TICK);
        uint256 ask = PolicyLib.bandPriceInward(m, 50, false, TICK);
        assertEq(bid, 80_400e18);
        assertEq(ask, 79_600_100_000_000_000_000_000);
        // exact bounds, no rounding slack
        assertLe(bid * 1e4, m * (1e4 + 50));
        assertGe(ask * 1e4, m * (1e4 - 50));
    }

    function testFuzz_bandInwardNeverBeyond(uint256 mark, uint16 band, uint256 tick) public pure {
        mark = bound(mark, 1, 1e30);
        band = uint16(bound(band, 1, 500));
        tick = bound(tick, 1, 1e20);
        uint256 bid = PolicyLib.bandPriceInward(mark, band, true, tick);
        uint256 ask = PolicyLib.bandPriceInward(mark, band, false, tick);
        assertLe(bid * 1e4, mark * (1e4 + band));
        assertGe(ask * 1e4, mark * (1e4 - band));
        assertEq(bid % tick, 0);
        assertEq(ask % tick, 0);
        // and no more than one tick inside the exact edge
        assertGt((bid + tick) * 1e4, mark * (1e4 + band));
        assertLt((ask - tick) * 1e4, mark * (1e4 - band));
    }

    function test_exitBand() public pure {
        assertEq(PolicyLib.exitBand(10), 100);
        assertEq(PolicyLib.exitBand(50), 100);
        assertEq(PolicyLib.exitBand(51), 102);
        assertEq(PolicyLib.exitBand(500), 1000);
    }

    function test_toLots() public pure {
        assertEq(PolicyLib.toLots(12_345, 1_000), 12_000);
        assertEq(PolicyLib.toLots(999, 1_000), 0);
        assertEq(PolicyLib.toLots(5_000, 1_000), 5_000);
    }

    function _split(int256 c, int256 t) internal pure returns (uint256 rq, bool rb, uint256 iq, bool ib) {
        return PolicyLib.split(c, t);
    }

    function test_split() public pure {
        (uint256 rq, bool rb, uint256 iq, bool ib) = _split(0, 50);
        assertEq(rq, 0);
        assertEq(iq, 50);
        assertTrue(ib);

        (rq, rb, iq,) = _split(50, 0);
        assertEq(rq, 50);
        assertFalse(rb);
        assertEq(iq, 0);

        (rq, rb, iq,) = _split(50, 20);
        assertEq(rq, 30);
        assertFalse(rb);
        assertEq(iq, 0);

        (rq, rb, iq, ib) = _split(50, -20);
        assertEq(rq, 50);
        assertFalse(rb);
        assertEq(iq, 20);
        assertFalse(ib);

        (rq,, iq, ib) = _split(-30, -80);
        assertEq(rq, 0);
        assertEq(iq, 50);
        assertFalse(ib);

        (rq, rb, iq,) = _split(-30, 0);
        assertEq(rq, 30);
        assertTrue(rb);
        assertEq(iq, 0);
    }

    function test_split_extra() public pure {
        (uint256 rq, bool rb, uint256 iq, bool ib) = _split(-30, 20);
        assertEq(rq, 30);
        assertTrue(rb);
        assertEq(iq, 20);
        assertTrue(ib);

        (rq,, iq,) = _split(50, 80);
        assertEq(rq, 0);
        assertEq(iq, 30);

        (rq,, iq,) = _split(-30, -10);
        assertEq(rq, 20);
        assertEq(iq, 0);

        (rq,, iq,) = _split(0, 0);
        assertEq(rq, 0);
        assertEq(iq, 0);

        (rq,, iq, ib) = _split(0, -7);
        assertEq(rq, 0);
        assertEq(iq, 7);
        assertFalse(ib);
    }

    function testFuzz_bandNeverBeyond(uint256 mark, uint16 band) public pure {
        mark = bound(mark, TICK, 1e30);
        band = uint16(bound(band, 1, 500));
        uint256 bid = PolicyLib.bandPrice(mark, band, true, TICK);
        uint256 ask = PolicyLib.bandPrice(mark, band, false, TICK);
        assertLe(bid, mark * (1e4 + band) / 1e4 + TICK);
        assertGe(ask + TICK, mark * (1e4 - band) / 1e4);
        assertEq(bid % TICK, 0);
        assertEq(ask % TICK, 0);
    }
}

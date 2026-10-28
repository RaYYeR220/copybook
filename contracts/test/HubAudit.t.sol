// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Base} from "./Base.t.sol";
import {HeavyPerpPool} from "./mocks/HeavyPerpPool.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {MockReactivity} from "./mocks/MockReactivity.sol";
import {CopybookHub} from "../src/CopybookHub.sol";
import {CopyEngine} from "../src/CopyEngine.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {Leg, Policy, Reason, SourceKind} from "../src/Types.sol";
import {IMarginBank, IPerpPool, IRiskGate} from "../src/interfaces/IDreamPerps.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaEventHandler.sol";

/// A risk gate that spends every bit of gas it is given.
contract BurnGate is IRiskGate {
    function allowIncrease(bytes32, address) external view returns (bool) {
        uint256 x;
        while (gasleft() > 0) {
            x = uint256(keccak256(abi.encode(x)));
        }
        return x == 0;
    }
}

contract AllowGate is IRiskGate {
    function allowIncrease(bytes32, address) external pure returns (bool) {
        return true;
    }
}

/// Regressions for the task review and self-audit findings: each test failed (or proved the bug) before its fix.
contract HubAuditTest is Base {
    using stdStorage for StdStorage;

    StdStorage internal _store;

    bytes32 internal constant POSITION_UPDATED = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;
    bytes32 internal constant THEME_REBALANCED = keccak256("ThemeRebalanced(uint256,uint32)");
    uint256 internal constant HANDLER_GAS = 200_000_000;
    // BTC: mark 80_000e18, tick 1e17. Increase band 50 bps, exit band 100 bps.
    uint256 internal constant BTC_SELL = 79_600e18;
    uint256 internal constant BTC_EXIT_SELL = 79_200e18;

    CopybookHub internal hub;
    ThemeRegistry internal themes;
    MockPerpPool internal sol;
    address internal owner = address(0x0A11);
    address internal trader = address(0x7AD3);
    address internal creator = address(0xC4EA);
    address internal stranger = address(0x5EE);
    address internal follower = address(0xF011);
    bytes32 internal sid;

    function setUp() public override {
        super.setUp();
        sol = new MockPerpPool(bank, 150e18, 1e15, 1e17, 1e16, 1e18);
        bank.registerPool(address(sol));
        themes = new ThemeRegistry(address(bank));
        hub = new CopybookHub(IMarginBank(address(bank)), themes, 8, owner);
        vm.deal(address(hub), 40 ether);
        btc.approve(trader, address(this));
        eth.approve(trader, address(this));
        btc.setLiquidity(10_000_000, 10_000_000, 10);
        eth.setLiquidity(10e18, 10e18, 10);
        sol.setLiquidity(100e18, 100e18, 10);
        sid = hub.sourceIdOf(SourceKind.Trader, uint256(uint160(trader)));
    }

    // ------------------------------------------------------------------ helpers

    function _policy() internal pure returns (Policy memory) {
        return Policy({
            scaleBps: 10_000, allocation: 0, maxNotional: 100e18, maxTotalNotional: 0, bandBps: 50, equityFloor: 0
        });
    }

    function _themePolicy(uint128 allocation) internal pure returns (Policy memory p) {
        p = _policy();
        p.scaleBps = 0;
        p.allocation = allocation;
    }

    function _one(address a) internal pure returns (address[] memory p) {
        p = new address[](1);
        p[0] = a;
    }

    function _prep(address who) internal {
        vm.deal(who, 2 ether);
        btc.approve(who, address(hub));
        eth.approve(who, address(hub));
        sol.approve(who, address(hub));
    }

    function _followTrader(address who, address[] memory pools) internal {
        _prep(who);
        vm.prank(who);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), pools);
    }

    function _size(address pool, address account) internal view returns (int256) {
        return bank.getPosition(account, pool).size;
    }

    function _paused(address who) internal view returns (bool paused) {
        (,,,, paused,) = hub.followOf(who);
    }

    /// Moves `account` on a mock pool with a wide IOC placed by this test (an approved operator).
    function _move(MockPerpPool pool, address account, int256 target) internal {
        int256 d = target - _size(address(pool), account);
        if (d == 0) return;
        bool bid = d > 0;
        uint256 price = (bid ? pool.mark() * 11 / 10 : pool.mark() * 9 / 10) / pool.tick() * pool.tick();
        pool.placeOrderFor(account, bid, 0, price, uint256(bid ? d : -d), type(uint64).max, 2, 0, address(0), 0);
    }

    function _topics(address source, address pool) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](3);
        t[0] = POSITION_UPDATED;
        t[1] = bytes32(uint256(uint160(source)));
        t[2] = bytes32(uint256(uint160(pool)));
    }

    /// Delivers through `subId` with the handler's gas limit, as a subscription owned by `origin` would.
    function _deliver(uint256 subId, address emitter, bytes32[] memory topics, uint256 gas, address origin)
        internal
        returns (bool ok)
    {
        vm.prank(address(this), origin);
        (ok,) = REACTIVITY.call{gas: gas}(abi.encodeCall(MockReactivity.fire, (subId, emitter, topics, "")));
    }

    function _deliverHub(uint256 subId, address emitter, bytes32[] memory topics, uint256 gas) internal returns (bool) {
        return _deliver(subId, emitter, topics, gas, address(hub));
    }

    function _count(Vm.Log[] memory logs, bytes32 sig, address who) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(hub) && logs[i].topics[0] == sig
                    && logs[i].topics[1] == bytes32(uint256(uint160(who)))
            ) n++;
        }
    }

    function _heavy(uint256 burn) internal returns (HeavyPerpPool p) {
        p = new HeavyPerpPool(bank, 80_000e18, 1e17, 13_000, 1_000, 1e8);
        bank.registerPool(address(p));
        p.setLiquidity(100_000_000, 100_000_000, 10);
        p.setBurn(burn);
        p.approve(trader, address(this));
    }

    function _heavyTrade(HeavyPerpPool pool, bool isBid, uint256 qty) internal {
        pool.placeOrderFor(trader, isBid, 0, isBid ? 90_000e18 : 70_000e18, qty, type(uint64).max, 2, 0, address(0), 0);
    }

    function _setGate(address gate) internal {
        vm.prank(owner);
        hub.setRiskGate(gate);
    }

    /// A gate that was a contract when set and has no code now, as an account without code answers.
    function _codelessGate() internal returns (address g) {
        g = address(new AllowGate());
        _setGate(g);
        vm.etch(g, "");
    }

    // ================================================================== R29: the risk gate never rolls back exits

    /// A long follower whose source flipped short, with `gate` in place.
    function _flipWithGate(address gate) internal {
        _followTrader(follower, new address[](0));
        _move(btc, trader, 50_000);
        hub.catchUp(follower, _one(address(btc)));
        assertEq(_size(address(btc), follower), 50_000);
        _move(btc, trader, -50_000);
        if (gate != address(0)) _setGate(gate);
    }

    // Before: the burning gate ran the caller out of gas (OutOfGasInSync) and the flip's close rolled back.
    function test_burnGate_flipCloseCommits_catchUp() public {
        _flipWithGate(address(new BurnGate()));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 0, BTC_EXIT_SELL, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.RiskGate, "");
        hub.catchUp{gas: 30_000_000}(follower, _one(address(btc)));
        assertEq(_size(address(btc), follower), 0, "the close stands; the short waits for the gate");
    }

    // Before: Deferred, the close rolled back, and a full 20M slot billed every event.
    function test_burnGate_flipCloseCommits_reactive() public {
        _flipWithGate(address(new BurnGate()));
        vm.fee(6 gwei);
        uint256 t0 = hub.tankOf(follower);
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), 150_000_000));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_size(address(btc), follower), 0, "the close stands");
        assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 0);
        assertEq(_count(logs, CopybookHub.Refused.selector, follower), 1, "RiskGate on the increase");
        (,,,,, uint64 overhead,) = hub.gasParams();
        assertLt(t0 - hub.tankOf(follower), (4_000_000 + uint256(overhead)) * 6 gwei, "the gate's budget, not a slot");
    }

    // Before: the empty answer of an account without code failed to decode outside the catch: catchUp reverted.
    function test_codelessGate_flipCloseCommits() public {
        _flipWithGate(address(0));
        _codelessGate();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.RiskGate, "");
        hub.catchUp(follower, _one(address(btc)));
        assertEq(_size(address(btc), follower), 0);

        // and an account that never had code cannot be set at all
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(1)));
        hub.setRiskGate(address(0xBEEF));
    }

    /// A theme follower whose thesis drops ETH and adds SOL; returns the rebalance's subscription delivery.
    function _themeDropAndAdd() internal returns (bytes32 tsid, bytes32[] memory topics) {
        Leg[] memory legs = new Leg[](2);
        legs[0] = Leg(address(btc), 5_000);
        legs[1] = Leg(address(eth), -5_000);
        vm.prank(creator);
        uint256 tid = themes.createTheme("pair", "", legs);
        tsid = hub.sourceIdOf(SourceKind.Theme, tid);
        _prep(follower);
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Theme, tid, _themePolicy(100e18), new address[](0));
        assertTrue(_size(address(eth), follower) < 0);

        legs[1] = Leg(address(sol), 3_000);
        vm.warp(block.timestamp + themes.MIN_REBALANCE_INTERVAL());
        vm.prank(creator);
        themes.rebalance(tid, legs);
        topics = new bytes32[](2);
        topics[0] = THEME_REBALANCED;
        topics[1] = bytes32(tid);
    }

    function test_burnGate_themeDropCloseCommits() public {
        (bytes32 tsid, bytes32[] memory topics) = _themeDropAndAdd();
        _setGate(address(new BurnGate()));
        int256 b0 = _size(address(btc), follower);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.RiskGate, "");
        assertTrue(_deliverHub(hub.subscriptionOf(tsid, 0), address(themes), topics, HANDLER_GAS));
        assertEq(_size(address(eth), follower), 0, "the dropped leg is closed");
        assertEq(_size(address(sol), follower), 0, "the new leg waits for the gate");
        assertEq(_size(address(btc), follower), b0);
    }

    function test_codelessGate_themeDropCloseCommits() public {
        (bytes32 tsid, bytes32[] memory topics) = _themeDropAndAdd();
        _codelessGate();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.RiskGate, "");
        assertTrue(_deliverHub(hub.subscriptionOf(tsid, 0), address(themes), topics, HANDLER_GAS));
        assertEq(_size(address(eth), follower), 0);
        assertEq(_size(address(sol), follower), 0);
    }

    // ================================================================== R33: exits stand whatever the increases do

    /// Three Hideki-heavy markets (7.5M gas per order) the source and the follower hold long, with a floor.
    function _heavyStop() internal returns (HeavyPerpPool a, HeavyPerpPool b, HeavyPerpPool c) {
        a = _heavy(7_500_000);
        b = _heavy(7_500_000);
        c = _heavy(7_500_000);
        vm.deal(follower, 2 ether);
        a.approve(follower, address(hub));
        b.approve(follower, address(hub));
        c.approve(follower, address(hub));
        bank.setEquity(follower, 1_000e18);
        _heavyTrade(a, true, 50_000);
        _heavyTrade(b, true, 50_000);
        _heavyTrade(c, true, 50_000);
        address[] memory join = new address[](3);
        join[0] = address(a);
        join[1] = address(b);
        join[2] = address(c);
        Policy memory p = _policy();
        p.equityFloor = 100e18;
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), p, join);
        assertEq(_size(address(c), follower), 50_000);
        // equity falls below the floor, then the source flips market A long -> short
        bank.setEquity(follower, 50e18);
        _heavyTrade(a, false, 100_000);
    }

    // M-1. Before: the stop's flatten ran out of the 20M member slot, the whole member frame reverted (the flip's
    // close, the pause), the member was Deferred and billed ~0.118 STT, again on every event.
    function test_equityStopInHandler_pausesThenCloses() public {
        (HeavyPerpPool a, HeavyPerpPool b, HeavyPerpPool c) = _heavyStop();
        bytes32[] memory topics = _topics(trader, address(a));
        vm.fee(6 gwei);
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), topics, HANDLER_GAS));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Stopped.selector, follower), 1);
        assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 0);
        assertTrue(_paused(follower));
        assertEq(_size(address(a), follower), 0);
        assertEq(_size(address(b), follower), 0);
        assertEq(_size(address(c), follower), 0);

        // stopped: the next event changes nothing and costs little
        uint256 t0 = hub.tankOf(follower);
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), topics, HANDLER_GAS));
        (,,,,, uint64 overhead,) = hub.gasParams();
        assertLt(t0 - hub.tankOf(follower), (1_000_000 + uint256(overhead)) * 6 gwei);
    }

    // M-1, the closes themselves out of gas: the pause and the flip's close still stand, the closes are
    // Deferred and not billed, and a keeper's poke finishes them.
    function test_equityStopInHandler_pauseStandsWhenClosesRunOut() public {
        (HeavyPerpPool a, HeavyPerpPool b, HeavyPerpPool c) = _heavyStop();
        vm.fee(6 gwei);
        uint256 t0 = hub.tankOf(follower);
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(a)), 21_000_000));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Stopped.selector, follower), 1);
        assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 1);
        assertTrue(_paused(follower), "the pause stands");
        assertEq(_size(address(a), follower), 0, "the flip's close stands");
        assertEq(_size(address(b), follower), 50_000);
        assertEq(_size(address(c), follower), 50_000);
        (,,,,, uint64 overhead,) = hub.gasParams();
        assertLt(t0 - hub.tankOf(follower), (10_000_000 + uint256(overhead)) * 6 gwei, "the closes unbilled");

        vm.prank(stranger);
        hub.poke(follower);
        assertEq(_size(address(b), follower), 0);
        assertEq(_size(address(c), follower), 0);
    }

    /// An 8-leg basket on Hideki-heavy markets (6M gas per order), opened long; the creator flips it short.
    function _heavyFlip() internal returns (HeavyPerpPool[] memory ps, bytes32 tsid, bytes32[] memory topics) {
        ps = new HeavyPerpPool[](8);
        Leg[] memory legs = new Leg[](8);
        for (uint256 i; i < 8; ++i) {
            ps[i] = _heavy(6_000_000);
            legs[i] = Leg(address(ps[i]), 1_000);
        }
        vm.prank(creator);
        uint256 tid = themes.createTheme("basket", "", legs);
        tsid = hub.sourceIdOf(SourceKind.Theme, tid);
        vm.deal(follower, 2 ether);
        for (uint256 i; i < 8; ++i) {
            ps[i].approve(follower, address(hub));
        }
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Theme, tid, _themePolicy(400e18), new address[](0));
        for (uint256 i; i < 8; ++i) {
            assertEq(_size(address(ps[i]), follower), 50_000);
            legs[i].weightBps = -1_000;
        }
        vm.warp(block.timestamp + themes.MIN_REBALANCE_INTERVAL());
        vm.prank(creator);
        themes.rebalance(tid, legs);
        topics = new bytes32[](2);
        topics[0] = THEME_REBALANCED;
        topics[1] = bytes32(tid);
    }

    // M-2. Before: phase A and B shared one 90M slot; the 16 orders (~96M) ran it out, every reduction rolled
    // back, and the member was billed ~0.52 STT for nothing. Now the exits have their own call and the
    // increases theirs: the whole flip lands in one delivery.
    function test_themeFlipLargerThanSlot_completesInTwoPhases() public {
        (HeavyPerpPool[] memory ps, bytes32 tsid, bytes32[] memory topics) = _heavyFlip();
        assertTrue(_deliverHub(hub.subscriptionOf(tsid, 0), address(themes), topics, HANDLER_GAS));
        for (uint256 i; i < 8; ++i) {
            assertEq(_size(address(ps[i]), follower), -50_000, "flipped in one delivery");
        }
    }

    // M-2, increases larger than their slot: the member is Deferred for them (billed, as R15b), but every
    // reduction already stands, and catchUp opens the rest.
    function test_themeIncreasesOutOfSlot_reductionsStand() public {
        (HeavyPerpPool[] memory ps, bytes32 tsid, bytes32[] memory topics) = _heavyFlip();
        vm.prank(owner);
        hub.setGasParams(8_000_000, 20_000_000, 30_000_000, 1_200_000, 30_000, 300_000, 2_000_000);
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(tsid, 0), address(themes), topics, HANDLER_GAS));
        assertEq(_count(vm.getRecordedLogs(), CopybookHub.Deferred.selector, follower), 1);
        for (uint256 i; i < 8; ++i) {
            assertEq(_size(address(ps[i]), follower), 0, "every close stands");
        }
        vm.prank(stranger);
        hub.catchUp(follower, new address[](0));
        for (uint256 i; i < 8; ++i) {
            assertEq(_size(address(ps[i]), follower), -50_000);
        }
    }

    // M-1/M-2, exits heavier than the whole handler: Deferred and never billed (a source cannot drain tanks
    // with exits too heavy to finish).
    function test_exitsOutOfGas_deferredUnbilled() public {
        (,, bytes32[] memory topics) = _heavyFlip();
        bytes32 tsid = hub.sourceIdOf(SourceKind.Theme, uint256(topics[1]));
        vm.fee(6 gwei);
        uint256 t0 = hub.tankOf(follower);
        uint256 total0 = hub.totalTanks();
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(tsid, 0), address(themes), topics, 30_000_000));
        assertEq(_count(vm.getRecordedLogs(), CopybookHub.Deferred.selector, follower), 1);
        assertEq(hub.tankOf(follower), t0, "unbilled");
        assertEq(hub.totalTanks(), total0);
    }

    // The exits fit but the increases' floor does not: the close stands, the member and the rest wait for
    // catchUp under one GroupDeferred, unbilled.
    function test_entryFloorShort_exitsStand_groupDeferredUnbilled() public {
        HeavyPerpPool a = _heavy(7_500_000);
        vm.deal(follower, 2 ether);
        a.approve(follower, address(hub));
        _heavyTrade(a, true, 50_000);
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _one(address(a)));
        assertEq(_size(address(a), follower), 50_000);
        _heavyTrade(a, false, 100_000); // the source flips

        vm.fee(6 gwei);
        uint256 t0 = hub.tankOf(follower);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupDeferred(sid, 0, 0);
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(a)), 14_000_000));
        assertEq(_size(address(a), follower), 0, "the close stands");
        assertEq(hub.tankOf(follower), t0, "unbilled");

        hub.catchUp(follower, _one(address(a)));
        assertEq(_size(address(a), follower), -50_000);
    }

    // An increase half that reverts on its own (here a book answer that does not decode) is reported for that
    // member and billed; the exit half before it is unaffected.
    function test_entryRevert_isolatedAndReported() public {
        _followTrader(follower, new address[](0));
        _move(btc, trader, 50_000);
        vm.mockCall(address(btc), abi.encodeWithSignature("getOrderBookParameters()"), abi.encode(uint256(1)));
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.clearMockedCalls();
        assertEq(_count(logs, CopybookHub.Refused.selector, follower), 1);
        assertEq(_count(logs, CopybookHub.TankCharged.selector, follower), 1);
        assertEq(_size(address(btc), follower), 0);
    }

    // The stop's closes revert on their own (not out of gas): reported, and the pause written before them stands.
    function test_stopClosesRevert_pauseStands() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _move(btc, trader, 50_000);
        _move(eth, trader, -2e16);
        address[] memory both = new address[](2);
        both[0] = address(btc);
        both[1] = address(eth);
        _prep(follower);
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), p, both);
        assertEq(_size(address(eth), follower), -2e16);

        bank.setEquity(follower, 10e18);
        _move(btc, trader, 80_000); // an increase: the floor trips
        bytes memory down = abi.encodeWithSignature("Down()");
        vm.mockCallRevert(address(bank), abi.encodeCall(IMarginBank.getPosition, (follower, address(eth))), down);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.Stopped(follower, 10e18);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(0), Reason.VenueRejected, down);
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        vm.clearMockedCalls();
        assertTrue(_paused(follower), "the pause stands");
        assertEq(_size(address(btc), follower), 50_000, "the closes rolled back together");

        vm.prank(stranger);
        hub.poke(follower);
        assertEq(_size(address(btc), follower), 0);
        assertEq(_size(address(eth), follower), 0);
    }

    // ================================================================== R35: latches for work the handler cannot finish

    function _pending(address who) internal view returns (bool exitPending, bool flattenPending) {
        return hub.pendingOf(who);
    }

    function _groupDeferred(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].emitter == address(hub) && logs[j].topics[0] == CopybookHub.GroupDeferred.selector) n++;
        }
    }

    // N-1 (exits): a creator's rebalance whose exits cost more than the whole handler. Before: every round
    // burnt the handler budget on the same exits, unbilled, and GroupDeferred the co-member. Now the first
    // round latches the member; later rounds skip it with a bare Deferred, and catchUp on the caller's gas
    // finishes the exits and hands the follow back.
    function test_exitOOG_latchesThenSkips() public {
        HeavyPerpPool[] memory ps = new HeavyPerpPool[](8);
        Leg[] memory legs = new Leg[](8);
        for (uint256 i; i < 8; ++i) {
            ps[i] = _heavy(0);
            legs[i] = Leg(address(ps[i]), 1_000);
        }
        vm.prank(creator);
        uint256 tid = themes.createTheme("basket", "", legs);
        bytes32 tsid = hub.sourceIdOf(SourceKind.Theme, tid);
        address mate = address(0xF099);
        vm.deal(follower, 2 ether);
        vm.deal(mate, 2 ether);
        for (uint256 i; i < 8; ++i) {
            ps[i].approve(follower, address(hub));
            ps[i].approve(mate, address(hub));
        }
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Theme, tid, _themePolicy(400e18), new address[](0));
        vm.prank(mate);
        hub.follow{value: 1 ether}(SourceKind.Theme, tid, _themePolicy(400e18), new address[](0));
        for (uint256 i; i < 8; ++i) {
            ps[i].setBurn(26_000_000);
        }
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = THEME_REBALANCED;
        topics[1] = bytes32(tid);

        vm.fee(6 gwei);
        uint256 tank0 = hub.tankOf(follower);
        uint256 mateTank0 = hub.tankOf(mate);
        for (uint256 k; k < 4; ++k) {
            for (uint256 i; i < 8; ++i) {
                legs[i].weightBps = k % 2 == 0 ? int32(-1_000) : int32(-900);
            }
            vm.warp(block.timestamp + themes.MIN_REBALANCE_INTERVAL());
            vm.prank(creator);
            themes.rebalance(tid, legs);
            vm.recordLogs();
            uint256 g0 = gasleft();
            assertTrue(_deliverHub(hub.subscriptionOf(tsid, 0), address(themes), topics, HANDLER_GAS));
            uint256 used = g0 - gasleft();
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 1);
            if (k == 0) {
                assertEq(_groupDeferred(logs), 1, "the first round spends the budget once");
            } else if (k >= 2) {
                // both members' exits are latched by now: the handler only reads two latches
                assertEq(_count(logs, CopybookHub.Deferred.selector, mate), 1);
                assertEq(_groupDeferred(logs), 0, "no co-member deferral");
                assertLt(used, 1_000_000, "no budget burnt");
            }
        }
        (bool exitPending,) = _pending(follower);
        assertTrue(exitPending);
        for (uint256 i; i < 8; ++i) {
            assertEq(_size(address(ps[i]), follower), 50_000);
        }
        assertEq(hub.tankOf(follower), tank0, "never billed");
        assertEq(hub.tankOf(mate), mateTank0);

        // a keeper's catchUp does the exits (and the opens) on its own gas, then the handler takes the follow back
        // (orders at a Hideki-typical 6M here, so the test's own gas budget covers both catches)
        for (uint256 i; i < 8; ++i) {
            ps[i].setBurn(6_000_000);
        }
        vm.prank(stranger);
        hub.catchUp(follower, new address[](0));
        (exitPending,) = _pending(follower);
        assertFalse(exitPending);
        for (uint256 i; i < 8; ++i) {
            assertEq(_size(address(ps[i]), follower), -45_000);
        }
        // the follower's own resync works the same way
        vm.prank(mate);
        hub.resync();
        (exitPending,) = _pending(mate);
        assertFalse(exitPending);
        assertEq(_size(address(ps[0]), mate), -45_000);
    }

    /// A follower holding three Hideki-heavy markets, a source that adds to the first.
    function _stopCycleSetup() internal returns (HeavyPerpPool a, HeavyPerpPool b, HeavyPerpPool c, Policy memory p) {
        a = _heavy(0);
        b = _heavy(0);
        c = _heavy(0);
        vm.deal(follower, 2 ether);
        a.approve(follower, address(hub));
        b.approve(follower, address(hub));
        c.approve(follower, address(hub));
        bank.setEquity(follower, 1_000e18);
        _heavyTrade(a, true, 50_000);
        _heavyTrade(b, true, 50_000);
        _heavyTrade(c, true, 50_000);
        address[] memory join = new address[](3);
        join[0] = address(a);
        join[1] = address(b);
        join[2] = address(c);
        p = _policy();
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), p, join);
        assertEq(_size(address(c), follower), 50_000);
    }

    /// The source adds to `a`; every close then costs 70M (stand-in for ~21 heavy positions).
    function _addAndMakeHeavy(HeavyPerpPool a, HeavyPerpPool b, HeavyPerpPool c) internal {
        a.setBurn(0);
        _heavyTrade(a, true, 20_000);
        a.setBurn(70_000_000);
        b.setBurn(70_000_000);
        c.setBurn(70_000_000);
    }

    // N-1 (stop): before, a follower could re-arm its floor and resume after every stop whose closes ran out of
    // the handler, unbilled, so every source increase burnt the handler. Now the closes latch: resume waits,
    // the handler skips the follow, and poke finishes the closes on its caller's gas.
    function test_stopFlattenOOG_latchesResumeWaits() public {
        (HeavyPerpPool a, HeavyPerpPool b, HeavyPerpPool c, Policy memory p) = _stopCycleSetup();
        p.equityFloor = 2_000e18; // armed above its equity
        vm.prank(follower);
        hub.updatePolicy(p);
        _addAndMakeHeavy(a, b, c);
        vm.fee(6 gwei);
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(a)), HANDLER_GAS));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Stopped.selector, follower), 1);
        assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 1);
        assertTrue(_paused(follower));
        (bool exitPending, bool flattenPending) = _pending(follower);
        assertFalse(exitPending);
        assertTrue(flattenPending);

        // disarming the floor does not let it resume while the closes are owed
        p.equityFloor = 0;
        vm.prank(follower);
        hub.updatePolicy(p);
        vm.prank(follower);
        vm.expectRevert(CopybookHub.FlattenPending.selector);
        hub.resume();

        // the next source increase: skipped, no stop, no burn, no bill
        a.setBurn(0);
        _heavyTrade(a, true, 20_000);
        a.setBurn(70_000_000);
        uint256 t0 = hub.tankOf(follower);
        vm.recordLogs();
        uint256 g0 = gasleft();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(a)), HANDLER_GAS));
        assertLt(g0 - gasleft(), 1_000_000);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 1);
        assertEq(_count(logs, CopybookHub.Stopped.selector, follower), 0);
        assertEq(hub.tankOf(follower), t0);

        // poke finishes the closes on its caller's gas, whatever the floor says now; then resume works
        vm.prank(follower);
        hub.poke(follower);
        assertEq(_size(address(a), follower), 0);
        assertEq(_size(address(b), follower), 0);
        assertEq(_size(address(c), follower), 0);
        (exitPending, flattenPending) = _pending(follower);
        assertFalse(flattenPending);
        vm.prank(follower);
        hub.resume();
        assertFalse(_paused(follower));
    }

    // Latches clear only after the work is done in the caller's transaction: a catchUp that runs out of gas
    // reverts and leaves the latch; one that finishes clears it. Unfollowing ends the follow and its latches.
    function test_latches_clearOnlyAfterTheWork() public {
        address mate = address(0xF022);
        _followTrader(follower, _one(address(btc)));
        _followTrader(mate, _one(address(btc)));
        _move(btc, trader, 50_000);
        hub.catchUp(follower, _one(address(btc)));
        hub.catchUp(mate, _one(address(btc)));
        _move(btc, trader, 0);
        btc.setBombFor(follower, true); // its close burns all the gas it gets
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        assertEq(_count(vm.getRecordedLogs(), CopybookHub.Deferred.selector, follower), 1);
        (bool exitPending,) = _pending(follower);
        assertTrue(exitPending);

        // still bombed: the keeper's catchUp runs out of gas and reverts; the latch stands
        vm.expectRevert(CopybookHub.OutOfGasInSync.selector);
        hub.catchUp(follower, new address[](0));
        (exitPending,) = _pending(follower);
        assertTrue(exitPending);
        // an empty catchUp cannot clear it without the work: the synced markets are synced first
        btc.setBombFor(follower, false);
        hub.catchUp(follower, new address[](0));
        (exitPending,) = _pending(follower);
        assertFalse(exitPending);
        assertEq(_size(address(btc), follower), 0);

        // latched again, then unfollowing ends the follow and its latch
        _move(btc, trader, 50_000);
        hub.catchUp(follower, _one(address(btc)));
        _move(btc, trader, 0);
        btc.setBombFor(follower, true);
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        (exitPending,) = _pending(follower);
        assertTrue(exitPending);
        vm.prank(follower);
        hub.unfollow(false);
        (exitPending,) = _pending(follower);
        assertFalse(exitPending);
    }

    // R36: at the admin minimums (tailBase 1.1M, perDefer 20k) with a member left behind the one whose exits run
    // out of gas, the handler never reverts, at any gas from too little for one member to plenty.
    function test_reserveFloor_exitOOGAtAdminMinimums_handlerSurvives() public {
        address mate = address(0xF022);
        _followTrader(follower, _one(address(btc)));
        _followTrader(mate, _one(address(btc)));
        _move(btc, trader, 50_000);
        hub.catchUp(follower, _one(address(btc)));
        hub.catchUp(mate, _one(address(btc)));
        _move(btc, trader, 0);
        btc.setBombFor(follower, true);
        vm.prank(owner);
        hub.setGasParams(1_000_000, 1_000_000, 1_000_000, 1_100_000, 20_000, 20_000, 2_000_000);

        uint256 latched;
        uint256 mateDeferred;
        uint256 snap = vm.snapshotState();
        for (uint256 gas = 6_000_000; gas <= 8_500_000; gas += 25_000) {
            vm.recordLogs();
            assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), gas));
            Vm.Log[] memory logs = vm.getRecordedLogs();
            (bool exitPending,) = _pending(follower);
            if (exitPending) {
                ++latched;
                assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 1);
                if (_groupDeferred(logs) == 1) ++mateDeferred;
            }
            vm.revertToState(snap);
        }
        assertGt(latched, 0, "the exit ran out of gas and latched");
        assertGt(mateDeferred, 0, "with the member behind it deferred from the reserve");
    }

    // ================================================================== R37-R39: latches on an all-markets follow

    // Poc7c A. Before: an all-markets follow's exit on a market it never synced (a manual position) latched, and an
    // empty catchUp released it without the exit, so every event burnt the handler again and deferred the mate.
    // Now the event's market joins the synced set with the latch: the catchUp that releases it runs the close
    // first, and while that close cannot run the latch holds and the mate is copied.
    function test_allowAllUnsynced_latchHoldsUntilTheClose() public {
        address mate = address(0xF022);
        _followTrader(follower, new address[](0)); // all markets
        _followTrader(mate, _one(address(btc)));
        btc.approve(follower, address(this));
        _move(btc, follower, -20_000); // by hand: never synced
        assertEq(hub.syncedPools(follower).length, 0);
        btc.setBombFor(follower, true); // any btc order of the follower burns all it gets
        vm.fee(6 gwei);
        uint256 tank0 = hub.tankOf(follower);
        for (uint256 k; k < 3; ++k) {
            _move(btc, trader, int256(50_000 + k * 13_000));
            vm.recordLogs();
            uint256 g0 = gasleft();
            assertTrue(
                _deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS)
            );
            uint256 used = g0 - gasleft();
            Vm.Log[] memory logs = vm.getRecordedLogs();
            (bool ep,) = _pending(follower);
            assertTrue(ep, "latched");
            assertEq(_count(logs, CopybookHub.Deferred.selector, follower), 1);
            if (k == 0) {
                assertEq(_groupDeferred(logs), 1, "the first round spends the budget once");
                address[] memory synced = hub.syncedPools(follower);
                assertEq(synced.length, 1, "the event's market joined the synced set");
                assertEq(synced[0], address(btc));
            } else {
                assertEq(_groupDeferred(logs), 0, "the mate is not deferred");
                assertLt(used, 2_000_000, "no budget burnt");
            }
            // an empty catchUp must run that close before releasing: it still runs out of gas, so it reverts
            vm.prank(follower);
            vm.expectRevert(CopybookHub.OutOfGasInSync.selector);
            hub.catchUp{gas: 30_000_000}(follower, new address[](0));
            (ep,) = _pending(follower);
            assertTrue(ep, "still latched");
            assertEq(_size(address(btc), follower), -20_000);
        }
        assertEq(hub.tankOf(follower), tank0, "never billed");
        assertEq(_size(address(btc), mate), 76_000, "the mate is copied");

        // the venue recovers: the same empty catchUp closes, follows the source, then releases
        btc.setBombFor(follower, false);
        vm.prank(follower);
        hub.catchUp(follower, new address[](0));
        (bool pending,) = _pending(follower);
        assertFalse(pending);
        assertEq(_size(address(btc), follower), 76_000);
    }

    // Poc7c A2. Before: with the source flat, even a keeper naming the market released the latch without the
    // exit (the market was neither synced nor held by the source). Now the close runs first.
    function test_allowAllSourceFlat_catchUpClosesBeforeRelease() public {
        _move(btc, trader, 50_000);
        _followTrader(follower, new address[](0));
        btc.approve(follower, address(this));
        _move(btc, follower, -20_000);
        _move(btc, trader, 0);
        btc.setBombFor(follower, true);
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        (bool ep,) = _pending(follower);
        assertTrue(ep);
        btc.setBombFor(follower, false); // the close is cheap now
        vm.prank(stranger);
        hub.catchUp(follower, _one(address(btc)));
        (ep,) = _pending(follower);
        assertFalse(ep);
        assertEq(_size(address(btc), follower), 0, "the exit the latch stood for ran first");
    }

    // An exit that runs out of gas on an event for a market outside the follow's allowlist (on Somnia, cold keys
    // alone can do it) adds nothing to the synced set, so a later stop does not report the follower's own
    // position there as one it left open.
    function test_exitOOG_outsideAllowlist_staysUnsynced() public {
        Policy memory p = _policy();
        p.equityFloor = 100e18;
        bank.setEquity(follower, 1_000e18);
        _prep(follower);
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), p, _one(address(eth)));
        btc.approve(follower, address(this));
        _move(btc, follower, 20_000); // by hand, outside the follow
        _move(btc, trader, 50_000);

        vm.mockCallRevert(
            address(hub),
            abi.encodePacked(CopybookHub.exitFromEvent.selector),
            abi.encodeWithSelector(CopybookHub.OutOfGasInSync.selector)
        );
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        vm.clearMockedCalls();
        (bool ep,) = hub.pendingOf(follower);
        assertTrue(ep, "latched");
        address[] memory synced = hub.syncedPools(follower);
        assertEq(synced.length, 1);
        assertEq(synced[0], address(eth));

        bank.setEquity(follower, 50e18);
        vm.recordLogs();
        vm.prank(stranger);
        hub.poke(follower);
        assertEq(_count(vm.getRecordedLogs(), CopybookHub.FlattenIncomplete.selector, follower), 0);
        assertEq(_size(address(btc), follower), 20_000, "the follower's own position");
    }

    // Poc7c B (R38). Before: a stop's closes that left dust the venue cannot take kept flattenPending forever:
    // resume reverted for good and the handler skipped the follow for good. Now poke's completed pass releases
    // the follow and reports the residue.
    function test_flattenPendingDust_releasedAndReported() public {
        _followTrader(follower, _one(address(btc)));
        _move(btc, trader, 50_000);
        hub.catchUp(follower, _one(address(btc)));
        Policy memory p = _policy();
        p.equityFloor = 2_000e18;
        bank.setEquity(follower, 1_000e18);
        vm.prank(follower);
        hub.updatePolicy(p);

        // the stop's closes run out of gas in the handler
        btc.setBombFor(follower, true);
        _move(btc, trader, 63_000);
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        (, bool fp) = _pending(follower);
        assertTrue(fp);
        btc.setBombFor(follower, false);

        // poke's IOC close meets thin bids: 45_500 fills, 4_500 stays (below the 13_000 venue minimum)
        btc.setLiquidity(45_500, 10_000_000, 10);
        vm.expectEmit(true, true, false, true, address(hub));
        emit CopybookHub.FlattenIncomplete(follower, address(btc));
        vm.prank(stranger);
        hub.poke(follower);
        assertEq(_size(address(btc), follower), 4_500);
        bool ep;
        (ep, fp) = _pending(follower);
        assertFalse(fp, "released");
        assertFalse(ep);

        // equity back: resume works, and the handler takes the follow back
        btc.setLiquidity(10_000_000, 10_000_000, 10);
        bank.setEquity(follower, 5_000e18);
        vm.prank(follower);
        hub.resume();
        _move(btc, trader, 80_000);
        vm.recordLogs();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        assertEq(_count(vm.getRecordedLogs(), CopybookHub.Deferred.selector, follower), 0);
        assertGt(_size(address(btc), follower), 4_500);
    }

    // Poc7c A3, documented residual (R39). Unfollowing and following again starts a follow clean, so it could
    // re-arm a latched all-markets follow; but with the subscription gas limits at their minimum (40M for traders)
    // or default (200M), a single venue order at Hideki's heaviest (7.7M gas) always fits a member's exits, so
    // such an exit never latches. (Pools are venue-registered, R24, so no order is heavier.)
    function test_singleVenueOrderExit_neverLatches() public {
        HeavyPerpPool a = _heavy(0);
        address mate = address(0xF022);
        vm.deal(mate, 2 ether);
        a.approve(mate, address(hub));
        vm.prank(mate);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _one(address(a)));
        vm.deal(follower, 10 ether);
        a.approve(follower, address(hub));
        a.approve(follower, address(this));
        vm.prank(follower);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), new address[](0));
        // the follower's own short on A, by hand
        a.placeOrderFor(follower, false, 0, 70_000e18, 20_000, type(uint64).max, 2, 0, address(0), 0);
        assertEq(_size(address(a), follower), -20_000);

        uint256 snap = vm.snapshotState();
        uint256[2] memory budgets = [uint256(40_000_000), HANDLER_GAS];
        for (uint256 b; b < 2; ++b) {
            for (uint256 k; k < 3; ++k) {
                // the source flips every round, so the follower's exits close a position each time
                a.setBurn(0);
                _heavyTrade(a, k % 2 == 0, k == 0 ? 50_000 : 100_000);
                a.setBurn(7_700_000);
                assertTrue(
                    _deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(a)), budgets[b])
                );
                (bool ep, bool fp) = _pending(follower);
                assertFalse(ep, "a single order's exit never latches");
                assertFalse(fp);
                assertEq(_size(address(a), follower), k % 2 == 0 ? int256(50_000) : int256(-50_000));
                // and a refollow (what would re-arm a latch) changes nothing here
                vm.startPrank(follower);
                hub.unfollow(false);
                hub.follow{value: 0.2 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), new address[](0));
                vm.stopPrank();
            }
            vm.revertToState(snap);
        }
    }

    // ================================================================== R34: only the hub's own subscription

    // M-3. Before: a stranger's subscription on the hub's relay re-ran the group and billed every member.
    function test_foreignSubscription_cannotDriveRelay() public {
        _followTrader(follower, new address[](0));
        _move(btc, trader, 50_000);
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        assertEq(_size(address(btc), follower), 50_000);

        ISomniaReactivityPrecompile.SubscriptionData memory d;
        d.eventTopics[0] = POSITION_UPDATED;
        d.eventTopics[1] = bytes32(uint256(uint160(trader)));
        d.emitter = address(bank);
        d.handlerContractAddress = hub.relayOf(sid, 0);
        d.handlerFunctionSelector = ISomniaEventHandler.onEvent.selector;
        d.maxFeePerGas = 20 gwei;
        d.gasLimit = 10_000_000;
        vm.deal(stranger, 40 ether);
        vm.prank(stranger);
        uint256 foreign = ISomniaReactivityPrecompile(REACTIVITY).subscribe(d);

        vm.fee(6 gwei);
        uint256 tank0 = hub.tankOf(follower);
        uint256 total0 = hub.totalTanks();
        // Somnia runs the stranger's subscription with the stranger as the transaction origin
        assertFalse(_deliver(foreign, address(bank), _topics(trader, address(btc)), HANDLER_GAS, stranger));
        assertEq(hub.tankOf(follower), tank0, "not billed");
        assertEq(hub.totalTanks(), total0);

        vm.prank(hub.relayOf(sid, 0), stranger);
        vm.expectRevert(CopybookHub.NotOwnSubscription.selector);
        hub.onSourceEvent(sid, 0, address(bank), _topics(trader, address(btc)), "");
    }

    // ================================================================== L-1: allowAll scope for catchUp

    // Before: a stranger's catchUp closed a position the follower opened by hand in a market the source never
    // traded.
    function test_allowAll_catchUpLeavesUntradedMarkets() public {
        _followTrader(follower, new address[](0));
        eth.approve(follower, address(this));
        _move(eth, follower, 1e17);
        vm.recordLogs();
        vm.prank(stranger);
        hub.catchUp(follower, _one(address(eth)));
        assertEq(_size(address(eth), follower), 1e17, "the follower's own position");
        assertEq(vm.getRecordedLogs().length, 0);

        // once the source holds ETH, the market is the follow's
        _move(eth, trader, -2e16);
        vm.prank(stranger);
        hub.catchUp(follower, _one(address(eth)));
        assertEq(_size(address(eth), follower), -2e16);
        // and stays so after the source leaves it again
        _move(eth, trader, 0);
        vm.prank(stranger);
        hub.catchUp(follower, _one(address(eth)));
        assertEq(_size(address(eth), follower), 0);
    }

    // ================================================================== I-2: whole lots only

    // Before: the full close sent the exact non-lot size, the venue refused it (InvalidQuantity) and nothing
    // closed. Now the whole lots close and the residue below one lot stays as dust, with no refusal.
    function test_offLotPosition_closesWholeLots() public {
        _followTrader(follower, _one(address(btc)));
        btc.approve(follower, address(this));
        btc.setLiquidity(10_000_000, 25_500, 10);
        btc.placeOrderFor(follower, true, 0, 88_000e18, 30_000, type(uint64).max, 2, 0, address(0), 0);
        assertEq(_size(address(btc), follower), 25_500);
        btc.setLiquidity(10_000_000, 10_000_000, 10);

        vm.recordLogs();
        hub.catchUp(follower, _one(address(btc)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_size(address(btc), follower), 500, "a residue below one lot");
        assertEq(_count(logs, CopybookHub.Refused.selector, follower), 0);
        assertEq(_count(logs, CopybookHub.Copied.selector, follower), 1);

        // the dust is left alone from now on
        vm.recordLogs();
        hub.catchUp(follower, _one(address(btc)));
        assertEq(_count(vm.getRecordedLogs(), CopybookHub.Refused.selector, follower), 0);
    }

    // A theme's dropped leg left with dust counts as closed: the sync completes and records the version.
    function test_theme_droppedLegDust_settles() public {
        (bytes32 tsid, bytes32[] memory topics) = _themeDropAndAdd();
        // the ETH leg drifts by a part of a lot
        eth.approve(follower, address(this));
        eth.setLiquidity(10e18, 5e13, 10);
        eth.placeOrderFor(follower, true, 0, 2_500e18, 4e15, type(uint64).max, 2, 0, address(0), 0); // fills 5e13
        eth.setLiquidity(10e18, 10e18, 10);
        assertTrue(_deliverHub(hub.subscriptionOf(tsid, 0), address(themes), topics, HANDLER_GAS));
        assertEq(_size(address(eth), follower), -5e13, "dust under one lot left");
        (uint32 v, bool done) = hub.themeSyncOf(follower);
        assertEq(v, 2);
        assertTrue(done);
    }

    // ================================================================== increases never take exits with them

    // A venue answer that does not decode on the increase is reported; the flip's close stands.
    function test_undecodableIncreaseAnswer_closeStands() public {
        _flipWithGate(address(0));
        bytes memory increase = abi.encodeCall(
            IPerpPool.placeOrderFor,
            (follower, false, 0, BTC_SELL, uint256(50_000), uint64((block.timestamp + 60) * 1e9), 1, 0, address(0), 0)
        );
        vm.mockCall(address(btc), increase, abi.encode(true));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.VenueRejected, abi.encode(true));
        hub.catchUp(follower, _one(address(btc)));
        vm.clearMockedCalls();
        assertEq(_size(address(btc), follower), 0);
    }

    // ================================================================== R31 minors

    // M2: a new subscription id is never left marked as an orphan.
    function test_subscribe_clearsOrphanFlag() public {
        _followTrader(follower, new address[](0)); // subscription 1
        _store.target(address(hub)).sig("orphanSubs(uint256)").with_key(uint256(2)).checked_write(true);
        assertTrue(hub.orphanSubs(2));
        address other = address(0xF022);
        _prep(other);
        vm.prank(other);
        hub.follow{value: 1 ether}(SourceKind.Trader, uint256(uint160(address(0x7AD4))), _policy(), new address[](0));
        assertEq(hub.subscriptionOf(hub.sourceIdOf(SourceKind.Trader, uint256(uint160(address(0x7AD4)))), 0), 2);
        assertFalse(hub.orphanSubs(2));
        vm.prank(owner);
        vm.expectRevert(CopybookHub.NotOrphan.selector);
        hub.cancelOrphan(2);
    }

    // The library refuses direct calls (delegatecall only), so its storage-pointer functions are never run on
    // its own storage.
    function test_libraryDirectCallsRevert() public {
        address lib = deployCode("CopyEngine.sol:CopyEngine");
        CopyEngine.LegOrder[] memory orders = new CopyEngine.LegOrder[](0);
        (bool ok,) = lib.call(abi.encodeWithSelector(CopyEngine.applyIncreases.selector, bank, follower, orders));
        assertFalse(ok, "applyIncreases");
        CopyEngine.Env memory e = CopyEngine.Env(IMarginBank(address(bank)), follower, address(0), 1 ether, 2_000_000);
        (ok,) = lib.call(abi.encodeWithSelector(CopyEngine.joinPools.selector, uint256(11), e, _one(address(btc))));
        assertFalse(ok, "joinPools");
        (ok,) = lib.call(abi.encodeWithSelector(CopyEngine.flatten.selector, uint256(11), e));
        assertFalse(ok, "flatten");
    }

    // ================================================================== Info

    // I-1 (documented): the source's size is read once per delivery, so when an earlier member's copy fills
    // against the source's own resting order, later members still copy the size read for the event.
    function test_info_sourceSizeReadOncePerDelivery() public {
        HeavyPerpPool a = _heavy(0);
        address f2 = address(0xF022);
        vm.deal(follower, 1 ether);
        vm.deal(f2, 1 ether);
        a.approve(follower, address(hub));
        a.approve(f2, address(hub));
        vm.prank(follower);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), new address[](0));
        vm.prank(f2);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), new address[](0));
        _heavyTrade(a, true, 50_000);
        a.setCounterparty(trader); // from now on, fills match the source's own resting liquidity
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(a)), HANDLER_GAS));
        assertEq(_size(address(a), follower), 50_000);
        assertEq(_size(address(a), f2), 50_000);
        assertEq(_size(address(a), trader), -50_000);
    }

    // L-2 (measured): a delivery to a group with nothing to do bills at least the gas the handler used.
    function test_noOpGroup_billsAtLeastHandlerGas() public {
        address[] memory onlyEth = _one(address(eth));
        for (uint256 i = 1; i <= 8; ++i) {
            _followTrader(address(uint160(0xF100 + i)), onlyEth);
        }
        _move(btc, trader, 50_000);
        vm.fee(6 gwei);
        uint256 t0 = hub.totalTanks();
        uint256 g0 = gasleft();
        assertTrue(_deliverHub(hub.subscriptionOf(sid, 0), address(bank), _topics(trader, address(btc)), HANDLER_GAS));
        uint256 used = g0 - gasleft();
        uint256 billed = (t0 - hub.totalTanks()) / 6 gwei;
        assertGe(billed, used);
    }
}

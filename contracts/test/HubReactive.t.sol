// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Base} from "./Base.t.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {MockReactivity} from "./mocks/MockReactivity.sol";
import {CopybookHub} from "../src/CopybookHub.sol";
import {GroupRelay} from "../src/GroupRelay.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {Leg, Policy, Reason, SourceKind} from "../src/Types.sol";
import {IMarginBank, IPerpPool} from "../src/interfaces/IDreamPerps.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/SomniaEventHandler.sol";

/// Burns all the gas it is called with, as a call starved of gas would.
contract GasSink {
    fallback() external {
        assembly {
            invalid()
        }
    }
}

/// Spends nearly all the gas it is given, then reverts with data of its own.
contract GasBurner {
    error Halted();

    fallback() external {
        while (gasleft() > 100_000) {}
        revert Halted();
    }
}

contract HubReactiveTest is Base {
    using stdStorage for StdStorage;

    StdStorage internal _store;

    bytes32 internal constant POSITION_UPDATED = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;
    uint256 internal constant DEPTH_BTC = 10_000_000;
    uint256 internal constant DEPTH_ETH = 10e18;
    uint256 internal constant TANK = 0.5 ether;

    // BTC: mark 80_000e18, tick 1e17. Increase band 50 bps, exit band 100 bps.
    uint256 internal constant BTC_BUY = 80_400e18;
    uint256 internal constant BTC_EXIT_SELL = 79_200e18;

    CopybookHub internal hub;
    ThemeRegistry internal themes;

    address internal owner = address(0x0A11);
    address internal trader = address(0x7AD3);
    address internal stranger = address(0x5EE);

    bytes32 internal sid;

    function setUp() public override {
        super.setUp();
        themes = new ThemeRegistry(address(bank));
        hub = new CopybookHub(IMarginBank(address(bank)), themes, 8, owner);
        vm.deal(address(hub), 40 ether);
        btc.approve(trader, address(this));
        eth.approve(trader, address(this));
        btc.setLiquidity(DEPTH_BTC, DEPTH_BTC, 10);
        eth.setLiquidity(DEPTH_ETH, DEPTH_ETH, 10);
        sid = hub.sourceIdOf(SourceKind.Trader, uint256(uint160(trader)));
    }

    // ---------- helpers ----------

    /// The fixed gas added to every member's bill.
    function _overhead() internal view returns (uint256) {
        (,,,,, uint64 o,) = hub.gasParams();
        return o;
    }

    function _f(uint256 i) internal pure returns (address) {
        return address(uint160(0xF000 + i));
    }

    function _policy(uint32 scaleBps) internal pure returns (Policy memory) {
        return Policy({
            scaleBps: scaleBps, allocation: 0, maxNotional: 100e18, maxTotalNotional: 0, bandBps: 50, equityFloor: 0
        });
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _one(MockPerpPool a) internal pure returns (address[] memory p) {
        p = new address[](1);
        p[0] = address(a);
    }

    /// Funds `who` and approves the hub on both pools.
    function _prep(address who) internal {
        vm.deal(who, 1 ether);
        btc.approve(who, address(hub));
        eth.approve(who, address(hub));
    }

    function _join(address who, address source, Policy memory p, address[] memory pools) internal {
        vm.prank(who);
        hub.follow{value: TANK}(SourceKind.Trader, uint256(uint160(source)), p, pools);
    }

    /// Follows the trader on every market.
    function _follow(address who, uint32 scaleBps) internal {
        _prep(who);
        _join(who, trader, _policy(scaleBps), _none());
    }

    /// Moves `account` to `target` on `pool` with a wide IOC placed by this test (an approved operator).
    function _move(MockPerpPool pool, address account, int256 target) internal {
        int256 d = target - _size(pool, account);
        if (d == 0) return;
        bool bid = d > 0;
        uint256 price = (bid ? pool.mark() * 11 / 10 : pool.mark() * 9 / 10) / pool.tick() * pool.tick();
        pool.placeOrderFor(account, bid, 0, price, uint256(bid ? d : -d), type(uint64).max, 2, 0, address(0), 0);
    }

    /// Moves the trader and returns the MarginBank event a subscription would deliver.
    function _traderTo(MockPerpPool pool, int256 target) internal returns (Vm.Log memory ev) {
        vm.recordLogs();
        _move(pool, trader, target);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bank) && logs[i].topics[0] == POSITION_UPDATED) ev = logs[i];
        }
        require(ev.emitter == address(bank), "no PositionUpdated");
    }

    function _fire(uint32 group, Vm.Log memory ev) internal {
        uint256 id = hub.subscriptionOf(sid, group);
        vm.prank(address(this), address(hub)); // the hub's own subscription: the hub is the origin
        reactivity.fire(id, ev.emitter, ev.topics, ev.data);
    }

    function _size(MockPerpPool pool, address account) internal view returns (int256) {
        return bank.getPosition(account, address(pool)).size;
    }

    function _paused(address who) internal view returns (bool paused) {
        (,,,, paused,) = hub.followOf(who);
    }

    /// Hub logs of event `sig` whose first indexed topic is `who`.
    function _count(Vm.Log[] memory logs, bytes32 sig, address who) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(hub) && logs[i].topics[0] == sig
                    && logs[i].topics[1] == bytes32(uint256(uint160(who)))
            ) n++;
        }
    }

    /// GroupDeferred logs for this source's `group`, and the last one's first deferred index.
    function _groupDeferred(Vm.Log[] memory logs, uint32 group) internal view returns (uint256 n, uint256 from) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(hub) || logs[i].topics[0] != CopybookHub.GroupDeferred.selector
                    || logs[i].topics[1] != sid
            ) continue;
            (uint32 g, uint256 f) = abi.decode(logs[i].data, (uint32, uint256));
            if (g != group) continue;
            n++;
            from = f;
        }
    }

    function _charged(Vm.Log[] memory logs, address who) internal view returns (uint256 sum) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(hub) && logs[i].topics[0] == CopybookHub.TankCharged.selector
                    && logs[i].topics[1] == bytes32(uint256(uint160(who)))
            ) sum += abi.decode(logs[i].data, (uint256));
        }
    }

    /// Orders filled for `who` on any mock pool.
    function _fills(Vm.Log[] memory logs, address who) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != MockPerpPool.MockFill.selector) continue;
            (address o,,,) = abi.decode(logs[i].data, (address, bool, uint256, uint256));
            if (o == who) n++;
        }
    }

    function _setTank(address who, uint256 amount) internal {
        uint256 total = hub.totalTanks() - hub.tankOf(who) + amount;
        _store.target(address(hub)).sig("tankOf(address)").with_key(who).checked_write(amount);
        _store.target(address(hub)).sig("totalTanks()").checked_write(total);
    }

    /// A charge is (gas + overhead) * rate for some gas the handler could have spent on one follower.
    function _assertCharge(uint256 amount, uint256 rate) internal view {
        assertGt(amount, 0, "charged");
        assertEq(amount % rate, 0, "whole gas units at the rate");
        uint256 gasUnits = amount / rate;
        (, uint64 cap,,,,,) = hub.gasParams();
        assertGt(gasUnits, _overhead(), "overhead plus measured gas");
        assertLt(gasUnits, _overhead() + cap, "bounded by the slot");
    }

    // ---------- fan-out ----------

    function test_event_copiesToAllFollowersInGroup() public {
        address a = _f(1);
        address b = _f(2);
        address c = _f(3);
        _follow(a, 10_000);
        _follow(b, 5_000);
        _follow(c, 2_500);

        Vm.Log memory ev = _traderTo(btc, 80_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, sid, address(btc), 0, 80_000, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(b, sid, address(btc), 0, 40_000, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(c, sid, address(btc), 0, 20_000, BTC_BUY, false);
        _fire(0, ev);
        assertEq(_size(btc, a), 80_000);
        assertEq(_size(btc, b), 40_000);
        assertEq(_size(btc, c), 20_000);

        // the trader's exit is mirrored by the whole group
        ev = _traderTo(btc, 0);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(c, sid, address(btc), 20_000, 0, BTC_EXIT_SELL, false);
        _fire(0, ev);
        assertEq(_size(btc, a), 0);
        assertEq(_size(btc, b), 0);
        assertEq(_size(btc, c), 0);
    }

    function test_event_otherPool_ignoredIfNotAllowed() public {
        address a = _f(1); // follows BTC only
        address b = _f(2); // follows every market
        _prep(a);
        _join(a, trader, _policy(10_000), _one(btc));
        _follow(b, 10_000);
        // a's own ETH position, outside its follow
        eth.approve(a, address(this));
        _move(eth, a, 1e16);

        Vm.Log memory ev = _traderTo(eth, -2e16);
        vm.recordLogs();
        _fire(0, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Copied.selector, a), 0, "no copy");
        assertEq(_count(logs, CopybookHub.Refused.selector, a), 0, "no refusal");
        assertEq(_count(logs, CopybookHub.TankCharged.selector, a), 0, "no charge");
        assertEq(_fills(logs, a), 0, "no order");
        assertEq(_size(eth, a), 1e16);
        // the same event is copied by the follower who allows every market
        assertEq(_count(logs, CopybookHub.Copied.selector, b), 1);
        assertEq(_size(eth, b), -2e16);

        // the trader's exit does not touch a's own position either
        ev = _traderTo(eth, 0);
        vm.recordLogs();
        _fire(0, ev);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Copied.selector, a), 0);
        assertEq(_count(logs, CopybookHub.Refused.selector, a), 0);
        assertEq(_fills(logs, a), 0);
        assertEq(_size(eth, a), 1e16);
        assertEq(_size(eth, b), 0);
    }

    function test_event_fromWrongRelay_reverts() public {
        address otherTrader = address(0x7AD4);
        _follow(_f(1), 10_000);
        _prep(_f(2));
        _join(_f(2), otherTrader, _policy(10_000), _none());
        bytes32 otherSid = hub.sourceIdOf(SourceKind.Trader, uint256(uint160(otherTrader)));
        address relay = hub.relayOf(sid, 0);
        address otherRelay = hub.relayOf(otherSid, 0);
        assertTrue(otherRelay != address(0) && otherRelay != relay);

        Vm.Log memory ev = _traderTo(btc, 50_000);

        // another source's relay cannot speak for this source
        vm.prank(otherRelay);
        vm.expectRevert(CopybookHub.NotRelay.selector);
        hub.onSourceEvent(sid, 0, ev.emitter, ev.topics, ev.data);
        // a relay cannot speak for a group it does not serve
        vm.prank(relay);
        vm.expectRevert(CopybookHub.NotRelay.selector);
        hub.onSourceEvent(sid, 1, ev.emitter, ev.topics, ev.data);
        vm.prank(stranger);
        vm.expectRevert(CopybookHub.NotRelay.selector);
        hub.onSourceEvent(sid, 0, ev.emitter, ev.topics, ev.data);

        // this trader's event delivered through the other source's subscription is rejected
        uint256 otherSub = hub.subscriptionOf(otherSid, 0);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        vm.prank(address(this), address(hub));
        reactivity.fire(otherSub, ev.emitter, ev.topics, ev.data);

        assertEq(_size(btc, _f(1)), 0);
        assertEq(_size(btc, _f(2)), 0);
    }

    function test_relay_rejectsNonPrecompile() public {
        _follow(_f(1), 10_000);
        address relay = hub.relayOf(sid, 0);
        Vm.Log memory ev = _traderTo(btc, 50_000);

        address[3] memory callers = [stranger, trader, address(hub)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(SomniaEventHandler.OnlyReactivityPrecompile.selector);
            GroupRelay(relay).onEvent(ev.emitter, ev.topics, ev.data);
        }
        assertEq(_size(btc, _f(1)), 0);

        vm.prank(REACTIVITY, address(hub));
        GroupRelay(relay).onEvent(ev.emitter, ev.topics, ev.data);
        assertEq(_size(btc, _f(1)), 50_000);
    }

    function test_eventPhases_onlySelf() public {
        _follow(_f(1), 10_000);
        _traderTo(btc, 50_000);
        address relay = hub.relayOf(sid, 0);
        Leg[] memory none = new Leg[](0);

        address[2] memory callers = [stranger, relay];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i], address(hub));
            vm.expectRevert(CopybookHub.NotSelf.selector);
            hub.exitFromEvent(sid, _f(1), address(btc), 50_000, none, 0);
            vm.prank(callers[i], address(hub));
            vm.expectRevert(CopybookHub.NotSelf.selector);
            hub.entryFromEvent(sid, _f(1), address(btc), 50_000, none, 0);
            vm.prank(callers[i], address(hub));
            vm.expectRevert(CopybookHub.NotSelf.selector);
            hub.flattenFromEvent(sid, _f(1));
        }
        assertEq(_size(btc, _f(1)), 0);
    }

    // ---------- isolation ----------

    function test_oneFollowerRevertDoesNotBlockGroup() public {
        address a = _f(1);
        address b = _f(2);
        address c = _f(3);
        _follow(a, 10_000);
        _follow(b, 10_000);
        _follow(c, 10_000);
        bytes memory err = abi.encodeWithSignature("InsufficientCollateral()");
        btc.setRevertFor(b, err);

        Vm.Log memory ev = _traderTo(btc, 50_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, sid, address(btc), 0, 50_000, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(b, sid, address(btc), Reason.VenueRejected, err);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(c, sid, address(btc), 0, 50_000, BTC_BUY, false);
        _fire(0, ev);
        assertEq(_size(btc, a), 50_000);
        assertEq(_size(btc, b), 0);
        assertEq(_size(btc, c), 50_000);
    }

    // A revert the sync does not catch itself (here a failing position read) stays with that follower.
    function test_unexpectedRevert_isolatedPerFollower() public {
        address a = _f(1);
        address b = _f(2);
        address c = _f(3);
        _follow(a, 10_000);
        _follow(b, 10_000);
        _follow(c, 10_000);
        Vm.Log memory ev = _traderTo(btc, 50_000);
        bytes memory err = abi.encodeWithSignature("Halted()");
        vm.mockCallRevert(address(bank), abi.encodeCall(IMarginBank.getPosition, (b, address(btc))), err);

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, sid, address(btc), 0, 50_000, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(b, sid, address(btc), Reason.VenueRejected, err);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(c, sid, address(btc), 0, 50_000, BTC_BUY, false);
        _fire(0, ev);
        vm.clearMockedCalls();

        assertEq(_size(btc, a), 50_000);
        assertEq(_size(btc, b), 0);
        assertEq(_size(btc, c), 50_000);
        hub.catchUp(b, _one(btc));
        assertEq(_size(btc, b), 50_000);
    }

    // ---------- gas floor ----------

    function test_lowGasDefersRemainingFollowers() public {
        uint256 n = 4;
        for (uint256 i = 1; i <= n; ++i) {
            _follow(_f(i), 10_000);
        }
        Vm.Log memory ev = _traderTo(btc, 50_000);
        uint256 subId = hub.subscriptionOf(sid, 0);
        address[] memory m = hub.membersOf(sid, 0);
        (uint64 floor,,, uint64 tailBase, uint64 perDefer,,) = hub.gasParams();
        // what the handler must hold to start member #0: its slot, the reserve for deferring all n, and what a
        // trader member's exits keep back
        uint256 first = floor + tailBase + n * perDefer + hub.DEFER_ALLOWANCE_GAS() + hub.EXIT_MARK_GAS();

        // below the floor from the start: one GroupDeferred from index 0, nothing is sent
        vm.recordLogs();
        vm.prank(address(this), address(hub));
        reactivity.fire{gas: floor}(subId, ev.emitter, ev.topics, ev.data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 bails, uint256 from) = _groupDeferred(logs, 0);
        assertEq(bails, 1);
        assertEq(from, 0);
        for (uint256 i; i < n; ++i) {
            assertEq(_count(logs, CopybookHub.Deferred.selector, m[i]), 0);
            assertEq(_count(logs, CopybookHub.Copied.selector, m[i]), 0);
            assertEq(_size(btc, m[i]), 0);
            assertEq(hub.tankOf(m[i]), TANK);
        }

        // just above the floor: the first members are copied, the group is deferred from the next one
        vm.recordLogs();
        vm.prank(address(this), address(hub));
        reactivity.fire{gas: first * 105 / 100}(subId, ev.emitter, ev.topics, ev.data);
        logs = vm.getRecordedLogs();
        (bails, from) = _groupDeferred(logs, 0);
        assertEq(bails, 1);
        assertGt(from, 0);
        assertLt(from, n);
        for (uint256 i; i < n; ++i) {
            if (i < from) {
                assertEq(_count(logs, CopybookHub.Copied.selector, m[i]), 1);
                assertEq(_size(btc, m[i]), 50_000);
            } else {
                assertEq(_count(logs, CopybookHub.Copied.selector, m[i]), 0);
                assertEq(_size(btc, m[i]), 0);
                assertEq(hub.tankOf(m[i]), TANK, "a deferred follower is not charged");
            }
        }
        uint256 copied = from;

        // catchUp converges the deferred followers
        for (uint256 i = copied; i < n; ++i) {
            hub.catchUp(m[i], _one(btc));
        }
        for (uint256 i; i < n; ++i) {
            assertEq(_size(btc, m[i]), 50_000);
        }
    }

    // ---------- groups ----------

    function test_ninthFollower_opensSecondGroup() public {
        for (uint256 i = 1; i <= 8; ++i) {
            _follow(_f(i), 10_000);
        }
        assertEq(hub.groupCount(sid), 1);
        assertEq(hub.membersOf(sid, 0).length, 8);

        _prep(_f(9));
        address predicted = vm.computeCreateAddress(address(hub), vm.getNonce(address(hub)));
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupOpened(sid, 1, predicted, 2);
        _join(_f(9), trader, _policy(10_000), _none());

        assertEq(hub.groupCount(sid), 2);
        assertEq(hub.relayOf(sid, 1), predicted);
        assertEq(hub.subscriptionOf(sid, 1), 2);
        assertTrue(hub.subscribed(sid, 1));
        assertEq(GroupRelay(predicted).sourceId(), sid);
        assertEq(GroupRelay(predicted).group(), 1);
        (,,,,, uint32 g) = hub.followOf(_f(9));
        assertEq(g, 1);
        address[] memory m1 = hub.membersOf(sid, 1);
        assertEq(m1.length, 1);
        assertEq(m1[0], _f(9));
        (ISomniaReactivityPrecompile.SubscriptionData memory d, address subOwner) = reactivity.getSubscription(2);
        assertEq(subOwner, address(hub));
        assertEq(d.handlerContractAddress, predicted);
        assertEq(d.emitter, address(bank));
        assertEq(d.eventTopics[0], POSITION_UPDATED);
        assertEq(d.eventTopics[1], bytes32(uint256(uint160(trader))));

        // each subscription drives only its own group
        Vm.Log memory ev = _traderTo(btc, 50_000);
        _fire(0, ev);
        for (uint256 i = 1; i <= 8; ++i) {
            assertEq(_size(btc, _f(i)), 50_000);
        }
        assertEq(_size(btc, _f(9)), 0);
        _fire(1, ev);
        assertEq(_size(btc, _f(9)), 50_000);

        // a seat freed in group 0 is taken before group 1 grows
        vm.prank(_f(3));
        hub.unfollow(false);
        _follow(_f(10), 10_000);
        (,,,,, g) = hub.followOf(_f(10));
        assertEq(g, 0);
        assertEq(hub.membersOf(sid, 0).length, 8);
        assertEq(hub.groupCount(sid), 2);
        assertEq(reactivity.count(), 2);
    }

    function test_emptyGroupUnsubscribes() public {
        address a = _f(1);
        address b = _f(2);
        _follow(a, 10_000);
        _follow(b, 10_000);
        address relay = hub.relayOf(sid, 0);
        assertTrue(hub.subscribed(sid, 0));

        // a member remains: the subscription stays
        vm.recordLogs();
        vm.prank(a);
        hub.unfollow(false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CopybookHub.GroupClosed.selector);
            assertTrue(logs[i].topics[0] != ISomniaReactivityPrecompile.SubscriptionRemoved.selector);
        }
        assertTrue(hub.subscribed(sid, 0));
        (, address subOwner) = reactivity.getSubscription(1);
        assertEq(subOwner, address(hub));

        // the last member leaves: the subscription is cancelled, the relay kept
        vm.expectCall(REACTIVITY, abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (1)), 1);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupClosed(sid, 0, 1, true);
        vm.prank(b);
        hub.unfollow(false);

        assertFalse(hub.subscribed(sid, 0));
        assertEq(hub.relayOf(sid, 0), relay);
        assertEq(hub.groupCount(sid), 1);
        assertEq(hub.membersOf(sid, 0).length, 0);
        (, subOwner) = reactivity.getSubscription(1);
        assertEq(subOwner, address(0));

        Vm.Log memory ev = _traderTo(btc, 50_000);
        vm.expectRevert(MockReactivity.UnknownSubscription.selector);
        vm.prank(address(this), address(hub));
        reactivity.fire(1, ev.emitter, ev.topics, ev.data);
    }

    function test_reusedGroupResubscribes() public {
        address a = _f(1);
        address b = _f(2);
        _follow(a, 10_000);
        address relay = hub.relayOf(sid, 0);
        vm.prank(a);
        hub.unfollow(false);
        assertFalse(hub.subscribed(sid, 0));

        _prep(b);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupOpened(sid, 0, relay, 2);
        _join(b, trader, _policy(10_000), _none());

        assertTrue(hub.subscribed(sid, 0));
        assertEq(hub.relayOf(sid, 0), relay);
        assertEq(hub.subscriptionOf(sid, 0), 2);
        assertEq(hub.groupCount(sid), 1);
        (ISomniaReactivityPrecompile.SubscriptionData memory d, address subOwner) = reactivity.getSubscription(2);
        assertEq(subOwner, address(hub));
        assertEq(d.handlerContractAddress, relay);
        assertEq(d.eventTopics[1], bytes32(uint256(uint160(trader))));

        Vm.Log memory ev = _traderTo(btc, 50_000);
        _fire(0, ev);
        assertEq(_size(btc, b), 50_000);
    }

    // The precompile refusing the cancel never traps the last member in the follow.
    function test_unsubscribeFailure_doesNotBlockUnfollow() public {
        address a = _f(1);
        _follow(a, 10_000);
        vm.mockCallRevert(
            REACTIVITY, abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (1)), abi.encodeWithSignature("Busy()")
        );

        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupClosed(sid, 0, 1, false);
        vm.prank(a);
        hub.unfollow(false);
        vm.clearMockedCalls();

        (bytes32 s,,,,,) = hub.followOf(a);
        assertEq(s, bytes32(0));
        assertFalse(hub.subscribed(sid, 0));
    }

    // The cancel gets a fixed budget; one that burns all of it is reported, not fatal.
    function test_unsubscribeBurningItsBudget_isBestEffort() public {
        address a = _f(1);
        _follow(a, 10_000);
        vm.etch(REACTIVITY, address(new GasSink()).code);

        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupClosed(sid, 0, 1, false);
        vm.prank(a);
        hub.unfollow(false);
        (bytes32 s,,,,,) = hub.followOf(a);
        assertEq(s, bytes32(0));
    }

    // An unfollow that cannot fund the cancel's budget reverts, so a tight gas estimate cannot leak the
    // subscription; with the budget covered the cancel goes through.
    function test_unsubscribeNeedsItsBudgetUpFront() public {
        address a = _f(1);
        _follow(a, 10_000);
        uint256 budget = hub.UNSUB_GAS();
        assertEq(budget, 2_000_000);

        vm.prank(a);
        vm.expectRevert(CopybookHub.UnsubscribeOutOfGas.selector);
        hub.unfollow{gas: budget}(false);
        (bytes32 s,,,,,) = hub.followOf(a);
        assertEq(s, sid);

        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupClosed(sid, 0, 1, true);
        vm.prank(a);
        hub.unfollow{gas: budget * 64 / 63 + 1_150_000}(false);
        assertFalse(hub.subscribed(sid, 0));
    }

    // ---------- dropped subscriptions ----------

    function test_ensureSubscribed_resubscribesDroppedGroup() public {
        address a = _f(1);
        _follow(a, 10_000);
        address relay = hub.relayOf(sid, 0);
        reactivity.forceRemove(1); // the chain dropped it while the group still has a member

        // whatever is left of the old one is cancelled first (best effort), then the relay subscribes again
        vm.expectCall(REACTIVITY, abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (1)), 1);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupOpened(sid, 0, relay, 2);
        vm.prank(stranger);
        hub.ensureSubscribed(sid, 0);
        assertEq(hub.subscriptionOf(sid, 0), 2);
        assertTrue(hub.subscribed(sid, 0));
        (ISomniaReactivityPrecompile.SubscriptionData memory d, address subOwner) = reactivity.getSubscription(2);
        assertEq(subOwner, address(hub));
        assertEq(d.handlerContractAddress, relay);
        assertEq(d.eventTopics[1], bytes32(uint256(uint160(trader))));

        _fire(0, _traderTo(btc, 50_000));
        assertEq(_size(btc, a), 50_000);

        // the new subscription is live and hub-owned: calling again changes nothing
        vm.prank(stranger);
        hub.ensureSubscribed(sid, 0);
        assertEq(hub.subscriptionOf(sid, 0), 2);
        assertEq(reactivity.count(), 2);
    }

    // Regression (review B): an unreadable answer for a live subscription must not let anyone mint
    // duplicate hub-owned subscriptions on the same relay.
    function test_ensureSubscribed_unreadableInfo_failsClosed() public {
        address a = _f(1);
        _follow(a, 10_000);
        bytes4 unreadable = bytes4(keccak256("SubscriptionUnreadable()"));
        bytes memory ensure = abi.encodeCall(CopybookHub.ensureSubscribed, (sid, 0));

        vm.mockCallRevert(
            REACTIVITY, abi.encodeWithSelector(ISomniaReactivityPrecompile.getSubscriptionInfo.selector), bytes("")
        );
        for (uint256 k; k < 5; ++k) {
            vm.prank(stranger);
            (bool ok, bytes memory ret) = address(hub).call(ensure);
            assertFalse(ok, "a failed read reverts");
            assertEq(bytes4(ret), unreadable);
        }
        vm.clearMockedCalls();

        // an answer too short to hold the owner fails closed too
        vm.mockCall(
            REACTIVITY,
            abi.encodeWithSelector(ISomniaReactivityPrecompile.getSubscriptionInfo.selector),
            abi.encode(address(hub))
        );
        (bool ok2, bytes memory ret2) = address(hub).call(ensure);
        vm.clearMockedCalls();
        assertFalse(ok2, "a short read reverts");
        assertEq(bytes4(ret2), unreadable);

        assertEq(reactivity.count(), 1, "no duplicate subscription");
        assertEq(hub.subscriptionOf(sid, 0), 1);
        _fire(0, _traderTo(btc, 50_000));
        assertEq(_size(btc, a), 50_000);
    }

    function test_ensureSubscribed_leavesLiveAndEmptyGroupsAlone() public {
        address a = _f(1);
        _follow(a, 10_000);

        vm.recordLogs();
        hub.ensureSubscribed(sid, 0); // live
        hub.ensureSubscribed(sid, 1); // never opened
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(reactivity.count(), 1);

        vm.prank(a);
        hub.unfollow(false);
        reactivity.forceRemove(1);
        vm.recordLogs();
        hub.ensureSubscribed(sid, 0); // closed and empty: nothing to keep alive
        assertEq(vm.getRecordedLogs().length, 0);
        assertFalse(hub.subscribed(sid, 0));
    }

    // ---------- gas parameters ----------

    function test_gasParams_defaults() public view {
        (uint64 floor, uint64 cap, uint64 themeCap, uint64 tailBase, uint64 perDefer,,) = hub.gasParams();
        assertEq(floor, 8_000_000);
        assertEq(cap, 20_000_000);
        assertEq(themeCap, 90_000_000);
        assertEq(tailBase, 1_200_000);
        assertEq(perDefer, 30_000);
        (,, uint64 traderGas, uint64 themeGas,) = hub.subParams();
        assertEq(traderGas, 200_000_000);
        assertEq(themeGas, 200_000_000);
    }

    // An order that runs out of gas outside the reactive path reverts the call instead of being reported
    // as a venue answer, so a gas estimate always covers the order.
    function test_outOfGasOrder_revertsCatchUp() public {
        address a = _f(1);
        _follow(a, 10_000);
        _traderTo(btc, 50_000);
        btc.setBombFor(a, true);
        vm.expectRevert(CopybookHub.OutOfGasInSync.selector);
        hub.catchUp(a, _one(btc));

        btc.setBombFor(a, false);
        hub.catchUp(a, _one(btc));
        assertEq(_size(btc, a), 50_000);
    }

    // A member that spends almost all of a short slot and then reverts on its own leaves too little above
    // the next reserve to touch its tank (a cold or missing key on Somnia): it is refused, but not billed.
    function test_tailCharge_skippedWithoutColdKeyHeadroom() public {
        address b = _f(1);
        _follow(b, 10_000);
        Vm.Log memory ev = _traderTo(btc, 50_000);
        bytes memory halted = abi.encodeWithSelector(GasBurner.Halted.selector);
        // the increase reads the market: that read spends its slot (the exits before it read nothing)
        vm.mockFunction(address(btc), address(new GasBurner()), abi.encodeCall(IPerpPool.getMarkPrice, ()));
        uint256 subId = hub.subscriptionOf(sid, 0);

        // with gas to spare the refusal is billed as usual
        vm.recordLogs();
        vm.prank(address(this), address(hub));
        reactivity.fire(subId, ev.emitter, ev.topics, ev.data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Refused.selector, b), 1);
        assertEq(_count(logs, CopybookHub.TankCharged.selector, b), 1);

        // in a slot cut to the handler's budget there is no headroom left: no charge, no event
        uint256 tank = hub.tankOf(b);
        uint256 total = hub.totalTanks();
        (uint64 floor,,, uint64 tailBase, uint64 perDefer,,) = hub.gasParams();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(b, sid, address(btc), Reason.VenueRejected, halted);
        vm.recordLogs();
        uint256 hold = hub.DEFER_ALLOWANCE_GAS() + hub.EXIT_MARK_GAS();
        vm.prank(address(this), address(hub));
        reactivity.fire{gas: (floor + tailBase + perDefer + hold) * 11 / 10}(subId, ev.emitter, ev.topics, ev.data);
        logs = vm.getRecordedLogs();
        vm.clearMockedCalls();
        assertEq(_count(logs, CopybookHub.TankCharged.selector, b), 0);
        assertEq(hub.tankOf(b), tank);
        assertEq(hub.totalTanks(), total);
    }

    // Out of gas in the sync's own code (here a position read), not inside a venue call: still a deferral.
    function test_outOfGasOutsideVenueCall_isDeferred() public {
        address a = _f(1);
        address b = _f(2);
        address c = _f(3);
        _follow(a, 10_000);
        _follow(b, 10_000);
        _follow(c, 10_000);
        Vm.Log memory ev = _traderTo(btc, 50_000);
        vm.mockFunction(
            address(bank), address(new GasSink()), abi.encodeCall(IMarginBank.getPosition, (b, address(btc)))
        );

        vm.recordLogs();
        _fire(0, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.clearMockedCalls();
        assertEq(_count(logs, CopybookHub.Deferred.selector, b), 1);
        assertEq(_count(logs, CopybookHub.Refused.selector, b), 0);
        assertEq(_size(btc, a), 50_000);
        assertEq(_size(btc, c), 50_000);
    }

    // ---------- tank ----------

    function test_tankCharged_perFollower() public {
        address a = _f(1);
        address b = _f(2);
        address c = _f(3); // follows ETH only
        _follow(a, 10_000);
        _follow(b, 5_000);
        _prep(c);
        _join(c, trader, _policy(10_000), _one(eth));
        uint256 hubBalance = address(hub).balance;
        uint256 total = hub.totalTanks();
        assertEq(total, 3 * TANK);

        // basefee above the 6 gwei minimum: charged at basefee
        vm.fee(10 gwei);
        Vm.Log memory ev = _traderTo(btc, 50_000);
        vm.recordLogs();
        _fire(0, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 ca = _charged(logs, a);
        uint256 cb = _charged(logs, b);
        _assertCharge(ca, 10 gwei);
        _assertCharge(cb, 10 gwei);
        uint256 overhead = _overhead();
        assertEq(hub.tankOf(a), TANK - ca);
        assertEq(hub.tankOf(b), TANK - cb);
        // outside c's markets: only the fixed overhead, without an event
        assertEq(_count(logs, CopybookHub.TankCharged.selector, c), 0);
        assertEq(hub.tankOf(c), TANK - overhead * 10 gwei);
        assertEq(hub.totalTanks(), total - ca - cb - overhead * 10 gwei);
        assertEq(address(hub).balance, hubBalance, "charges stay in the hub");

        // basefee below the minimum: charged at 6 gwei
        vm.fee(1 gwei);
        total = hub.totalTanks();
        ev = _traderTo(btc, 0);
        vm.recordLogs();
        _fire(0, ev);
        logs = vm.getRecordedLogs();
        ca = _charged(logs, a);
        cb = _charged(logs, b);
        _assertCharge(ca, 6 gwei);
        _assertCharge(cb, 6 gwei);
        assertEq(hub.totalTanks(), total - ca - cb - overhead * 6 gwei);

        // already at target: nothing to do, so only the overhead, silently
        uint256 ta = hub.tankOf(a);
        uint256 tb = hub.tankOf(b);
        vm.recordLogs();
        _fire(0, ev);
        logs = vm.getRecordedLogs();
        assertEq(
            _count(logs, CopybookHub.TankCharged.selector, a) + _count(logs, CopybookHub.TankCharged.selector, b), 0
        );
        assertEq(hub.tankOf(a), ta - overhead * 6 gwei);
        assertEq(hub.tankOf(b), tb - overhead * 6 gwei);

        // the charge saturates at what is left in the tank
        _setTank(a, 1);
        total = hub.totalTanks();
        ev = _traderTo(btc, 50_000);
        vm.recordLogs();
        _fire(0, ev);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.TankCharged.selector, a), 1);
        assertEq(_charged(logs, a), 1);
        assertEq(hub.tankOf(a), 0);
        assertEq(hub.totalTanks(), total - 1 - _charged(logs, b) - overhead * 6 gwei);

        // an empty tank cannot go below zero
        _fire(0, ev);
        assertEq(hub.tankOf(a), 0);

        // catchUp is paid by its caller, not the tank
        tb = hub.tankOf(b);
        _traderTo(btc, 80_000);
        hub.catchUp(b, _one(btc));
        assertEq(_size(btc, b), 40_000);
        assertEq(hub.tankOf(b), tb);
    }

    function test_withdrawTank_keepsFloorWhileFollowing() public {
        address a = _f(1);
        _follow(a, 10_000);
        uint256 floor = hub.MIN_TANK();

        vm.prank(a);
        vm.expectRevert(CopybookHub.TankFloor.selector);
        hub.withdrawTank(TANK - floor + 1);

        uint256 before = a.balance;
        vm.prank(a);
        hub.withdrawTank(TANK - floor);
        assertEq(hub.tankOf(a), floor);
        assertEq(a.balance, before + TANK - floor);

        // charged below the floor: nothing more comes out while following
        _setTank(a, floor - 1);
        vm.prank(a);
        vm.expectRevert(CopybookHub.TankFloor.selector);
        hub.withdrawTank(1);

        // after unfollowing the whole tank comes out
        vm.prank(a);
        hub.unfollow(false);
        vm.prank(a);
        hub.withdrawTank(floor - 1);
        assertEq(hub.tankOf(a), 0);
        assertEq(hub.totalTanks(), 0);
    }

    // ---------- cheap pre-checks ----------

    // An increase-only sync that a gate already refuses is reported without reading the market.
    function test_increaseOnly_refusedBeforeMarketReads() public {
        address a = _f(1); // tank below the increase minimum
        address b = _f(2); // paused
        _follow(a, 10_000);
        _setTank(a, hub.MIN_TANK_FOR_INCREASE() - 1);
        Policy memory p = _policy(10_000);
        p.equityFloor = 50e18;
        bank.setEquity(b, 100e18);
        _prep(b);
        _join(b, trader, p, _none());
        bank.setEquity(b, 10e18);
        hub.poke(b);
        assertTrue(_paused(b));
        bank.setEquity(b, 100e18);

        Vm.Log memory ev = _traderTo(btc, 50_000);
        uint256 subId = hub.subscriptionOf(sid, 0);
        vm.expectCall(address(btc), abi.encodeCall(IPerpPool.getMarkPrice, ()), 0);
        vm.expectCall(address(btc), abi.encodeCall(IPerpPool.getOrderBookParameters, ()), 0);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(a, sid, address(btc), Reason.TankEmpty, "");
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(b, sid, address(btc), Reason.Paused, "");
        vm.prank(address(this), address(hub));
        reactivity.fire(subId, ev.emitter, ev.topics, ev.data);
        assertEq(_size(btc, a), 0);
        assertEq(_size(btc, b), 0);
    }

    // With an equity floor armed, an empty tank does not skip the floor check or the stop it triggers.
    function test_emptyTank_stillRunsEquityStop() public {
        address a = _f(1);
        Policy memory p = _policy(10_000);
        p.equityFloor = 50e18;
        bank.setEquity(a, 100e18);
        _prep(a);
        _join(a, trader, p, _none());
        _fire(0, _traderTo(btc, 50_000));
        assertEq(_size(btc, a), 50_000);

        _setTank(a, 0);
        bank.setEquity(a, 10e18);
        Vm.Log memory ev = _traderTo(eth, -2e16);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(a, sid, address(eth), Reason.EquityFloor, "");
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.Stopped(a, 10e18);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, sid, address(btc), 50_000, 0, BTC_EXIT_SELL, false);
        _fire(0, ev);
        assertTrue(_paused(a));
        assertEq(_size(btc, a), 0);
        assertEq(_size(eth, a), 0);
    }
}

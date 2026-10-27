// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Base} from "./Base.t.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {CopybookHub} from "../src/CopybookHub.sol";
import {CopyEngine} from "../src/CopyEngine.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {Leg, Policy, Reason, SourceKind} from "../src/Types.sol";
import {IMarginBank, IPerpPool, IRiskGate} from "../src/interfaces/IDreamPerps.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaEventHandler.sol";

contract DenyGate is IRiskGate {
    bool public deny = true;

    function set(bool deny_) external {
        deny = deny_;
    }

    function allowIncrease(bytes32) external view returns (bool) {
        return !deny;
    }
}

contract HubThemeTest is Base {
    using stdStorage for StdStorage;

    StdStorage internal _store;

    bytes32 internal constant THEME_REBALANCED = keccak256("ThemeRebalanced(uint256,uint32)");
    uint256 internal constant TANK = 0.5 ether;

    // Sizes at allocation 100e18 (mark BTC 80_000, ETH 2_300, SOL 150), rounded down to lots.
    int256 internal constant BTC_2K = 25_000;
    int256 internal constant BTC_4K = 50_000;
    int256 internal constant BTC_5K = 62_000;
    int256 internal constant BTC_6K = 75_000;
    int256 internal constant BTC_7K = 87_000;
    int256 internal constant ETH_4K = 17_300_000_000_000_000;
    int256 internal constant ETH_5K = 21_700_000_000_000_000;
    int256 internal constant ETH_6K = 26_000_000_000_000_000; // 17.3e15 + 8.7e15
    int256 internal constant ETH_7K = 30_400_000_000_000_000; // 21.7e15 + 8.7e15
    int256 internal constant SOL_2K = 130_000_000_000_000_000;
    int256 internal constant SOL_3K = 200_000_000_000_000_000;
    int256 internal constant SOL_300 = 20_000_000_000_000_000;

    // Limit prices: increases inside the 50 bps band, exits at the 100 bps exit band.
    uint256 internal constant BTC_BUY = 80_400e18;
    uint256 internal constant BTC_SELL = 79_600e18;
    uint256 internal constant BTC_EXIT_SELL = 79_200e18;
    uint256 internal constant ETH_BUY = 2_311_500_000_000_000_000_000;
    uint256 internal constant ETH_SELL = 2_288_500_000_000_000_000_000;
    uint256 internal constant ETH_EXIT_BUY = 2_323e18;
    uint256 internal constant SOL_BUY = 150_750_000_000_000_000_000;
    uint256 internal constant SOL_SELL = 149_250_000_000_000_000_000;
    uint256 internal constant SOL_EXIT_SELL = 148_500_000_000_000_000_000;

    CopybookHub internal hub;
    ThemeRegistry internal themes;
    MockPerpPool internal sol;

    address internal owner = address(0x0A11);
    address internal creator = address(0xC4EA);
    address internal stranger = address(0x5EE);
    address internal follower = address(0xF011);

    uint256 internal tid;
    bytes32 internal tsid;

    function setUp() public override {
        super.setUp();
        sol = new MockPerpPool(bank, 150e18, 1e15, 1e17, 1e16, 1e18);
        bank.registerPool(address(sol));
        themes = new ThemeRegistry(address(bank));
        hub = new CopybookHub(IMarginBank(address(bank)), themes, 8, owner);
        vm.deal(address(hub), 40 ether);
        btc.setLiquidity(10_000_000, 10_000_000, 10);
        eth.setLiquidity(10e18, 10e18, 10);
        sol.setLiquidity(100e18, 100e18, 10);
        tid = _create(_legs(btc, 5_000, eth, -5_000));
        tsid = hub.sourceIdOf(SourceKind.Theme, tid);
    }

    // ---------- helpers ----------

    function _f(uint256 i) internal pure returns (address) {
        return address(uint160(0xF000 + i));
    }

    function _policy(uint128 allocation) internal pure returns (Policy memory) {
        return Policy({
            scaleBps: 0, allocation: allocation, maxNotional: 100e18, maxTotalNotional: 0, bandBps: 50, equityFloor: 0
        });
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _one(MockPerpPool a) internal pure returns (address[] memory p) {
        p = new address[](1);
        p[0] = address(a);
    }

    function _legs(MockPerpPool a, int32 wa, MockPerpPool b, int32 wb) internal pure returns (Leg[] memory l) {
        l = new Leg[](2);
        l[0] = Leg(address(a), wa);
        l[1] = Leg(address(b), wb);
    }

    function _legs3(MockPerpPool a, int32 wa, MockPerpPool b, int32 wb, MockPerpPool c, int32 wc)
        internal
        pure
        returns (Leg[] memory l)
    {
        l = new Leg[](3);
        l[0] = Leg(address(a), wa);
        l[1] = Leg(address(b), wb);
        l[2] = Leg(address(c), wc);
    }

    function _create(Leg[] memory legs) internal returns (uint256) {
        vm.prank(creator);
        return themes.createTheme("thesis", "ipfs://thesis", legs);
    }

    /// Rebalances theme `tid` (after the registry's minimum interval) and returns the ThemeRebalanced log a
    /// subscription would deliver.
    function _rebalance(Leg[] memory legs) internal returns (Vm.Log memory ev) {
        vm.warp(block.timestamp + themes.MIN_REBALANCE_INTERVAL());
        vm.recordLogs();
        vm.prank(creator);
        themes.rebalance(tid, legs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(themes) && logs[i].topics[0] == THEME_REBALANCED) ev = logs[i];
        }
        require(ev.emitter == address(themes), "no ThemeRebalanced");
    }

    function _fire(uint32 group, Vm.Log memory ev) internal {
        reactivity.fire(hub.subscriptionOf(tsid, group), ev.emitter, ev.topics, ev.data);
    }

    function _prep(address who) internal {
        vm.deal(who, 1 ether);
        btc.approve(who, address(hub));
        eth.approve(who, address(hub));
        sol.approve(who, address(hub));
    }

    function _followTheme(address who, Policy memory p) internal {
        _prep(who);
        vm.prank(who);
        hub.follow{value: TANK}(SourceKind.Theme, tid, p, _none());
    }

    function _size(MockPerpPool pool, address account) internal view returns (int256) {
        return bank.getPosition(account, address(pool)).size;
    }

    function _paused(address who) internal view returns (bool paused) {
        (,,,, paused,) = hub.followOf(who);
    }

    function _move(MockPerpPool pool, address account, int256 target) internal {
        int256 d = target - _size(pool, account);
        if (d == 0) return;
        bool bid = d > 0;
        uint256 price = (bid ? pool.mark() * 11 / 10 : pool.mark() * 9 / 10) / pool.tick() * pool.tick();
        pool.placeOrderFor(account, bid, 0, price, uint256(bid ? d : -d), type(uint64).max, 2, 0, address(0), 0);
    }

    function _hubLogs(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub)) n++;
        }
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

    /// Fills of `who`'s orders on `pool`.
    function _fills(Vm.Log[] memory logs, MockPerpPool pool, address who) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != MockPerpPool.MockFill.selector) continue;
            (address o,,,) = abi.decode(logs[i].data, (address, bool, uint256, uint256));
            if (o == who) n++;
        }
    }

    function _setTank(address who, uint256 amount) internal {
        uint256 total = hub.totalTanks() - hub.tankOf(who) + amount;
        _store.target(address(hub)).sig("tankOf(address)").with_key(who).checked_write(amount);
        _store.target(address(hub)).sig("totalTanks()").checked_write(total);
    }

    function _fok() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockPerpPool.FillOrKillNotFilled.selector);
    }

    // ---------- follow ----------

    function test_followTheme_opensAllLegsSameTx() public {
        _prep(follower);
        address predicted = vm.computeCreateAddress(address(hub), vm.getNonce(address(hub)));

        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupOpened(tsid, 0, predicted, 1);
        vm.expectEmit(true, true, false, true, address(hub));
        emit CopybookHub.Followed(follower, tsid, SourceKind.Theme, tid);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), 0, BTC_5K, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(eth), 0, -ETH_5K, ETH_SELL, false);
        vm.prank(follower);
        bytes32 s = hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _none());

        assertEq(s, tsid);
        assertEq(_size(btc, follower), BTC_5K);
        assertEq(_size(eth, follower), -ETH_5K);
        address[] memory synced = hub.syncedPools(follower);
        assertEq(synced.length, 2);
        assertEq(synced[0], address(btc));
        assertEq(synced[1], address(eth));
        assertEq(hub.tankOf(follower), TANK, "the follower paid the follow tx; the tank is not charged");

        (bytes32 sid_, SourceKind kind, uint256 ref,, bool paused, uint32 group) = hub.followOf(follower);
        assertEq(sid_, tsid);
        assertEq(uint8(kind), uint8(SourceKind.Theme));
        assertEq(ref, tid);
        assertFalse(paused);
        assertEq(group, 0);

        (ISomniaReactivityPrecompile.SubscriptionData memory d, address subOwner) = reactivity.getSubscription(1);
        assertEq(subOwner, address(hub));
        assertEq(d.emitter, address(themes));
        assertEq(d.eventTopics[0], THEME_REBALANCED);
        assertEq(d.eventTopics[1], bytes32(tid));
        assertEq(d.eventTopics[2], bytes32(0));
        assertEq(d.eventTopics[3], bytes32(0));
        assertEq(d.handlerContractAddress, predicted);
        assertEq(d.handlerFunctionSelector, ISomniaEventHandler.onEvent.selector);
        assertEq(d.gasLimit, 200_000_000);
    }

    function test_theme_joinPoolsRejected() public {
        _prep(follower);
        vm.startPrank(follower);
        vm.expectRevert(CopybookHub.JoinPoolsNotAllowed.selector);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _one(btc));

        vm.expectRevert(CopybookHub.InvalidSource.selector);
        hub.follow{value: TANK}(SourceKind.Theme, 0, _policy(100e18), _none());
        vm.expectRevert(CopybookHub.InvalidSource.selector);
        hub.follow{value: TANK}(SourceKind.Theme, tid + 1, _policy(100e18), _none());

        vm.expectRevert(abi.encodeWithSelector(PolicyLib.InvalidPolicy.selector, uint8(2)));
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(0), _none());
        vm.stopPrank();

        (bytes32 s,,,,,) = hub.followOf(follower);
        assertEq(s, bytes32(0));
        assertEq(_size(btc, follower), 0);
    }

    function test_theme_groupsOfTwo_gasDefaults() public {
        assertEq(hub.themeGroupSize(), 2);
        assertEq(hub.groupSize(), 8);
        (, uint64 cap, uint64 themeCap,,) = hub.gasParams();
        assertEq(cap, 20_000_000);
        assertEq(themeCap, 90_000_000);

        _followTheme(_f(1), _policy(100e18));
        _followTheme(_f(2), _policy(100e18));
        assertEq(hub.groupCount(tsid), 1);
        _followTheme(_f(3), _policy(100e18));
        assertEq(hub.groupCount(tsid), 2);
        (,,,,, uint32 g) = hub.followOf(_f(3));
        assertEq(g, 1);
        assertEq(hub.membersOf(tsid, 0).length, 2);
        (ISomniaReactivityPrecompile.SubscriptionData memory d,) = reactivity.getSubscription(2);
        assertEq(d.emitter, address(themes));
        assertEq(d.eventTopics[1], bytes32(tid));
        assertEq(d.handlerContractAddress, hub.relayOf(tsid, 1));
    }

    // ---------- all-or-nothing ----------

    function test_themeIncreasesAllOrNothing() public {
        // ETH has no bids: the short leg cannot fill, so the long leg is not opened either
        eth.setLiquidity(0, 0, 10);
        _prep(follower);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(eth), Reason.LegFailed, _fok());
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _none());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Copied.selector, follower), 0);
        assertEq(_size(btc, follower), 0, "BTC leg rolled back");
        assertEq(_size(eth, follower), 0);

        eth.setLiquidity(10e18, 10e18, 10);
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), BTC_5K);
        assertEq(_size(eth, follower), -ETH_5K);

        // BTC trims (a reduction), ETH and the new SOL leg grow; SOL has no asks.
        // The ETH increase fills first and is rolled back with the failed SOL leg; the BTC trim stays.
        sol.setLiquidity(0, 0, 10);
        Vm.Log memory ev = _rebalance(_legs3(btc, 2_000, eth, -7_000, sol, 2_000));
        // the ETH leg is sent (and fills) before the SOL leg fails
        bytes memory ethOrder = abi.encodeCall(
            IPerpPool.placeOrderFor,
            (
                follower,
                false,
                0,
                ETH_SELL,
                uint256(ETH_7K - ETH_5K),
                uint64((block.timestamp + 60) * 1e9),
                1,
                0,
                address(0),
                0
            )
        );
        vm.expectCall(address(eth), ethOrder, 1);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(sol), Reason.LegFailed, _fok());
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), BTC_5K, BTC_2K, BTC_EXIT_SELL, false);
        vm.recordLogs();
        _fire(0, ev);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Copied.selector, follower), 1, "only the reduction");
        assertEq(_size(btc, follower), BTC_2K, "reduction kept");
        assertEq(_size(eth, follower), -ETH_5K, "ETH increase rolled back");
        assertEq(_size(sol, follower), 0);

        // liquidity back: the whole increase set goes through
        sol.setLiquidity(100e18, 100e18, 10);
        vm.warp(block.timestamp + 1);
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), BTC_2K);
        assertEq(_size(eth, follower), -ETH_7K);
        assertEq(_size(sol, follower), SOL_2K);
    }

    function test_theme_staleMarkOnOneLegRefusesSet() public {
        bytes memory stale = abi.encodeWithSignature("StalePrice()");
        vm.mockCallRevert(address(eth), abi.encodeWithSignature("getMarkPrice()"), stale);
        _prep(follower);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(eth), Reason.VenueRejected, stale);
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _none());
        assertEq(_count(vm.getRecordedLogs(), CopybookHub.Copied.selector, follower), 0);
        assertEq(_size(btc, follower), 0, "no partial basket");
        vm.clearMockedCalls();

        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), BTC_5K);
        assertEq(_size(eth, follower), -ETH_5K);

        // with ETH unreadable the BTC trim still goes through; the SOL increase waits with ETH's
        Vm.Log memory ev = _rebalance(_legs3(btc, 2_000, eth, -7_000, sol, 2_000));
        vm.mockCallRevert(address(eth), abi.encodeWithSignature("getMarkPrice()"), stale);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(eth), Reason.VenueRejected, stale);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), BTC_5K, BTC_2K, BTC_EXIT_SELL, false);
        _fire(0, ev);
        vm.clearMockedCalls();
        assertEq(_size(btc, follower), BTC_2K);
        assertEq(_size(eth, follower), -ETH_5K);
        assertEq(_size(sol, follower), 0);

        hub.catchUp(follower, _none());
        assertEq(_size(eth, follower), -ETH_7K);
        assertEq(_size(sol, follower), SOL_2K);
    }

    // ---------- rebalance ----------

    function test_rebalance_event_resizesAndDropsRemovedLeg() public {
        address a = _f(1);
        address b = _f(2);
        _followTheme(a, _policy(100e18));
        _followTheme(b, _policy(80e18));
        assertEq(_size(btc, b), BTC_4K);
        assertEq(_size(eth, b), -ETH_4K);

        Vm.Log memory ev = _rebalance(_legs(btc, 7_000, sol, -3_000));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, tsid, address(btc), BTC_5K, BTC_7K, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, tsid, address(eth), -ETH_5K, 0, ETH_EXIT_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, tsid, address(sol), 0, -SOL_3K, SOL_SELL, false);
        vm.recordLogs();
        _fire(0, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_size(btc, a), BTC_7K);
        assertEq(_size(eth, a), 0);
        assertEq(_size(sol, a), -SOL_3K);
        // the whole group moves in the same handler
        assertEq(_size(btc, b), 70_000);
        assertEq(_size(eth, b), 0);
        assertEq(_size(sol, b), -160_000_000_000_000_000);
        assertEq(_count(logs, CopybookHub.TankCharged.selector, a), 1);
        assertEq(_count(logs, CopybookHub.TankCharged.selector, b), 1);
        assertLt(hub.tankOf(a), TANK);

        // the dropped leg stays in the follow's markets so it can always be closed
        address[] memory synced = hub.syncedPools(a);
        assertEq(synced.length, 3);
        assertEq(synced[2], address(sol));

        // the same event again: everyone is at target, nothing is sent
        vm.recordLogs();
        _fire(0, ev);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Copied.selector, a), 0);
        assertEq(_count(logs, CopybookHub.Refused.selector, a), 0);
        assertEq(_fills(logs, btc, a) + _fills(logs, eth, a) + _fills(logs, sol, a), 0);
    }

    function test_rebalance_flipLeg_reduceThenIncrease() public {
        _followTheme(follower, _policy(100e18));
        Vm.Log memory ev = _rebalance(_legs(btc, -5_000, eth, 5_000));

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), BTC_5K, -BTC_5K, BTC_SELL, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(eth), -ETH_5K, ETH_5K, ETH_BUY, false);
        vm.recordLogs();
        _fire(0, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_size(btc, follower), -BTC_5K);
        assertEq(_size(eth, follower), ETH_5K);

        // every leg is closed before any leg is opened on the other side
        address[4] memory pool = [address(btc), address(eth), address(btc), address(eth)];
        bool[4] memory bid = [false, true, false, true];
        uint256[4] memory qty = [uint256(BTC_5K), uint256(ETH_5K), uint256(BTC_5K), uint256(ETH_5K)];
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != MockPerpPool.MockFill.selector) continue;
            (address o, bool isBid, uint256 q,) = abi.decode(logs[i].data, (address, bool, uint256, uint256));
            if (o != follower) continue;
            assertEq(logs[i].emitter, pool[k]);
            assertEq(isBid, bid[k]);
            assertEq(q, qty[k]);
            k++;
        }
        assertEq(k, 4);
    }

    function test_theme_removedLegStaysReducible() public {
        _followTheme(follower, _policy(100e18));
        // ETH is dropped while its exit fails: the position stays open in an allowlisted market
        bytes memory busy = abi.encodeWithSignature("Busy()");
        eth.setRevertFor(follower, busy);
        Vm.Log memory ev = _rebalance(_legs(btc, 5_000, sol, 3_000));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(eth), Reason.VenueRejected, busy);
        _fire(0, ev);
        assertEq(_size(eth, follower), -ETH_5K);
        assertEq(_size(sol, follower), SOL_3K, "the exit failing does not hold up the new basket");

        eth.setRevertFor(follower, "");
        vm.prank(stranger);
        hub.catchUp(follower, _none());
        assertEq(_size(eth, follower), 0);

        // unfollow with flatten closes every market the follow ever held
        vm.prank(follower);
        hub.unfollow(true);
        assertEq(_size(btc, follower), 0);
        assertEq(_size(sol, follower), 0);
    }

    // ---------- allowlist ----------

    function test_theme_strangerCannotTouchNonLegPool() public {
        // the follower's own SOL position, outside the theme
        sol.approve(follower, address(this));
        _move(sol, follower, 3e17);
        _followTheme(follower, _policy(100e18));
        assertEq(hub.syncedPools(follower).length, 2);

        vm.recordLogs();
        vm.prank(stranger);
        hub.catchUp(follower, _one(sol));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_hubLogs(logs), 0, "pools are ignored; the basket is already at target");
        assertEq(_fills(logs, sol, follower), 0);
        assertEq(_size(sol, follower), 3e17);

        Vm.Log memory ev = _rebalance(_legs(btc, 7_000, eth, -7_000));
        vm.recordLogs();
        _fire(0, ev);
        logs = vm.getRecordedLogs();
        assertEq(_fills(logs, sol, follower), 0);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub) && logs[i].topics.length > 3) {
                assertTrue(logs[i].topics[3] != bytes32(uint256(uint160(address(sol)))), "no event on SOL");
            }
        }
        assertEq(_size(btc, follower), BTC_7K);
        assertEq(_size(sol, follower), 3e17);

        // unfollow with flatten leaves it alone too
        vm.prank(follower);
        hub.unfollow(true);
        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);
        assertEq(_size(sol, follower), 3e17);
    }

    // A creator rotating through ever more markets cannot grow a follow's market set without bound.
    function test_theme_allowlistBounded() public {
        _followTheme(follower, _policy(100e18));
        uint256 max = hub.MAX_JOIN_POOLS();
        uint256 n = 2;
        MockPerpPool last;
        Vm.Log[] memory logs;
        while (n <= max) {
            Leg[] memory legs = new Leg[](8);
            for (uint256 j; j < 8; ++j) {
                last = new MockPerpPool(bank, 100e18, 1e15, 1e16, 1e16, 1e18);
                bank.registerPool(address(last));
                last.approve(follower, address(hub));
                last.setLiquidity(100e18, 100e18, 10);
                legs[j] = Leg(address(last), 1_000);
            }
            _rebalance(legs);
            vm.recordLogs();
            hub.catchUp(follower, _none());
            logs = vm.getRecordedLogs();
            n += 8;
            if (n <= max) {
                assertEq(hub.syncedPools(follower).length, n);
                assertEq(_count(logs, CopybookHub.Refused.selector, follower), 0);
                assertEq(_size(last, follower), 1e17);
            }
        }
        // the rotation that would take the set past the bound: the markets beyond it are refused
        // and so is the increase set; the follow's existing markets still sync their reductions
        assertEq(hub.syncedPools(follower).length, max);
        assertEq(_count(logs, CopybookHub.Refused.selector, follower), 2);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(last), Reason.MarketNotAllowed, "");
        hub.catchUp(follower, _none());
        assertEq(_size(last, follower), 0);
    }

    // ---------- theme-level gates ----------

    function test_theme_totalCapRefusesWholeSet() public {
        Policy memory p = _policy(100e18);
        p.maxTotalNotional = 60e18; // the basket is ~99.5e18 at mark
        _prep(follower);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.TotalCap, "");
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, p, _none());
        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);

        p.maxTotalNotional = 100e18;
        vm.prank(follower);
        hub.updatePolicy(p);
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), BTC_5K);
        assertEq(_size(eth, follower), -ETH_5K);

        // a stricter cap never blocks the reductions of a rebalance
        p.maxTotalNotional = 1e18;
        vm.prank(follower);
        hub.updatePolicy(p);
        Vm.Log memory ev = _rebalance(_legs(btc, 2_000, eth, -7_000));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.TotalCap, "");
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), BTC_5K, BTC_2K, BTC_EXIT_SELL, false);
        _fire(0, ev);
        assertEq(_size(btc, follower), BTC_2K);
        assertEq(_size(eth, follower), -ETH_5K);
    }

    function test_theme_equityStop_thenPausedRefusedWithoutReads() public {
        Policy memory p = _policy(100e18);
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _followTheme(follower, p);
        assertEq(_size(btc, follower), BTC_5K);

        // below the floor: the increase set is refused and the follow stops, flattening every leg
        bank.setEquity(follower, 10e18);
        Vm.Log memory ev = _rebalance(_legs(btc, 7_000, eth, -7_000));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.EquityFloor, "");
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), BTC_5K, 0, BTC_EXIT_SELL, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(eth), -ETH_5K, 0, ETH_EXIT_BUY, false);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.Stopped(follower, 10e18);
        _fire(0, ev);
        assertTrue(_paused(follower));
        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);

        // paused and flat: refused once for the whole set, without reading any market
        bank.setEquity(follower, 100e18);
        vm.expectCall(address(btc), abi.encodeCall(IPerpPool.getMarkPrice, ()), 0);
        vm.expectCall(address(eth), abi.encodeCall(IPerpPool.getMarkPrice, ()), 0);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.Paused, "");
        _fire(0, ev);
        assertEq(_size(btc, follower), 0);
    }

    function test_theme_tankAndRiskGateRefuseWholeSet() public {
        DenyGate gate = new DenyGate();
        _store.target(address(hub)).sig("riskGate()").checked_write(address(gate));
        _prep(follower);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.RiskGate, "");
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _none());
        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);

        // tank below the increase minimum
        gate.set(false);
        _setTank(follower, hub.MIN_TANK_FOR_INCREASE() - 1);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.TankEmpty, "");
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), 0);

        _setTank(follower, TANK);
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), BTC_5K);
        assertEq(_size(eth, follower), -ETH_5K);

        // a risk gate that turns against the source never blocks the way out
        gate.set(true);
        Vm.Log memory ev = _rebalance(_legs(btc, 2_000, eth, -7_000));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.RiskGate, "");
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), BTC_5K, BTC_2K, BTC_EXIT_SELL, false);
        _fire(0, ev);
        assertEq(_size(eth, follower), -ETH_5K);
    }

    // ---------- reactive path ----------

    function test_theme_eventIsolationAcrossFollowers() public {
        address a = _f(1);
        address b = _f(2);
        address c = _f(3); // the second group
        _followTheme(a, _policy(100e18));
        _followTheme(b, _policy(100e18));
        _followTheme(c, _policy(100e18));
        bytes memory err = abi.encodeWithSignature("InsufficientCollateral()");
        eth.setRevertFor(b, err);

        Vm.Log memory ev = _rebalance(_legs(btc, 7_000, eth, -7_000));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, tsid, address(btc), BTC_5K, BTC_7K, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(a, tsid, address(eth), -ETH_5K, -ETH_7K, ETH_SELL, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(b, tsid, address(eth), Reason.LegFailed, err);
        _fire(0, ev);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(c, tsid, address(eth), -ETH_5K, -ETH_7K, ETH_SELL, false);
        _fire(1, ev);
        assertEq(_size(btc, a), BTC_7K);
        assertEq(_size(btc, b), BTC_5K, "b's BTC increase rolled back with its ETH leg");
        assertEq(_size(eth, b), -ETH_5K);
        assertEq(_size(btc, c), BTC_7K);
        assertEq(_size(eth, c), -ETH_7K);
        eth.setRevertFor(b, "");

        // a revert the theme sync does not catch itself stays with that follower too
        bytes memory halted = abi.encodeWithSignature("Halted()");
        vm.mockCallRevert(address(bank), abi.encodeCall(IMarginBank.getPosition, (b, address(btc))), halted);
        ev = _rebalance(_legs(btc, 5_000, eth, -5_000));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(b, tsid, address(0), Reason.VenueRejected, halted);
        _fire(0, ev);
        vm.clearMockedCalls();
        // a trims toward 62_500 / -21.74e15 in whole lots
        assertEq(_size(btc, a), 63_000);
        assertEq(_size(eth, a), -21_800_000_000_000_000);
        assertEq(_size(btc, b), BTC_5K);
        assertEq(_size(eth, b), -ETH_5K);
    }

    function test_theme_catchUpConverges() public {
        address a = _f(1);
        address b = _f(2);
        _followTheme(a, _policy(100e18));
        _followTheme(b, _policy(100e18));
        Vm.Log memory ev = _rebalance(_legs(btc, 7_000, sol, -3_000));

        // too little gas for any member: the group is deferred, nobody is charged
        (uint64 floor,,,,) = hub.gasParams();
        vm.recordLogs();
        reactivity.fire{gas: floor}(hub.subscriptionOf(tsid, 0), ev.emitter, ev.topics, ev.data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 deferred;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub) && logs[i].topics[0] == CopybookHub.GroupDeferred.selector) {
                assertEq(logs[i].topics[1], tsid);
                (uint32 g, uint256 from) = abi.decode(logs[i].data, (uint32, uint256));
                assertEq(g, 0);
                assertEq(from, 0);
                deferred++;
            }
        }
        assertEq(deferred, 1);
        assertEq(_size(btc, a), BTC_5K);
        assertEq(hub.tankOf(a), TANK);

        // catchUp runs the whole theme sync whatever pools it is given
        vm.prank(stranger);
        hub.catchUp(a, _none());
        vm.prank(stranger);
        hub.catchUp(b, _one(btc));
        for (uint256 i = 1; i <= 2; ++i) {
            assertEq(_size(btc, _f(i)), BTC_7K);
            assertEq(_size(eth, _f(i)), 0);
            assertEq(_size(sol, _f(i)), -SOL_3K);
        }

        // converged: another catchUp sends nothing
        vm.recordLogs();
        hub.catchUp(a, _none());
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
    }

    // A member whose order runs out of gas burns a full theme slot (themePerFollowerCap, not the trader cap):
    // it alone is deferred and billed, the rest of the group rebalances, and catchUp converges it later.
    function test_theme_oogMember_fullThemeSlot_deferredAlone() public {
        address a = _f(1);
        address b = _f(2);
        _followTheme(a, _policy(100e18));
        _followTheme(b, _policy(100e18));
        vm.prank(a);
        hub.fundTank{value: 0.5 ether}();
        btc.setBombFor(a, true);
        vm.fee(6 gwei);

        Vm.Log memory ev = _rebalance(_legs(btc, 7_000, eth, -7_000));
        uint256 tank = hub.tankOf(a);
        vm.recordLogs();
        _fire(0, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, CopybookHub.Deferred.selector, a), 1);
        assertEq(_count(logs, CopybookHub.Refused.selector, a), 0);
        assertEq(_count(logs, CopybookHub.Copied.selector, a), 0);
        assertEq(_count(logs, CopybookHub.Copied.selector, b), 2);
        assertEq(_size(btc, a), BTC_5K);
        assertEq(_size(btc, b), BTC_7K);
        assertEq(_size(eth, b), -ETH_7K);

        (, uint64 traderCap, uint64 themeCap,,) = hub.gasParams();
        uint256 gasBilled = (tank - hub.tankOf(a)) / 6 gwei - hub.CHARGE_OVERHEAD_GAS();
        assertGt(gasBilled, uint256(traderCap) * 4, "a theme slot, far beyond the trader cap");
        assertLe(gasBilled, themeCap + 100_000);

        btc.setBombFor(a, false);
        hub.catchUp(a, _none());
        assertEq(_size(btc, a), BTC_7K);
        assertEq(_size(eth, a), -ETH_7K);
    }

    function test_theme_badEventRejected() public {
        _followTheme(follower, _policy(100e18));
        address relay = hub.relayOf(tsid, 0);
        uint256 other = _create(_legs(btc, 1_000, eth, -1_000));
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = THEME_REBALANCED;
        topics[1] = bytes32(other);
        bytes memory data = abi.encode(uint32(2));

        // another theme's rebalance
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(tsid, 0, address(themes), topics, data);
        // the right theme id from another emitter or with another signature
        topics[1] = bytes32(tid);
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(tsid, 0, address(bank), topics, data);
        topics[0] = keccak256("ThemeCreated(uint256,address,string)");
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(tsid, 0, address(themes), topics, data);
        // too few topics
        bytes32[] memory short = new bytes32[](1);
        short[0] = THEME_REBALANCED;
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(tsid, 0, address(themes), short, data);

        vm.prank(stranger);
        vm.expectRevert(CopybookHub.NotRelay.selector);
        hub.onSourceEvent(tsid, 0, address(themes), topics, data);
    }

    function test_theme_selfCallsOnlySelf() public {
        _followTheme(follower, _policy(100e18));
        CopyEngine.LegOrder[] memory orders = new CopyEngine.LegOrder[](0);
        vm.prank(stranger);
        vm.expectRevert(CopybookHub.NotSelf.selector);
        hub.applyIncreases(follower, orders);
        address relay = hub.relayOf(tsid, 0);
        Leg[] memory legs = themes.legsOf(tid);
        vm.prank(relay);
        vm.expectRevert(CopybookHub.NotSelf.selector);
        hub.syncThemeFromEvent(tsid, follower, legs, 1);
        assertEq(_size(btc, follower), BTC_5K);
    }

    function test_theme_topicMatchesRegistry() public view {
        assertEq(hub.THEME_REBALANCED_TOPIC(), themes.THEME_REBALANCED_TOPIC());
        assertEq(hub.THEME_REBALANCED_TOPIC(), THEME_REBALANCED);
    }

    // ---------- fix round 1: dust legs, churn, rebalance spam, short fills ----------

    // A leg too small to open (it rounds below the venue minimum) holds the whole basket back: a pair trade
    // never opens as a naked short.
    function test_theme_dustLegHoldsBackBasket() public {
        _prep(follower);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(btc), Reason.LegFailed, "");
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(20e18), _none()); // BTC 12_500 < 13_000 minimum
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0, "no naked ETH short");
        assertEq(_fills(logs, eth, follower), 0);
        (uint32 v, bool done) = hub.themeSyncOf(follower);
        assertEq(v, 0);
        assertFalse(done);

        // a larger allocation opens both
        Policy memory p = _policy(100e18);
        vm.prank(follower);
        hub.updatePolicy(p);
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), BTC_5K);
        assertEq(_size(eth, follower), -ETH_5K);
    }

    // Mark drift alone never lets anyone trade a theme follower: catchUp acts only on a new theme version or
    // after a sync that did not finish.
    function test_theme_strangerCatchUpAfterMarkDrift_noFills() public {
        Policy memory p = _policy(1_000e18);
        p.maxNotional = 1_000e18;
        _followTheme(follower, p);
        int256 b0 = _size(btc, follower);
        int256 e0 = _size(eth, follower);
        assertEq(b0, 625_000);

        btc.setMark(76_000e18); // -5%
        eth.setMark(2_415e18); // +5%
        vm.recordLogs();
        vm.prank(stranger);
        hub.catchUp(follower, _none());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_hubLogs(logs), 0);
        assertEq(_fills(logs, btc, follower) + _fills(logs, eth, follower), 0);
        assertEq(_size(btc, follower), b0);
        assertEq(_size(eth, follower), e0);

        // even far beyond the drift band
        btc.setMark(60_000e18);
        vm.recordLogs();
        vm.prank(stranger);
        hub.catchUp(follower, _none());
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertEq(_size(btc, follower), b0);
    }

    // The follower can resync any time. A leg on the right side within THEME_DRIFT_BPS of its target is left
    // alone; one beyond it is resized.
    function test_theme_resync_driftBand() public {
        Policy memory p = _policy(1_000e18);
        p.maxNotional = 1_000e18;
        _followTheme(follower, p);
        assertEq(hub.THEME_DRIFT_BPS(), 500);
        int256 e0 = _size(eth, follower);

        btc.setMark(76_800e18); // -4%
        eth.setMark(2_392e18); // +4%
        vm.recordLogs();
        vm.prank(follower);
        hub.resync();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_fills(logs, btc, follower) + _fills(logs, eth, follower), 0, "inside the band");
        assertEq(_size(btc, follower), 625_000);

        btc.setMark(72_000e18); // -10%: target 694_444
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, tsid, address(btc), 625_000, 694_000, 72_360e18, false);
        vm.prank(follower);
        hub.resync();
        assertEq(_size(btc, follower), 694_000);
        assertEq(_size(eth, follower), e0, "ETH still inside the band");

        vm.prank(stranger);
        vm.expectRevert(CopybookHub.NotFollowing.selector);
        hub.resync();
    }

    function test_theme_resync_traderFollowReverts() public {
        _prep(follower);
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Trader, uint256(uint160(creator)), _traderPolicy(), _none());
        vm.prank(follower);
        vm.expectRevert(CopybookHub.NotThemeFollow.selector);
        hub.resync();
    }

    // The sync state follows the theme version: only a sync that leaves every leg at target records it.
    function test_theme_syncStateTracksVersion() public {
        eth.setLiquidity(0, 0, 10);
        _followTheme(follower, _policy(100e18));
        (uint32 v, bool done) = hub.themeSyncOf(follower);
        assertEq(v, 0);
        assertFalse(done);

        eth.setLiquidity(10e18, 10e18, 10);
        hub.catchUp(follower, _none());
        (v, done) = hub.themeSyncOf(follower);
        assertEq(v, 1);
        assertTrue(done);

        // a new version, missed by the subscription: catchUp acts
        _rebalance(_legs(btc, 7_000, eth, -7_000));
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), BTC_7K);
        (v, done) = hub.themeSyncOf(follower);
        assertEq(v, 2);
        assertTrue(done);

        // a policy change reopens the sync for anyone
        Policy memory p = _policy(80e18);
        vm.prank(follower);
        hub.updatePolicy(p);
        (, done) = hub.themeSyncOf(follower);
        assertFalse(done);
        hub.catchUp(follower, _none());
        assertEq(_size(btc, follower), 70_000);
        (v, done) = hub.themeSyncOf(follower);
        assertEq(v, 2);
        assertTrue(done);

        // a stop reopens it too
        Policy memory floor = _policy(80e18);
        floor.equityFloor = 50e18;
        vm.prank(follower);
        hub.updatePolicy(floor);
        bank.setEquity(follower, 100e18);
        hub.catchUp(follower, _none());
        (, done) = hub.themeSyncOf(follower);
        assertTrue(done);
        bank.setEquity(follower, 10e18);
        hub.poke(follower);
        assertEq(_size(btc, follower), 0);
        (, done) = hub.themeSyncOf(follower);
        assertFalse(done);
    }

    // The registry refuses a rebalance that changes nothing, or that comes too soon. A rebalance that leaves
    // a member's book inside the drift band still bills it the gas its sync measured, silently (R28): the
    // theme's followers pay for a creator's quiet rebalances, not the hub.
    function test_theme_quietRebalance_billsMeasuredGasSilently() public {
        address a = _f(1);
        address b = _f(2);
        _followTheme(a, _policy(100e18));
        _followTheme(b, _policy(100e18));
        vm.fee(6 gwei);

        vm.warp(block.timestamp + themes.MIN_REBALANCE_INTERVAL());
        vm.startPrank(creator);
        vm.expectRevert(ThemeRegistry.NoChange.selector);
        themes.rebalance(tid, _legs(btc, 5_000, eth, -5_000));
        vm.expectRevert(ThemeRegistry.NoChange.selector);
        themes.rebalance(tid, _legs(eth, -5_000, btc, 5_000)); // the same set in another order
        vm.stopPrank();

        Vm.Log memory ev = _rebalance(_legs(btc, 5_100, eth, -5_000)); // BTC target +2.8%
        vm.prank(creator);
        vm.expectRevert(ThemeRegistry.RebalanceTooSoon.selector);
        themes.rebalance(tid, _legs(btc, 5_200, eth, -5_000));

        uint256 ta = hub.tankOf(a);
        uint256 tb = hub.tankOf(b);
        uint256 total = hub.totalTanks();
        vm.recordLogs();
        _fire(0, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_fills(logs, btc, a) + _fills(logs, eth, a) + _fills(logs, btc, b) + _fills(logs, eth, b), 0);
        assertEq(_hubLogs(logs), 0, "no TankCharged, no Copied");
        uint256 overhead = hub.CHARGE_OVERHEAD_GAS();
        (,, uint64 themeCap,,) = hub.gasParams();
        uint256 paidA = ta - hub.tankOf(a);
        uint256 paidB = tb - hub.tankOf(b);
        assertEq(paidA % 6 gwei, 0);
        assertGt(paidA / 6 gwei, overhead + 20_000, "the measured reads, not the overhead alone");
        assertGt(paidB / 6 gwei, overhead + 20_000, "the measured reads, not the overhead alone");
        assertLe(paidA / 6 gwei, overhead + themeCap);
        assertEq(hub.totalTanks(), total - paidA - paidB);
        (uint32 v, bool done) = hub.themeSyncOf(a);
        assertEq(v, 2);
        assertTrue(done);
    }

    // The venue reports success without filling, or reports failure: the leg before it is rolled back.
    function test_theme_successWithoutFill_rollsBackSet() public {
        vm.mockCall(
            address(eth), abi.encodeWithSelector(IPerpPool.placeOrderFor.selector), abi.encode(true, uint128(1))
        );
        _prep(follower);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(eth), Reason.LegFailed, "");
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _none());
        vm.clearMockedCalls();
        assertEq(_size(eth, follower), 0);
        assertEq(_size(btc, follower), 0, "BTC rolled back with the unfilled ETH leg");
    }

    function test_theme_venueFalse_rollsBackSet() public {
        vm.mockCall(
            address(eth), abi.encodeWithSelector(IPerpPool.placeOrderFor.selector), abi.encode(false, uint128(0))
        );
        _prep(follower);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(eth), Reason.LegFailed, "");
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _none());
        vm.clearMockedCalls();
        assertEq(_size(btc, follower), 0, "BTC rolled back with the refused ETH leg");
    }

    // A revert inside the set that is not a leg's own answer (here venue return data that does not decode)
    // still rolls the set back, and is reported without a pool.
    function test_theme_undecodableVenueReturn_rollsBackSet() public {
        vm.mockCall(address(eth), abi.encodeWithSelector(IPerpPool.placeOrderFor.selector), abi.encode(true));
        _prep(follower);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, tsid, address(0), Reason.LegFailed, "");
        vm.prank(follower);
        hub.follow{value: TANK}(SourceKind.Theme, tid, _policy(100e18), _none());
        vm.clearMockedCalls();
        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);
    }

    // Documented in follow: a theme manages every pool that is or becomes a leg, including a position the
    // follower opened there by hand (use a dedicated wallet per source).
    function test_theme_newLegManagesHeldPosition() public {
        sol.approve(follower, address(this));
        _move(sol, follower, 3e18);
        _followTheme(follower, _policy(100e18));
        assertEq(_size(sol, follower), 3e18, "not a leg yet");
        _fire(0, _rebalance(_legs3(btc, 5_000, eth, -3_000, sol, -2_000)));
        assertEq(_size(sol, follower), -SOL_2K);
    }

    function _traderPolicy() internal pure returns (Policy memory p) {
        p = _policy(0);
        p.scaleBps = 10_000;
    }
}

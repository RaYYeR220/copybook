// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base} from "./Base.t.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {FakePool} from "./mocks/FakePool.sol";
import {MockReactivity} from "./mocks/MockReactivity.sol";
import {CopybookHub} from "../src/CopybookHub.sol";
import {GroupRelay} from "../src/GroupRelay.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {PolicyLib} from "../src/PolicyLib.sol";
import {Policy, Reason, SourceKind} from "../src/Types.sol";
import {IMarginBank, IPerpPool, IRiskGate} from "../src/interfaces/IDreamPerps.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaEventHandler.sol";
import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/SomniaEventHandler.sol";

contract FlagGate is IRiskGate {
    bool public allow;
    bool public broken;

    function set(bool allow_, bool broken_) external {
        allow = allow_;
        broken = broken_;
    }

    function allowIncrease(bytes32) external view returns (bool) {
        require(!broken, "gate down");
        return allow;
    }
}

/// Tries to withdraw its tank a second time from inside the first payout.
contract TankReentrant {
    CopybookHub internal immutable hub;
    bytes public innerError;
    bool public reentered;

    constructor(CopybookHub hub_) {
        hub = hub_;
    }

    function fund() external payable {
        hub.fundTank{value: msg.value}();
    }

    function withdraw(uint256 amount) external {
        hub.withdrawTank(amount);
    }

    receive() external payable {
        if (msg.sender != address(hub) || reentered || innerError.length != 0) return;
        try hub.withdrawTank(msg.value) {
            reentered = true;
        } catch (bytes memory err) {
            innerError = err;
        }
    }
}

contract HubFollowTest is Base {
    using stdStorage for StdStorage;

    StdStorage internal _store;

    bytes32 internal constant POSITION_UPDATED = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;
    uint256 internal constant DEPTH_BTC = 10_000_000;
    uint256 internal constant DEPTH_ETH = 10e18;

    // BTC: mark 80_000e18, tick 1e17. Increase band 50 bps, exit band 100 bps.
    uint256 internal constant BTC_BUY = 80_400e18;
    uint256 internal constant BTC_SELL = 79_600e18;
    uint256 internal constant BTC_EXIT_SELL = 79_200e18;
    // ETH: mark 2_300e18, tick 1e16.
    uint256 internal constant ETH_SELL = 2_288_500_000_000_000_000_000;
    uint256 internal constant ETH_EXIT_BUY = 2_323e18;

    CopybookHub internal hub;
    ThemeRegistry internal themes;

    address internal owner = address(0x0A11);
    address internal trader = address(0x7AD3);
    address internal follower = address(0xF011);
    address internal follower2 = address(0xF022);
    address internal stranger = address(0x5EE);

    bytes32 internal sid;

    function setUp() public override {
        super.setUp();
        themes = new ThemeRegistry(address(bank));
        hub = new CopybookHub(IMarginBank(address(bank)), themes, 8, owner);
        vm.deal(address(hub), 40 ether);
        vm.deal(follower, 10 ether);
        vm.deal(follower2, 10 ether);

        btc.approve(trader, address(this));
        eth.approve(trader, address(this));
        btc.approve(follower, address(this));
        btc.approve(follower, address(hub));
        eth.approve(follower, address(hub));
        btc.approve(follower2, address(hub));
        eth.approve(follower2, address(hub));
        btc.setLiquidity(DEPTH_BTC, DEPTH_BTC, 10);
        eth.setLiquidity(DEPTH_ETH, DEPTH_ETH, 10);

        sid = hub.sourceIdOf(SourceKind.Trader, uint256(uint160(trader)));
    }

    // ---------- helpers ----------

    function _policy() internal pure returns (Policy memory) {
        return Policy({
            scaleBps: 10_000, allocation: 0, maxNotional: 100e18, maxTotalNotional: 0, bandBps: 50, equityFloor: 0
        });
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _one(MockPerpPool a) internal pure returns (address[] memory p) {
        p = new address[](1);
        p[0] = address(a);
    }

    function _two(MockPerpPool a, MockPerpPool b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(a);
        p[1] = address(b);
    }

    function _follow(address who, Policy memory p, address[] memory pools) internal returns (bytes32) {
        vm.prank(who);
        return hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), p, pools);
    }

    /// Moves `account` to `target` on `pool` with a wide IOC placed by this test (an approved operator).
    function _move(MockPerpPool pool, address account, int256 target) internal {
        int256 d = target - _size(pool, account);
        if (d == 0) return;
        bool bid = d > 0;
        uint256 price = (bid ? pool.mark() * 11 / 10 : pool.mark() * 9 / 10) / pool.tick() * pool.tick();
        pool.placeOrderFor(account, bid, 0, price, uint256(bid ? d : -d), type(uint64).max, 2, 0, address(0), 0);
    }

    /// The last MarginBank PositionUpdated log for `pool` in `logs`.
    function _positionEvent(Vm.Log[] memory logs, MockPerpPool pool) internal view returns (Vm.Log memory ev) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(bank) && logs[i].topics[0] == POSITION_UPDATED
                    && logs[i].topics[2] == bytes32(uint256(uint160(address(pool))))
            ) ev = logs[i];
        }
        require(ev.emitter == address(bank), "no PositionUpdated");
    }

    function _fire(Vm.Log memory ev) internal {
        reactivity.fire(hub.subscriptionOf(sid, 0), ev.emitter, ev.topics, ev.data);
    }

    function _traderTo(MockPerpPool pool, int256 target) internal {
        _move(pool, trader, target);
    }

    function _size(MockPerpPool pool, address account) internal view returns (int256) {
        return bank.getPosition(account, address(pool)).size;
    }

    function _paused(address who) internal view returns (bool paused) {
        (,,,, paused,) = hub.followOf(who);
    }

    function _hubLogs(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub)) n++;
        }
    }

    /// Sets a tank directly, as reactive charges would; withdrawTank keeps MIN_TANK while following.
    function _setTank(address who, uint256 amount) internal {
        uint256 total = hub.totalTanks() - hub.tankOf(who) + amount;
        _store.target(address(hub)).sig("tankOf(address)").with_key(who).checked_write(amount);
        _store.target(address(hub)).sig("totalTanks()").checked_write(total);
    }

    // ---------- follow lifecycle ----------

    function test_follow_trader_opensGroupAndSubscribes() public {
        address predicted = vm.computeCreateAddress(address(hub), vm.getNonce(address(hub)));

        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupOpened(sid, 0, predicted, 1);
        vm.expectEmit(true, true, false, true, address(hub));
        emit CopybookHub.Followed(follower, sid, SourceKind.Trader, uint256(uint160(trader)));
        assertEq(_follow(follower, _policy(), _none()), sid);

        address relay = hub.relayOf(sid, 0);
        assertEq(relay, predicted);
        assertEq(hub.subscriptionOf(sid, 0), 1);
        assertEq(address(GroupRelay(relay).hub()), address(hub));
        assertEq(GroupRelay(relay).sourceId(), sid);
        assertEq(GroupRelay(relay).group(), 0);

        (ISomniaReactivityPrecompile.SubscriptionData memory d, address subOwner) = reactivity.getSubscription(1);
        assertEq(subOwner, address(hub));
        assertEq(d.emitter, address(bank));
        assertEq(d.eventTopics[0], POSITION_UPDATED);
        assertEq(d.eventTopics[1], bytes32(uint256(uint160(trader))));
        assertEq(d.eventTopics[2], bytes32(0));
        assertEq(d.eventTopics[3], bytes32(0));
        assertEq(d.origin, address(0));
        assertEq(d.caller, address(0));
        assertEq(d.handlerContractAddress, relay);
        assertEq(d.handlerFunctionSelector, ISomniaEventHandler.onEvent.selector);
        assertEq(d.priorityFeePerGas, 0);
        assertEq(d.maxFeePerGas, 20 gwei);
        assertEq(d.gasLimit, 200_000_000);
        assertFalse(d.isGuaranteed);
        assertFalse(d.isCoalesced);

        assertEq(hub.tankOf(follower), 0.5 ether);
        assertEq(hub.totalTanks(), 0.5 ether);
        (bytes32 s, SourceKind kind, uint256 ref, Policy memory p, bool paused, uint32 group) = hub.followOf(follower);
        assertEq(s, sid);
        assertEq(uint8(kind), uint8(SourceKind.Trader));
        assertEq(ref, uint256(uint160(trader)));
        assertEq(p.scaleBps, 10_000);
        assertFalse(paused);
        assertEq(group, 0);

        // a second follower of the same trader joins the open group
        _follow(follower2, _policy(), _none());
        assertEq(reactivity.count(), 1);
        address[] memory m = hub.membersOf(sid, 0);
        assertEq(m.length, 2);
        assertEq(m[0], follower);
        assertEq(m[1], follower2);
    }

    function test_follow_joinPools_copiesExistingPosition() public {
        _traderTo(btc, 50_000);

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 0, 50_000, BTC_BUY, false);
        _follow(follower, _policy(), _one(btc));

        assertEq(_size(btc, follower), 50_000);
        address[] memory synced = hub.syncedPools(follower);
        assertEq(synced.length, 1);
        assertEq(synced[0], address(btc));
    }

    function test_secondFollow_reverts() public {
        _follow(follower, _policy(), _none());
        vm.prank(follower);
        vm.expectRevert(CopybookHub.AlreadyFollowing.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(address(0xBEEF))), _policy(), _none());
    }

    function test_follow_belowMinTank_reverts() public {
        vm.prank(follower);
        vm.expectRevert(CopybookHub.TankTooLow.selector);
        hub.follow{value: 0.2 ether - 1}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _none());

        vm.prank(follower);
        hub.follow{value: 0.2 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _none());
        assertEq(hub.tankOf(follower), 0.2 ether);
    }

    function test_follow_rejectsBadInput() public {
        vm.startPrank(follower);
        // no theme 1 exists yet
        vm.expectRevert(CopybookHub.InvalidSource.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Theme, 1, _policy(), _none());

        vm.expectRevert(CopybookHub.InvalidSource.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, 0, _policy(), _none());
        vm.expectRevert(CopybookHub.InvalidSource.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(type(uint160).max) + 1, _policy(), _none());
        vm.expectRevert(CopybookHub.InvalidSource.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(follower)), _policy(), _none());

        Policy memory p = _policy();
        p.bandBps = 0;
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.InvalidPolicy.selector, uint8(4)));
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), p, _none());

        MockPerpPool foreign = new MockPerpPool(bank, 1e18, 1, 1, 1, 1);
        vm.mockCall(address(foreign), abi.encodeWithSignature("marginBank()"), abi.encode(address(0xDEAD)));
        vm.expectRevert(CopybookHub.ForeignPool.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _one(foreign));

        address[] memory many = new address[](hub.MAX_JOIN_POOLS() + 1);
        vm.expectRevert(CopybookHub.TooManyPools.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), many);
        vm.stopPrank();

        // slot 3: riskGate (20 bytes) | followsPaused (byte 20); the admin setter arrives with the admin surface
        vm.store(address(hub), bytes32(uint256(3)), bytes32(uint256(1) << 160));
        assertTrue(hub.followsPaused());
        vm.prank(follower);
        vm.expectRevert(CopybookHub.FollowsPaused.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _none());
    }

    // Regression (R24): joinPools takes only markets the bank itself registered. A contract that merely
    // claims the bank, or a pool the bank never registered, is refused before anything is allowlisted.
    function test_follow_fakePoolClaimingBank_rejected() public {
        address[] memory pools = new address[](2);
        pools[0] = address(btc);
        pools[1] = address(new FakePool(address(bank)));
        vm.startPrank(follower);
        vm.expectRevert(CopybookHub.ForeignPool.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), pools);
        pools[1] = address(new MockPerpPool(bank, 1e18, 1, 1, 1, 1));
        vm.expectRevert(CopybookHub.ForeignPool.selector);
        hub.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), pools);
        vm.stopPrank();
        (bytes32 s,,,,,) = hub.followOf(follower);
        assertEq(s, bytes32(0));
    }

    function test_unfollow_flatten_closesAll() public {
        _traderTo(btc, 50_000);
        _traderTo(eth, -2e16);
        _follow(follower, _policy(), _two(btc, eth));
        _follow(follower2, _policy(), _none());
        assertEq(_size(btc, follower), 50_000);
        assertEq(_size(eth, follower), -2e16);

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 0, BTC_EXIT_SELL, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(eth), -2e16, 0, ETH_EXIT_BUY, false);
        vm.expectEmit(true, true, false, true, address(hub));
        emit CopybookHub.Unfollowed(follower, sid, true);
        vm.prank(follower);
        hub.unfollow(true);

        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);
        (bytes32 s,,,,,) = hub.followOf(follower);
        assertEq(s, bytes32(0));
        assertEq(hub.syncedPools(follower).length, 0);
        assertEq(hub.tankOf(follower), 0.5 ether);
        address[] memory m = hub.membersOf(sid, 0);
        assertEq(m.length, 1);
        assertEq(m[0], follower2);

        vm.prank(follower);
        vm.expectRevert(CopybookHub.NotFollowing.selector);
        hub.unfollow(true);
    }

    function test_unfollow_keep_thenRefollowStartsClean() public {
        _traderTo(btc, 50_000);
        _follow(follower, _policy(), _one(btc));
        address relay = hub.relayOf(sid, 0);

        vm.expectEmit(true, true, false, true, address(hub));
        emit CopybookHub.Unfollowed(follower, sid, false);
        vm.prank(follower);
        hub.unfollow(false);
        assertEq(_size(btc, follower), 50_000);

        // the old allowlist and synced set do not carry over into a new follow;
        // the emptied group is reused with its relay and subscribed again
        _traderTo(btc, 70_000);
        _traderTo(eth, -2e16);
        _follow(follower, _policy(), _one(eth));
        assertEq(hub.relayOf(sid, 0), relay);
        assertEq(reactivity.count(), 2);
        address[] memory synced = hub.syncedPools(follower);
        assertEq(synced.length, 1);
        assertEq(synced[0], address(eth));

        // btc is outside the new allowlist: the hub does not touch it at all
        vm.recordLogs();
        hub.catchUp(follower, _one(btc));
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertEq(_size(btc, follower), 50_000);
    }

    // Regression (review I1): a position the follower kept in a pool its new follow does not allow
    // must not be closed by a stranger through catchUp or by a source event.
    function test_strangerCannotTouchNonAllowlistedPool() public {
        _traderTo(btc, 50_000);
        _follow(follower, _policy(), _one(btc));
        vm.prank(follower);
        hub.unfollow(false);
        assertEq(_size(btc, follower), 50_000);

        _traderTo(eth, -2e16);
        _follow(follower, _policy(), _one(eth)); // allowlist = ETH only
        vm.recordLogs();
        _traderTo(btc, 0);
        Vm.Log memory ev = _positionEvent(vm.getRecordedLogs(), btc);

        vm.recordLogs();
        vm.prank(stranger);
        hub.catchUp(follower, _one(btc));
        _fire(ev);
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertEq(_size(btc, follower), 50_000, "kept position untouched");
    }

    function test_tank_fundAndWithdraw() public {
        _follow(follower, _policy(), _none());
        vm.prank(follower);
        hub.fundTank{value: 1 ether}();
        assertEq(hub.tankOf(follower), 1.5 ether);
        assertEq(hub.totalTanks(), 1.5 ether);

        vm.prank(follower);
        vm.expectRevert(CopybookHub.InsufficientTank.selector);
        hub.withdrawTank(1.5 ether + 1);

        uint256 before = follower.balance;
        vm.prank(follower);
        hub.withdrawTank(1.2 ether);
        assertEq(follower.balance, before + 1.2 ether);
        assertEq(hub.tankOf(follower), 0.3 ether);
        assertEq(hub.totalTanks(), 0.3 ether);
    }

    // ---------- sync rules ----------

    function test_increaseNeverCrossesBand() public {
        // the leader's buy lifts every ask inside the follower's band; what is left sits at mark + 60 bps
        btc.setLiquidity(DEPTH_BTC, DEPTH_BTC, 60);
        _traderTo(btc, 50_000);

        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(
            follower,
            sid,
            address(btc),
            Reason.BandUnfilled,
            abi.encodeWithSelector(MockPerpPool.FillOrKillNotFilled.selector)
        );
        _follow(follower, _policy(), _one(btc));
        assertEq(_size(btc, follower), 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CopybookHub.Copied.selector, "no copy beyond band");
        }

        // liquidity back inside the band: the same increase fills at the band limit, never above it
        btc.setLiquidity(DEPTH_BTC, DEPTH_BTC, 10);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 0, 50_000, BTC_BUY, false);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 50_000);
        assertLe(BTC_BUY, uint256(80_000e18) * (1e4 + 50) / 1e4);
    }

    function test_reductionIgnoresTankAndCaps() public {
        _traderTo(btc, 50_000);
        _follow(follower, _policy(), _one(btc));
        assertEq(_size(btc, follower), 50_000);

        _setTank(follower, 0);
        assertEq(hub.tankOf(follower), 0);

        Policy memory strict = _policy();
        strict.maxNotional = 1e18;
        strict.maxTotalNotional = 1e18;
        vm.prank(follower);
        hub.updatePolicy(strict);

        _traderTo(btc, 0);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 0, BTC_EXIT_SELL, false);
        vm.prank(stranger);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    function test_reductionGoesThroughWhilePaused() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _traderTo(btc, 50_000);
        _follow(follower, p, _one(btc));

        // a failed exit leaves the position open while the follow is stopped
        btc.setRevertFor(follower, abi.encodeWithSignature("Busy()"));
        bank.setEquity(follower, 10e18);
        hub.poke(follower);
        assertTrue(_paused(follower));
        assertEq(_size(btc, follower), 50_000);

        btc.setRevertFor(follower, "");
        _traderTo(btc, 20_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 20_000, BTC_EXIT_SELL, false);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 20_000);
    }

    function test_notionalClampFlagsCapped() public {
        Policy memory p = _policy();
        p.maxNotional = 20e18; // 25_000 units at 80_000
        _traderTo(btc, 50_000);

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 0, 25_000, BTC_BUY, true);
        _follow(follower, p, _one(btc));
        assertEq(_size(btc, follower), 25_000);

        // the source adds more: the follower is already at the cap, nothing is sent
        _traderTo(btc, 90_000);
        vm.recordLogs();
        hub.catchUp(follower, _one(btc));
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertEq(_size(btc, follower), 25_000);
    }

    function test_totalCap_refusesIncrease() public {
        Policy memory p = _policy();
        p.maxTotalNotional = 60e18;
        _traderTo(btc, 50_000); // 40e18 at mark
        _follow(follower, p, _two(btc, eth));
        assertEq(_size(btc, follower), 50_000);

        _traderTo(eth, -2e16); // 46e18 more would take the book to 86e18
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(eth), Reason.TotalCap, "");
        hub.catchUp(follower, _one(eth));
        assertEq(_size(eth, follower), 0);

        // a mark that cannot be read on another synced pool fails the cap closed
        p.maxTotalNotional = 1_000e18;
        vm.prank(follower);
        hub.updatePolicy(p);
        vm.mockCallRevert(address(btc), abi.encodeWithSignature("getMarkPrice()"), "");
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(eth), Reason.TotalCap, "");
        hub.catchUp(follower, _one(eth));
        vm.clearMockedCalls();

        hub.catchUp(follower, _one(eth));
        assertEq(_size(eth, follower), -2e16);
    }

    function test_dustTrimSkipped_fullExitExact() public {
        Policy memory half = _policy();
        half.scaleBps = 5_000;
        _traderTo(btc, 60_000);
        _follow(follower, half, _one(btc));
        assertEq(_size(btc, follower), 30_000);

        // target 20_000: a 10_000 trim is below the 13_000 venue minimum
        _traderTo(btc, 40_000);
        vm.recordLogs();
        hub.catchUp(follower, _one(btc));
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertEq(_size(btc, follower), 30_000);

        _traderTo(btc, 0);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    function test_tankEmpty_refusesIncrease() public {
        _follow(follower, _policy(), _one(btc));
        _setTank(follower, 0.02 ether - 1);
        _traderTo(btc, 50_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.TankEmpty, "");
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    function test_riskGate_blocksIncreasesOnly() public {
        FlagGate gate = new FlagGate();
        _store.target(address(hub)).sig("riskGate()").checked_write(address(gate));
        assertEq(hub.riskGate(), address(gate));
        _traderTo(btc, 50_000);

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.RiskGate, "");
        _follow(follower, _policy(), _one(btc));
        assertEq(_size(btc, follower), 0);

        // a reverting gate fails closed
        gate.set(true, true);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.RiskGate, "");
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);

        gate.set(true, false);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 50_000);

        // the gate never blocks the way out
        gate.set(false, true);
        _traderTo(btc, 0);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    function test_unreadableHealth_refusesIncreaseWithoutStop() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _follow(follower, p, _none());
        _traderTo(btc, 50_000);

        vm.mockCallRevert(address(bank), abi.encodeWithSignature("getAccountHealth(address)", follower), "");
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.VenueRejected, "");
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);
        assertFalse(_paused(follower));
    }

    function test_fokWithoutFill_isBandUnfilled() public {
        _follow(follower, _policy(), _none());
        _traderTo(btc, 50_000);
        bytes4 place = IPerpPool.placeOrderFor.selector;

        // the venue reports failure without reverting
        vm.mockCall(address(btc), abi.encodePacked(place), abi.encode(false, uint128(0)));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.BandUnfilled, "");
        hub.catchUp(follower, _one(btc));

        // the venue reports success but the position did not move
        vm.mockCall(address(btc), abi.encodePacked(place), abi.encode(true, uint128(1)));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.BandUnfilled, "");
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);
        vm.clearMockedCalls();
    }

    function test_venueRevert_reportedWithBytes() public {
        bytes memory err = abi.encodeWithSignature("InsufficientCollateral()");
        btc.setRevertFor(follower, err);
        _traderTo(btc, 50_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.VenueRejected, err);
        _follow(follower, _policy(), _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    function test_zeroMark_refusesWithoutDividing() public {
        _traderTo(btc, 50_000);
        btc.setMark(0);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.VenueRejected, "");
        _follow(follower, _policy(), _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    function test_revertingMark_refusesWithoutReverting() public {
        _traderTo(btc, 50_000);
        bytes memory stale = abi.encodeWithSignature("StalePrice()");
        vm.mockCallRevert(address(btc), abi.encodeWithSignature("getMarkPrice()"), stale);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.VenueRejected, stale);
        _follow(follower, _policy(), _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    // ---------- equity floor ----------

    function test_poke_belowFloor_flattensAndPauses() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _traderTo(btc, 50_000);
        _traderTo(eth, -2e16);
        _follow(follower, p, _two(btc, eth));
        assertEq(_size(btc, follower), 50_000);
        assertEq(_size(eth, follower), -2e16);

        bank.setEquity(follower, 40e18);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 0, BTC_EXIT_SELL, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(eth), -2e16, 0, ETH_EXIT_BUY, false);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.Stopped(follower, 40e18);
        vm.prank(stranger);
        hub.poke(follower);

        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);
        assertTrue(_paused(follower));

        // paused: increases are refused, even once equity recovers
        bank.setEquity(follower, 100e18);
        _traderTo(btc, 70_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.Paused, "");
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);
    }

    function test_poke_aboveFloor_noop() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 50e18);
        _traderTo(btc, 50_000);
        _follow(follower, p, _one(btc));

        vm.recordLogs();
        hub.poke(follower);
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertEq(_size(btc, follower), 50_000);
        assertFalse(_paused(follower));

        // floor 0 disables the stop entirely
        p.equityFloor = 0;
        vm.prank(follower);
        hub.updatePolicy(p);
        bank.setEquity(follower, -1);
        vm.recordLogs();
        hub.poke(follower);
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertFalse(_paused(follower));

        vm.expectRevert(CopybookHub.NotFollowing.selector);
        hub.poke(stranger);
    }

    function test_increaseBelowFloor_stopsInsteadOfCopying() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _traderTo(btc, 50_000);
        _follow(follower, p, _two(btc, eth));

        bank.setEquity(follower, 10e18);
        _traderTo(eth, -2e16);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(eth), Reason.EquityFloor, "");
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 0, BTC_EXIT_SELL, false);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.Stopped(follower, 10e18);
        hub.catchUp(follower, _one(eth));
        assertEq(_size(btc, follower), 0);
        assertEq(_size(eth, follower), 0);
        assertTrue(_paused(follower));
    }

    // ---------- catch-up ----------

    function test_catchUp_onlyMovesTowardSource() public {
        _traderTo(btc, 50_000);
        _traderTo(eth, -2e16);
        _follow(follower, _policy(), _one(btc));
        assertEq(_size(btc, follower), 50_000);

        // the source adds; eth is outside the follower's allowlist and is left alone
        _traderTo(btc, 80_000);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 80_000, BTC_BUY, false);
        vm.prank(stranger);
        hub.catchUp(follower, _two(btc, eth));
        assertEq(_hubLogs(vm.getRecordedLogs()), 1);
        assertEq(_size(btc, follower), 80_000);
        assertEq(_size(eth, follower), 0);

        // already at target: nothing to do
        vm.recordLogs();
        hub.catchUp(follower, _one(btc));
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);

        // the follower drifted above target: catch-up brings it back, not further
        _move(btc, follower, 100_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 100_000, 80_000, BTC_EXIT_SELL, false);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 80_000);

        // the source trims
        _traderTo(btc, 30_000);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 30_000);

        // the source flips: close at the exit band, then open the other side inside the band
        _traderTo(btc, -20_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 30_000, -20_000, BTC_SELL, false);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), -20_000);

        // a full exit closes exactly
        _traderTo(btc, 0);
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 0);

        vm.expectRevert(CopybookHub.NotFollowing.selector);
        hub.catchUp(stranger, _one(btc));
    }

    // ---------- reactive path ----------

    function test_reactive_fireThroughRelayCopies() public {
        _follow(follower, _policy(), _none());
        Policy memory half = _policy();
        half.scaleBps = 5_000;
        _follow(follower2, half, _none());
        uint256 subId = hub.subscriptionOf(sid, 0);

        vm.recordLogs();
        _traderTo(btc, 50_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory ev;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bank) && logs[i].topics[0] == POSITION_UPDATED) ev = logs[i];
        }
        assertEq(ev.topics[1], bytes32(uint256(uint160(trader))));

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 0, 50_000, BTC_BUY, false);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower2, sid, address(btc), 0, 25_000, BTC_BUY, false);
        reactivity.fire(subId, ev.emitter, ev.topics, ev.data);

        assertEq(_size(btc, follower), 50_000);
        assertEq(_size(btc, follower2), 25_000);
        assertEq(hub.syncedPools(follower).length, 1);
    }

    function test_reactive_onlyRelayAndPrecompile() public {
        _follow(follower, _policy(), _none());
        address relay = hub.relayOf(sid, 0);
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = POSITION_UPDATED;
        topics[1] = bytes32(uint256(uint160(trader)));
        topics[2] = bytes32(uint256(uint160(address(btc))));
        bytes memory data = abi.encode(int128(50_000), uint128(0), int256(0), int256(0));

        vm.expectRevert(CopybookHub.NotRelay.selector);
        hub.onSourceEvent(sid, 0, address(bank), topics, data);
        vm.prank(relay);
        vm.expectRevert(CopybookHub.NotRelay.selector);
        hub.onSourceEvent(sid, 1, address(bank), topics, data);

        vm.expectRevert(SomniaEventHandler.OnlyReactivityPrecompile.selector);
        GroupRelay(relay).onEvent(address(bank), topics, data);

        // an event for a different account or emitter is rejected even through the relay
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(sid, 0, address(0xBAD), topics, data);
        topics[1] = bytes32(uint256(uint160(stranger)));
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(sid, 0, address(bank), topics, data);

        // wrong event signature
        topics[1] = bytes32(uint256(uint160(trader)));
        topics[0] = keccak256("Other(address,address)");
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(sid, 0, address(bank), topics, data);

        // too few topics to name a pool
        bytes32[] memory short = new bytes32[](2);
        short[0] = POSITION_UPDATED;
        short[1] = bytes32(uint256(uint160(trader)));
        vm.prank(relay);
        vm.expectRevert(CopybookHub.BadEvent.selector);
        hub.onSourceEvent(sid, 0, address(bank), short, data);
    }

    // Regression (review I2): the event only names the pool; the size comes from the trader's live position.
    function test_staleEventUsesLiveTraderSize() public {
        _follow(follower, _policy(), _none());
        vm.recordLogs();
        _traderTo(btc, 50_000);
        Vm.Log memory ev = _positionEvent(vm.getRecordedLogs(), btc);
        _traderTo(btc, 0); // the trader is out again before the first handler runs

        vm.recordLogs();
        _fire(ev);
        assertEq(_hubLogs(vm.getRecordedLogs()), 0);
        assertEq(_size(btc, follower), 0, "no position opened against a flat source");
    }

    function test_reactive_reducesWhilePausedWithEmptyTank() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _traderTo(btc, 50_000);
        _follow(follower, p, _one(btc));

        // the stop's exit fails, so the follow is paused with the position still open
        btc.setRevertFor(follower, abi.encodeWithSignature("Busy()"));
        bank.setEquity(follower, 10e18);
        hub.poke(follower);
        assertTrue(_paused(follower));
        btc.setRevertFor(follower, "");
        _setTank(follower, 0);

        vm.recordLogs();
        _traderTo(btc, 0);
        Vm.Log memory ev = _positionEvent(vm.getRecordedLogs(), btc);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, 0, BTC_EXIT_SELL, false);
        _fire(ev);
        assertEq(_size(btc, follower), 0);
    }

    // ---------- price band rounding ----------

    function test_increaseRoundsInsideBand_offTick() public {
        uint256 m = 80_000_070_000_000_000_000_000; // mark off the 1e17 tick
        btc.setMark(m);
        _traderTo(btc, 50_000);

        // bid limit: mark * 1.005 = 80_400.07035 floors to 80_400.0, never above
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 0, 50_000, 80_400e18, false);
        _follow(follower, _policy(), _one(btc));
        assertLe(uint256(80_400e18) * 1e4, m * (1e4 + 50));

        // ask limit on the flip: mark * 0.995 = 79_600.06965 ceils to 79_600.1, never below
        uint256 ask = 79_600_100_000_000_000_000_000;
        _traderTo(btc, -50_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(btc), 50_000, -50_000, ask, false);
        hub.catchUp(follower, _one(btc));
        assertGe(ask * 1e4, m * (1e4 - 50));
    }

    // ---------- resume ----------

    function test_resume_requiresEquityAtFloor() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _traderTo(btc, 50_000);
        _follow(follower, p, _one(btc));
        bank.setEquity(follower, 40e18);
        hub.poke(follower);
        assertTrue(_paused(follower));
        assertEq(_size(btc, follower), 0);

        vm.prank(follower);
        vm.expectRevert(CopybookHub.StillBelowFloor.selector);
        hub.resume();
        assertTrue(_paused(follower));

        bank.setEquity(follower, 50e18);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.Resumed(follower);
        vm.prank(follower);
        hub.resume();
        assertFalse(_paused(follower));

        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 50_000);

        vm.prank(stranger);
        vm.expectRevert(CopybookHub.NotFollowing.selector);
        hub.resume();
    }

    function test_resume_floorDisabled() public {
        Policy memory p = _policy();
        p.equityFloor = 50e18;
        bank.setEquity(follower, 100e18);
        _follow(follower, p, _none());
        bank.setEquity(follower, -1);
        hub.poke(follower);
        assertTrue(_paused(follower));

        p.equityFloor = 0;
        vm.prank(follower);
        hub.updatePolicy(p);
        assertTrue(_paused(follower));

        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.Resumed(follower);
        vm.prank(follower);
        hub.resume();
        assertFalse(_paused(follower));
    }

    // ---------- venue robustness ----------

    function test_unreadableBookParams_refusedNotReverted() public {
        _traderTo(btc, 50_000);
        _follow(follower, _policy(), _one(btc));
        bytes memory err = abi.encodeWithSignature("Halted()");

        vm.mockCallRevert(address(btc), abi.encodeWithSignature("getOrderBookParameters()"), err);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.VenueRejected, err);
        vm.expectEmit(true, true, false, true, address(hub));
        emit CopybookHub.Unfollowed(follower, sid, false);
        vm.prank(follower);
        hub.unfollow(true);
        assertEq(_size(btc, follower), 50_000);
        vm.clearMockedCalls();

        vm.mockCallRevert(address(btc), abi.encodeWithSignature("getOneBase()"), err);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower2, sid, address(btc), Reason.VenueRejected, err);
        _follow(follower2, _policy(), _one(btc));
        assertEq(_size(btc, follower2), 0);
        vm.clearMockedCalls();
    }

    function test_unfollow_flatten_unclosablePool_reportsNotFlattened() public {
        _traderTo(btc, 50_000);
        _traderTo(eth, -2e16);
        _follow(follower, _policy(), _two(btc, eth));
        bytes memory err = abi.encodeWithSignature("InsufficientCollateral()");
        btc.setRevertFor(follower, err);

        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.VenueRejected, err);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Copied(follower, sid, address(eth), -2e16, 0, ETH_EXIT_BUY, false);
        vm.expectEmit(true, true, false, true, address(hub));
        emit CopybookHub.Unfollowed(follower, sid, false);
        vm.prank(follower);
        hub.unfollow(true);
        assertEq(_size(btc, follower), 50_000);
        assertEq(_size(eth, follower), 0);
        (bytes32 s,,,,,) = hub.followOf(follower);
        assertEq(s, bytes32(0));
    }

    function test_iocSuccessWithoutFill_isBandUnfilled() public {
        _traderTo(btc, 50_000);
        _follow(follower, _policy(), _one(btc));
        _traderTo(btc, 0);

        vm.mockCall(address(btc), abi.encodePacked(IPerpPool.placeOrderFor.selector), abi.encode(true, uint128(1)));
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(follower, sid, address(btc), Reason.BandUnfilled, "");
        hub.catchUp(follower, _one(btc));
        assertEq(_size(btc, follower), 50_000);
        vm.clearMockedCalls();
    }

    function test_follow_hubBelowSubscriptionBalance_reverts() public {
        CopybookHub poor = new CopybookHub(IMarginBank(address(bank)), themes, 8, owner);
        vm.deal(address(poor), 31 ether);
        vm.prank(follower);
        vm.expectRevert(MockReactivity.InsufficientBalance.selector);
        poor.follow{value: 0.5 ether}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _none());
    }

    // The engine's books keep the hub's original slots: follows 11, synced 12, epoch 13, isSynced 14,
    // allowed 15 (per-follower mappings keyed by the follower address).
    function test_storageLayout_booksKeepSlots() public {
        _traderTo(btc, 50_000);
        _follow(follower, _policy(), _one(btc));
        bytes32 key = bytes32(uint256(uint160(follower)));
        assertEq(vm.load(address(hub), keccak256(abi.encode(key, uint256(11)))), sid, "follows.sourceId");
        assertEq(uint256(vm.load(address(hub), keccak256(abi.encode(key, uint256(12))))), 1, "synced.length");
        bytes32 isSynced = keccak256(abi.encode(uint256(0), keccak256(abi.encode(key, uint256(14)))));
        bytes32 allowed = keccak256(abi.encode(uint256(0), keccak256(abi.encode(key, uint256(15)))));
        assertEq(uint256(vm.load(address(hub), keccak256(abi.encode(address(btc), isSynced)))), 1, "isSynced");
        assertEq(uint256(vm.load(address(hub), keccak256(abi.encode(address(btc), allowed)))), 1, "allowed");
        vm.prank(follower);
        hub.unfollow(false);
        assertEq(uint256(vm.load(address(hub), keccak256(abi.encode(key, uint256(13))))), 1, "epoch");
        assertEq(uint256(vm.load(address(hub), keccak256(abi.encode(sid, uint256(16))))), 1, "groupCount after");
    }

    function test_withdrawTank_reentryBlocked() public {
        TankReentrant attacker = new TankReentrant(hub);
        attacker.fund{value: 1 ether}();
        attacker.withdraw(0.5 ether);

        assertFalse(attacker.reentered());
        assertEq(bytes4(attacker.innerError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(hub.tankOf(address(attacker)), 0.5 ether);
        assertEq(hub.totalTanks(), 0.5 ether);
        assertEq(address(attacker).balance, 0.5 ether);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base} from "./Base.t.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {MockReactivity} from "./mocks/MockReactivity.sol";
import {CopybookHub} from "../src/CopybookHub.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {Policy, Reason, SourceKind} from "../src/Types.sol";
import {IMarginBank, IRiskGate} from "../src/interfaces/IDreamPerps.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";

contract SwitchGate is IRiskGate {
    bool public allow;

    function set(bool allow_) external {
        allow = allow_;
    }

    function allowIncrease(bytes32, address) external view returns (bool) {
        return allow;
    }
}

/// Answers `true` only after spending `need` gas; with less it reverts.
contract HungryGate is IRiskGate {
    uint256 public immutable need;

    constructor(uint256 need_) {
        need = need_;
    }

    function allowIncrease(bytes32, address) external view returns (bool) {
        uint256 stop = gasleft() - need;
        while (gasleft() > stop) {}
        return true;
    }
}

contract RefusingReceiver {
    receive() external payable {
        revert("no");
    }
}

contract HubAdminTest is Base {
    bytes32 internal constant POSITION_UPDATED = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;
    uint256 internal constant TANK = 0.5 ether;
    uint256 internal constant MAX_GAS = 200_000_000;

    CopybookHub internal hub;
    ThemeRegistry internal themes;

    address internal owner = address(0x0A11);
    address internal trader = address(0x7AD3);
    address internal trader2 = address(0x7AD4);
    address internal stranger = address(0x5EE);

    bytes32 internal sid;

    function setUp() public override {
        super.setUp();
        themes = new ThemeRegistry(address(bank));
        hub = new CopybookHub(IMarginBank(address(bank)), themes, 8, owner);
        vm.deal(address(hub), 40 ether);
        btc.approve(trader, address(this));
        btc.approve(trader2, address(this));
        btc.setLiquidity(10_000_000, 10_000_000, 10);
        eth.setLiquidity(10e18, 10e18, 10);
        sid = hub.sourceIdOf(SourceKind.Trader, uint256(uint160(trader)));
    }

    // ---------- helpers ----------

    function _f(uint256 i) internal pure returns (address) {
        return address(uint160(0xF000 + i));
    }

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

    function _follow(address who, address source) internal {
        vm.deal(who, 1 ether);
        btc.approve(who, address(hub));
        eth.approve(who, address(hub));
        vm.prank(who);
        hub.follow{value: TANK}(SourceKind.Trader, uint256(uint160(source)), _policy(), _none());
    }

    function _move(MockPerpPool pool, address account, int256 target) internal {
        int256 d = target - _size(pool, account);
        if (d == 0) return;
        bool bid = d > 0;
        uint256 price = (bid ? pool.mark() * 11 / 10 : pool.mark() * 9 / 10) / pool.tick() * pool.tick();
        pool.placeOrderFor(account, bid, 0, price, uint256(bid ? d : -d), type(uint64).max, 2, 0, address(0), 0);
    }

    function _topics(address source, MockPerpPool pool) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](3);
        t[0] = POSITION_UPDATED;
        t[1] = bytes32(uint256(uint160(source)));
        t[2] = bytes32(uint256(uint160(address(pool))));
    }

    function _fire(uint256 subId, address source, MockPerpPool pool) internal {
        vm.prank(address(this), address(hub)); // the hub's own subscription: the hub is the origin
        reactivity.fire(subId, address(bank), _topics(source, pool), "");
    }

    function _size(MockPerpPool pool, address account) internal view returns (int256) {
        return bank.getPosition(account, address(pool)).size;
    }

    function _paused(address who) internal view returns (bool paused) {
        (,,,, paused,) = hub.followOf(who);
    }

    function _subOf(uint256 id) internal view returns (ISomniaReactivityPrecompile.SubscriptionData memory d) {
        (d,) = reactivity.getSubscriptionInfo(id);
    }

    function _unauthorized(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    // ---------- access ----------

    function test_admin_onlyOwner() public {
        _follow(_f(1), trader);
        vm.startPrank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        hub.setRiskGate(address(1));
        vm.expectRevert(_unauthorized(stranger));
        hub.setSubParams(0, 20 gwei, 1, 1, false);
        vm.expectRevert(_unauthorized(stranger));
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 2_000_000);
        vm.expectRevert(_unauthorized(stranger));
        hub.pauseNewFollows(true);
        vm.expectRevert(_unauthorized(stranger));
        hub.withdrawSurplus(stranger, 1);
        vm.expectRevert(_unauthorized(stranger));
        hub.cancelOrphan(1);
        vm.expectRevert(_unauthorized(stranger));
        hub.forceResubscribe(sid, 0);
        vm.stopPrank();
    }

    // R31: ownership cannot be renounced, so the admin surface stays reachable; it still moves in two steps.
    function test_renounceOwnership_disabled() public {
        vm.prank(owner);
        vm.expectRevert(CopybookHub.RenounceDisabled.selector);
        hub.renounceOwnership();
        assertEq(hub.owner(), owner);
        vm.prank(owner);
        hub.transferOwnership(stranger);
        assertEq(hub.owner(), owner);
        vm.prank(stranger);
        hub.acceptOwnership();
        assertEq(hub.owner(), stranger);
    }

    // ---------- risk gate ----------

    function test_setRiskGate_gatesIncreasesOnly() public {
        address a = _f(1);
        _follow(a, trader);
        SwitchGate gate = new SwitchGate();

        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.RiskGateSet(address(gate));
        vm.prank(owner);
        hub.setRiskGate(address(gate));
        assertEq(hub.riskGate(), address(gate));

        _move(btc, trader, 50_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(a, sid, address(btc), Reason.RiskGate, "");
        hub.catchUp(a, _one(btc));
        assertEq(_size(btc, a), 0);

        vm.prank(owner);
        hub.setRiskGate(address(0));
        hub.catchUp(a, _one(btc));
        assertEq(_size(btc, a), 50_000);

        // a closed gate never holds a reduction
        vm.prank(owner);
        hub.setRiskGate(address(gate));
        _move(btc, trader, 0);
        hub.catchUp(a, _one(btc));
        assertEq(_size(btc, a), 0);
    }

    // R29: the gate must be a contract (address(0) turns it off).
    function test_setRiskGate_rejectsAccountsWithoutCode() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(1)));
        hub.setRiskGate(address(0xBEEF));
        hub.setRiskGate(address(new SwitchGate()));
        hub.setRiskGate(address(0));
        vm.stopPrank();
        assertEq(hub.riskGate(), address(0));
    }

    // ---------- subscription parameters ----------

    // R30/R31/R39: fees capped at MAX_FEE_PER_GAS with room for the 6 gwei base fee; the trader gas limit in
    // 40M..200M and the theme one in 120M..200M, so a member's exits always fit; and both enough for the
    // handler's floor and tail reserve.
    function test_setSubParams_bounds() public {
        uint64 trader = 40_000_000;
        uint64 theme = 120_000_000;
        vm.startPrank(owner);
        assertEq(hub.MAX_FEE_PER_GAS(), 100 gwei);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(2)));
        hub.setSubParams(0, 100 gwei + 1, trader, theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(2)));
        hub.setSubParams(0, 6 gwei - 1, trader, theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(2)));
        hub.setSubParams(type(uint64).max - 6 gwei, type(uint64).max, trader, theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(1)));
        hub.setSubParams(1 gwei, 7 gwei - 1, trader, theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(1)));
        hub.setSubParams(94 gwei + 1, 100 gwei, trader, theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(3)));
        hub.setSubParams(0, 20 gwei, uint64(MAX_GAS + 1), theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(3)));
        hub.setSubParams(0, 20 gwei, trader - 1, theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(3)));
        hub.setSubParams(0, 20 gwei, 0, theme, false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(4)));
        hub.setSubParams(0, 20 gwei, trader, uint64(MAX_GAS + 1), false);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(4)));
        hub.setSubParams(0, 20 gwei, trader, theme - 1, false);

        // the edges are accepted
        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.SubParamsSet(94 gwei, 100 gwei, trader, uint64(MAX_GAS), true);
        hub.setSubParams(94 gwei, 100 gwei, trader, uint64(MAX_GAS), true);
        hub.setSubParams(0, 6 gwei, trader, theme, false);
        (uint64 prio, uint64 maxFee, uint64 traderGas, uint64 themeGas, bool guaranteed) = hub.subParams();
        assertEq(prio, 0);
        assertEq(maxFee, 6 gwei);
        assertEq(traderGas, trader);
        assertEq(themeGas, theme);
        assertFalse(guaranteed);

        // with a larger handler budget the floor and tail reserve must still fit: 40M + 1.1M + 20k + 2M
        hub.setSubParams(0, 20 gwei, uint64(MAX_GAS), uint64(MAX_GAS), false);
        hub.setGasParams(40_000_000, 40_000_000, 40_000_000, 1_100_000, 20_000, 300_000, 2_000_000);
        vm.expectRevert(CopybookHub.GasLimitTooLow.selector);
        hub.setSubParams(0, 20 gwei, 43_119_999, theme, false);
        hub.setSubParams(0, 20 gwei, 43_120_000, 120_000_000, false);
        vm.stopPrank();
    }

    // Regression (review I2): no fee ceiling let the owner set a live group's priority fee to ~2^64 wei per gas
    // through forceResubscribe. The ceiling now refuses it, so the live group keeps sane fees.
    function test_feeCeiling_keepsLiveGroupFees() public {
        _follow(_f(1), trader);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(2)));
        hub.setSubParams(type(uint64).max - 6 gwei, type(uint64).max, 200_000_000, 200_000_000, true);
        hub.forceResubscribe(sid, 0);
        vm.stopPrank();
        ISomniaReactivityPrecompile.SubscriptionData memory d = _subOf(hub.subscriptionOf(sid, 0));
        assertEq(d.priorityFeePerGas, 0);
        assertEq(d.maxFeePerGas, 20 gwei);
        assertLe(d.maxFeePerGas, hub.MAX_FEE_PER_GAS());
    }

    // New parameters reach groups opened or subscribed again afterwards; a live subscription keeps its own.
    function test_setSubParams_appliesToLaterSubscriptions() public {
        _follow(_f(1), trader); // group 0 of trader: subscription 1
        vm.prank(owner);
        hub.setSubParams(2 gwei, 30 gwei, 150_000_000, 120_000_000, true);

        ISomniaReactivityPrecompile.SubscriptionData memory d = _subOf(1);
        assertEq(d.maxFeePerGas, 20 gwei, "live subscription unchanged");
        assertEq(d.gasLimit, MAX_GAS);

        _follow(_f(2), trader2); // a new source: subscription 2
        d = _subOf(2);
        assertEq(d.priorityFeePerGas, 2 gwei);
        assertEq(d.maxFeePerGas, 30 gwei);
        assertEq(d.gasLimit, 150_000_000);
        assertTrue(d.isGuaranteed);

        // the trader's emptied group, reused: subscribed again with the new parameters
        vm.prank(_f(1));
        hub.unfollow(false);
        _follow(_f(3), trader);
        assertEq(hub.subscriptionOf(sid, 0), 3);
        assertEq(_subOf(3).gasLimit, 150_000_000);
    }

    // ---------- handler gas parameters ----------

    function test_setGasParams_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(1)));
        hub.setGasParams(999_999, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(2)));
        hub.setGasParams(8_000_000, 7_999_999, 90_000_000, 1_200_000, 30_000, 300_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(2)));
        hub.setGasParams(8_000_000, uint64(MAX_GAS + 1), 90_000_000, 1_200_000, 30_000, 300_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(3)));
        hub.setGasParams(8_000_000, 20_000_000, 7_999_999, 1_200_000, 30_000, 300_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(3)));
        hub.setGasParams(8_000_000, 20_000_000, uint64(MAX_GAS + 1), 1_200_000, 30_000, 300_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(4)));
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_099_999, 30_000, 300_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(5)));
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 19_999, 300_000, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(6)));
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 19_999, 2_000_000);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(6)));
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 2_000_001, 2_000_000);
        // the subscriptions' 200M gas limits must still fund floor + tail + one deferral + 2M
        vm.expectRevert(CopybookHub.GasLimitTooLow.selector);
        hub.setGasParams(196_880_001, uint64(MAX_GAS), uint64(MAX_GAS), 1_100_000, 20_000, 300_000, 2_000_000);
        hub.setGasParams(196_880_000, uint64(MAX_GAS), uint64(MAX_GAS), 1_100_000, 20_000, 300_000, 2_000_000);

        // the edges are accepted
        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.GasParamsSet(1_000_000, 1_000_000, uint64(MAX_GAS), 1_100_000, 20_000, 20_000, 2_000_000);
        hub.setGasParams(1_000_000, 1_000_000, uint64(MAX_GAS), 1_100_000, 20_000, 20_000, 2_000_000);
        hub.setGasParams(1_000_000, 1_000_000, uint64(MAX_GAS), 1_100_000, 20_000, 2_000_000, 2_000_000);
        vm.stopPrank();
        (uint64 floor, uint64 cap, uint64 themeCap, uint64 tailBase, uint64 perDefer, uint64 overhead,) =
            hub.gasParams();
        assertEq(floor, 1_000_000);
        assertEq(cap, 1_000_000);
        assertEq(themeCap, MAX_GAS);
        assertEq(tailBase, 1_100_000);
        assertEq(perDefer, 20_000);
        assertEq(overhead, 2_000_000);
    }

    // R32: the fixed charge overhead is a gas parameter (default 300k), billed on top of measured gas.
    function test_chargeOverhead_isTunable() public {
        (,,,,, uint64 overhead,) = hub.gasParams();
        assertEq(overhead, 300_000);
        address a = _f(1);
        _follow(a, trader);
        address[] memory eth1 = new address[](1);
        eth1[0] = address(eth);
        vm.deal(_f(2), 1 ether);
        vm.prank(_f(2));
        hub.follow{value: TANK}(SourceKind.Trader, uint256(uint160(trader)), _policy(), eth1);
        vm.fee(6 gwei);
        // a BTC event: nothing to do for the ETH-only follower, so it pays the overhead alone, silently
        _move(btc, trader, 50_000);
        uint256 t0 = hub.tankOf(_f(2));
        _fire(1, trader, btc);
        assertEq(t0 - hub.tankOf(_f(2)), 300_000 * 6 gwei);

        vm.prank(owner);
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 1_000_000, 2_000_000);
        _move(btc, trader, 80_000);
        t0 = hub.tankOf(_f(2));
        _fire(1, trader, btc);
        assertEq(t0 - hub.tankOf(_f(2)), 1_000_000 * 6 gwei);
    }

    // The handler runs on the new budget at once: a floor above what the event brings defers the group.
    function test_setGasParams_appliesToHandler() public {
        address a = _f(1);
        _follow(a, trader);
        _move(btc, trader, 50_000);
        vm.prank(owner);
        hub.setGasParams(150_000_000, 150_000_000, 150_000_000, 1_100_000, 20_000, 300_000, 2_000_000);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupDeferred(sid, 0, 0);
        vm.prank(address(this), address(hub));
        reactivity.fire{gas: 100_000_000}(1, address(bank), _topics(trader, btc), "");
        assertEq(_size(btc, a), 0);

        vm.prank(owner);
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 2_000_000);
        vm.prank(address(this), address(hub));
        reactivity.fire{gas: 100_000_000}(1, address(bank), _topics(trader, btc), "");
        assertEq(_size(btc, a), 50_000);
    }

    // The risk gate's budget is a gas parameter (default 2M, 200k..5M): a gate that needs more than it is given
    // refuses the increase, and a larger budget lets it answer.
    function test_riskGateGas_isTunable() public {
        (,,,,,, uint64 gateGas) = hub.gasParams();
        assertEq(gateGas, 2_000_000);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(7)));
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 199_999);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(7)));
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 5_000_001);
        hub.setRiskGate(address(new HungryGate(3_000_000)));
        vm.stopPrank();

        address a = _f(1);
        _follow(a, trader);
        _move(btc, trader, 50_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(a, sid, address(btc), Reason.RiskGate, "");
        hub.catchUp(a, _one(btc));
        assertEq(_size(btc, a), 0);

        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.GasParamsSet(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 4_000_000);
        vm.prank(owner);
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 4_000_000);
        hub.catchUp(a, _one(btc));
        assertEq(_size(btc, a), 50_000);

        // the edges are accepted
        vm.startPrank(owner);
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 200_000);
        hub.setGasParams(8_000_000, 20_000_000, 90_000_000, 1_200_000, 30_000, 300_000, 5_000_000);
        vm.stopPrank();
        (,,,,,, gateGas) = hub.gasParams();
        assertEq(gateGas, 5_000_000);
    }

    // ---------- pause ----------

    // Pausing blocks new follows only: existing follows keep syncing both ways, and can leave, resume and
    // withdraw.
    function test_pauseNewFollows_blocksFollowOnly() public {
        address a = _f(1);
        _follow(a, trader);
        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.NewFollowsPaused(true);
        vm.prank(owner);
        hub.pauseNewFollows(true);
        assertTrue(hub.followsPaused());

        address b = _f(2);
        vm.deal(b, 1 ether);
        vm.prank(b);
        vm.expectRevert(CopybookHub.FollowsPaused.selector);
        hub.follow{value: TANK}(SourceKind.Trader, uint256(uint160(trader)), _policy(), _none());

        _move(btc, trader, 50_000);
        _fire(1, trader, btc);
        assertEq(_size(btc, a), 50_000, "event increase");
        _move(btc, trader, 30_000);
        hub.catchUp(a, _one(btc));
        assertEq(_size(btc, a), 30_000, "catchUp reduction");

        Policy memory p = _policy();
        p.equityFloor = 10e18;
        vm.prank(a);
        hub.updatePolicy(p);
        hub.poke(a);
        assertTrue(_paused(a), "poke stops");
        assertEq(_size(btc, a), 0);
        bank.setEquity(a, 20e18);
        vm.prank(a);
        hub.resume();
        assertFalse(_paused(a));
        vm.prank(a);
        hub.fundTank{value: 0.1 ether}();
        vm.prank(a);
        hub.withdrawTank(0.1 ether);
        vm.prank(a);
        hub.unfollow(true);
        uint256 left = hub.tankOf(a);
        vm.prank(a);
        hub.withdrawTank(left);
        assertEq(hub.tankOf(a), 0);

        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.NewFollowsPaused(false);
        vm.prank(owner);
        hub.pauseNewFollows(false);
        _follow(b, trader);
        (bytes32 s,,,,,) = hub.followOf(b);
        assertEq(s, sid);
    }

    // ---------- surplus ----------

    function test_withdrawSurplus_keepsTanksAndReserve() public {
        _follow(_f(1), trader);
        _follow(_f(2), trader);
        uint256 reserve = hub.MIN_SUBSCRIPTION_BALANCE() + hub.totalTanks();
        assertEq(hub.MIN_SUBSCRIPTION_BALANCE(), 32 ether);
        uint256 surplus = address(hub).balance - reserve;
        assertEq(surplus, 8 ether);
        address to = address(0xBEEF);

        vm.startPrank(owner);
        vm.expectRevert(CopybookHub.InsufficientSurplus.selector);
        hub.withdrawSurplus(to, surplus + 1);
        vm.expectRevert(CopybookHub.InsufficientSurplus.selector);
        hub.withdrawSurplus(to, address(hub).balance + 1);
        vm.expectRevert(abi.encodeWithSelector(CopybookHub.InvalidParam.selector, uint8(1)));
        hub.withdrawSurplus(address(0), 1);
        address refusing = address(new RefusingReceiver());
        vm.expectRevert(CopybookHub.TransferFailed.selector);
        hub.withdrawSurplus(refusing, 1);

        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.SurplusWithdrawn(to, surplus);
        hub.withdrawSurplus(to, surplus);
        vm.stopPrank();
        assertEq(to.balance, surplus);
        assertEq(address(hub).balance, reserve);

        // nothing left above the reserve; the tanks still pay out in full
        vm.prank(owner);
        vm.expectRevert(CopybookHub.InsufficientSurplus.selector);
        hub.withdrawSurplus(to, 1);
        vm.prank(_f(1));
        hub.unfollow(false);
        vm.prank(_f(1));
        hub.withdrawTank(TANK);
        assertEq(address(hub).balance, hub.MIN_SUBSCRIPTION_BALANCE() + hub.totalTanks());
    }

    // Plain transfers top up the subscription balance; they are surplus, never a tank.
    // surplus() is exactly what withdrawSurplus can send, and reads zero once the balance is under the tanks
    // and the subscription reserve (handler fees are drawn from the balance before tanks pay them back).
    function test_surplus_isWhatCanBeWithdrawn() public {
        _follow(_f(1), trader);
        assertEq(hub.surplus(), address(hub).balance - 32 ether - hub.totalTanks());
        uint256 s = hub.surplus();
        assertEq(s, 8 ether);
        vm.startPrank(owner);
        vm.expectRevert(CopybookHub.InsufficientSurplus.selector);
        hub.withdrawSurplus(address(0xBEEF), s + 1);
        hub.withdrawSurplus(address(0xBEEF), s);
        vm.stopPrank();
        assertEq(hub.surplus(), 0);
        vm.deal(address(hub), 32 ether);
        assertEq(hub.surplus(), 0, "saturates below tanks + reserve");
    }

    function test_receive_addsSurplusOnly() public {
        _follow(_f(1), trader);
        uint256 tanks = hub.totalTanks();
        uint256 before = address(hub).balance;
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(hub).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(hub).balance, before + 1 ether);
        assertEq(hub.totalTanks(), tanks);
        assertEq(hub.tankOf(stranger), 0);
    }

    // ---------- orphaned subscriptions ----------

    // A cancel that fails when a group empties is recorded; only recorded ids can be cancelled by the owner,
    // and a failed retry keeps the record.
    function test_cancelOrphan_onlyRecordedIds() public {
        address a = _f(1);
        _follow(a, trader); // subscription 1
        _follow(_f(2), trader2); // subscription 2, live
        vm.mockCallRevert(
            REACTIVITY, abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (1)), abi.encodeWithSignature("Busy()")
        );
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupClosed(sid, 0, 1, false);
        vm.prank(a);
        hub.unfollow(false);
        assertTrue(hub.orphanSubs(1));
        assertFalse(hub.orphanSubs(2));

        vm.startPrank(owner);
        vm.expectRevert(CopybookHub.NotOrphan.selector);
        hub.cancelOrphan(2); // a live group's subscription is never an orphan
        vm.expectRevert(CopybookHub.NotOrphan.selector);
        hub.cancelOrphan(7);

        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.OrphanCancelled(1, false);
        hub.cancelOrphan(1);
        assertTrue(hub.orphanSubs(1), "kept for another try");

        vm.clearMockedCalls();
        vm.expectCall(REACTIVITY, abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (1)), 1);
        vm.expectEmit(false, false, false, true, address(hub));
        emit CopybookHub.OrphanCancelled(1, true);
        hub.cancelOrphan(1);
        assertFalse(hub.orphanSubs(1));
        vm.expectRevert(CopybookHub.NotOrphan.selector);
        hub.cancelOrphan(1);
        vm.stopPrank();

        (, address subOwner) = reactivity.getSubscriptionInfo(1);
        assertEq(subOwner, address(0));
        (, subOwner) = reactivity.getSubscriptionInfo(2);
        assertEq(subOwner, address(hub));
    }

    // A group emptied with a successful cancel leaves no orphan.
    function test_cleanClose_recordsNoOrphan() public {
        address a = _f(1);
        _follow(a, trader);
        vm.prank(a);
        hub.unfollow(false);
        assertFalse(hub.orphanSubs(1));
    }

    // The cancel keeps a fixed budget plus room to record a failure, so a tight estimate cannot leave a
    // failed cancel unrecorded.
    function test_unsubscribeBudget_coversOrphanRecord() public {
        address a = _f(1);
        _follow(a, trader);
        uint256 need = hub.UNSUB_GAS() * 64 / 63 + 1_000_000 + 50_000;
        vm.mockCallRevert(
            REACTIVITY, abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (1)), abi.encodeWithSignature("Busy()")
        );
        vm.prank(a);
        vm.expectRevert(CopybookHub.UnsubscribeOutOfGas.selector);
        hub.unfollow{gas: need}(false);
        vm.prank(a);
        hub.unfollow{gas: need + 300_000}(false);
        assertTrue(hub.orphanSubs(1));
    }

    // ---------- forced resubscribe ----------

    // The chain dropped a group's subscription and getSubscriptionInfo reverts on the removed id, so the
    // permissionless ensureSubscribed fails closed; the owner subscribes the group again with its relay.
    function test_forceResubscribe_recoversWhenInfoReverts() public {
        address a = _f(1);
        _follow(a, trader);
        address relay = hub.relayOf(sid, 0);
        reactivity.forceRemove(1);
        vm.mockCallRevert(
            REACTIVITY, abi.encodeWithSelector(ISomniaReactivityPrecompile.getSubscriptionInfo.selector), bytes("")
        );
        vm.expectRevert(CopybookHub.SubscriptionUnreadable.selector);
        hub.ensureSubscribed(sid, 0);
        vm.clearMockedCalls();

        vm.expectCall(REACTIVITY, abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (1)), 1);
        vm.expectEmit(true, false, false, true, address(hub));
        emit CopybookHub.GroupOpened(sid, 0, relay, 2);
        vm.prank(owner);
        hub.forceResubscribe(sid, 0);
        assertEq(hub.subscriptionOf(sid, 0), 2);
        assertTrue(hub.subscribed(sid, 0));
        assertTrue(hub.orphanSubs(1), "the old id's cancel failed: recorded");
        assertEq(_subOf(2).handlerContractAddress, relay);

        _move(btc, trader, 50_000);
        _fire(2, trader, btc);
        assertEq(_size(btc, a), 50_000);
    }

    // Forcing a live group cancels its old subscription first: still exactly one live subscription.
    function test_forceResubscribe_liveGroup_keepsOneSubscription() public {
        address a = _f(1);
        _follow(a, trader);
        vm.prank(owner);
        hub.forceResubscribe(sid, 0);
        (, address subOwner) = reactivity.getSubscriptionInfo(1);
        assertEq(subOwner, address(0), "old cancelled");
        assertFalse(hub.orphanSubs(1));
        (, subOwner) = reactivity.getSubscriptionInfo(2);
        assertEq(subOwner, address(hub));
        vm.expectRevert(MockReactivity.UnknownSubscription.selector);
        _fire(1, trader, btc);
    }

    function test_forceResubscribe_needsMembers() public {
        address a = _f(1);
        _follow(a, trader);
        vm.prank(a);
        hub.unfollow(false);
        vm.startPrank(owner);
        vm.expectRevert(CopybookHub.NoMembers.selector);
        hub.forceResubscribe(sid, 0);
        vm.expectRevert(CopybookHub.NoMembers.selector);
        hub.forceResubscribe(sid, 5);
        vm.stopPrank();
    }

    // ---------- seats ----------

    function test_seatOf_tracksSwapAndPop() public {
        address a = _f(1);
        address b = _f(2);
        address c = _f(3);
        _follow(a, trader);
        _follow(b, trader);
        _follow(c, trader);
        (uint32 g, uint32 i) = hub.seatOf(c);
        assertEq(g, 0);
        assertEq(i, 2);
        vm.prank(a);
        hub.unfollow(false);
        (g, i) = hub.seatOf(c);
        assertEq(i, 0);
        assertEq(hub.membersOf(sid, 0)[0], c);
    }
}

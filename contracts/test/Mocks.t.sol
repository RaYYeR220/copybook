// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.t.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {MockReactivity} from "./mocks/MockReactivity.sol";
import {IMarginBank, IPerpPool} from "../src/interfaces/IDreamPerps.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/SomniaEventHandler.sol";

contract Sink is SomniaEventHandler {
    address public lastEmitter;
    uint256 public calls;

    function _onEvent(address emitter, bytes32[] calldata, bytes calldata) internal override {
        lastEmitter = emitter;
        calls++;
    }
}

contract MocksTest is Base {
    address internal user = address(0xA11CE);
    address internal operator = address(0xB0B);
    uint64 internal constant FAR = type(uint64).max;
    uint256 internal constant BID_PRICE = 80_100e18; // above mark * 1.001

    function setUp() public override {
        super.setUp();
        btc.approve(user, operator);
        _seedLiquidity(btc, 100_000, 10);
    }

    function _order(MockPerpPool p, bool isBid, uint256 price, uint256 qty, uint8 ot) internal {
        vm.prank(operator);
        p.placeOrderFor(user, isBid, 0, price, qty, FAR, ot, 0, address(0), 0);
    }

    function test_placeOrderForSelector() public pure {
        assertEq(IPerpPool.placeOrderFor.selector, bytes4(0x80054449));
    }

    function test_operatorMustBeApproved() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(MockPerpPool.OperatorNotApproved.selector);
        btc.placeOrderFor(user, true, 0, BID_PRICE, 13_000, FAR, 2, 0, address(0), 0);
    }

    function test_validation() public {
        vm.prank(operator);
        vm.expectRevert(MockPerpPool.OrderAlreadyExpired.selector);
        btc.placeOrderFor(user, true, 0, BID_PRICE, 13_000, 0, 2, 0, address(0), 0);

        vm.expectRevert(MockPerpPool.InvalidQuantity.selector);
        _order(btc, true, BID_PRICE, 13_500, 2);
        vm.expectRevert(MockPerpPool.InvalidQuantity.selector);
        _order(btc, true, BID_PRICE, 12_000, 2);
        vm.expectRevert(MockPerpPool.InvalidPrice.selector);
        _order(btc, true, BID_PRICE + 1, 13_000, 2);
    }

    function test_fillUpdatesPositionAndEmits() public {
        vm.expectEmit(true, true, false, true, address(bank));
        emit IMarginBank.PositionUpdated(user, address(btc), 26_000, 0, 0, 0);
        _order(btc, true, BID_PRICE, 26_000, 2);
        assertEq(bank.getPosition(user, address(btc)).size, 26_000);

        _order(btc, false, 79_000e18, 13_000, 2);
        assertEq(bank.getPosition(user, address(btc)).size, 13_000);
    }

    function test_askIocFillEmitsMockFillAndConsumesBidDepth() public {
        _seedLiquidity(btc, 20_000, 10);
        // ask fills only at or below mark * (1 - 10bps) = 79_920e18
        vm.expectEmit(false, false, false, true, address(btc));
        emit MockPerpPool.MockFill(user, false, 20_000, 79_920e18);
        _order(btc, false, 79_900e18, 30_000, 2);
        assertEq(btc.bidDepth(), 0);
        assertEq(bank.getPosition(user, address(btc)).size, -20_000);
    }

    function test_priceOutsideBandDoesNotFill() public {
        // bid below mark * (1 + 10bps) = 80_080e18
        vm.expectRevert(MockPerpPool.ImmediateOrCancelNoFill.selector);
        _order(btc, true, 80_000e18, 13_000, 2);
    }

    function test_fokRevertsWhenDepthShort() public {
        _seedLiquidity(btc, 20_000, 10);
        vm.expectRevert(MockPerpPool.FillOrKillNotFilled.selector);
        _order(btc, true, BID_PRICE, 30_000, 1);
        _order(btc, true, BID_PRICE, 20_000, 1);
        assertEq(bank.getPosition(user, address(btc)).size, 20_000);
    }

    function test_iocPartialFillConsumesDepth() public {
        _seedLiquidity(btc, 20_000, 10);
        _order(btc, true, BID_PRICE, 30_000, 2);
        assertEq(bank.getPosition(user, address(btc)).size, 20_000);
        assertEq(btc.askDepth(), 0);
        vm.expectRevert(MockPerpPool.ImmediateOrCancelNoFill.selector);
        _order(btc, true, BID_PRICE, 13_000, 2);
    }

    function test_unregisteredCallerCannotApplyFill() public {
        vm.expectRevert("MockMarginBank: not pool");
        bank.applyFill(user, 1);
    }

    function test_revertForBubblesExactBytes() public {
        bytes memory payload = abi.encodeWithSignature("Custom(uint256)", 42);
        btc.setRevertFor(user, payload);
        vm.prank(operator);
        vm.expectRevert(payload);
        btc.placeOrderFor(user, true, 0, BID_PRICE, 13_000, FAR, 2, 0, address(0), 0);
    }

    function test_healthReportsEquity() public {
        bank.setEquity(user, 1_234e18);
        (int256 eq,,,) = bank.getAccountHealth(user);
        assertEq(eq, 1_234e18);
    }

    function _sub(address handler, uint64 gas)
        internal
        pure
        returns (ISomniaReactivityPrecompile.SubscriptionData memory d)
    {
        d.handlerContractAddress = handler;
        d.gasLimit = gas;
    }

    function test_reactivitySubscribeChecks() public {
        Sink sink = new Sink();
        address sub = address(0x5B);
        vm.deal(sub, 31 ether);
        vm.prank(sub);
        vm.expectRevert(MockReactivity.InsufficientBalance.selector);
        reactivity.subscribe(_sub(address(sink), 1_000_000));

        vm.deal(sub, 32 ether);
        vm.prank(sub);
        vm.expectRevert(MockReactivity.GasLimitExceeded.selector);
        reactivity.subscribe(_sub(address(sink), 200_000_001));
        vm.prank(sub);
        vm.expectRevert(MockReactivity.HandlerZeroAddress.selector);
        reactivity.subscribe(_sub(address(0), 1));

        vm.prank(sub);
        assertEq(reactivity.subscribe(_sub(address(sink), 1_000_000)), 1);
        assertEq(reactivity.count(), 1);

        vm.expectRevert(MockReactivity.NotOwner.selector);
        reactivity.unsubscribe(1);
        vm.prank(sub);
        reactivity.unsubscribe(1);
    }

    function test_reactivityFireReachesHandlerAsPrecompile() public {
        Sink sink = new Sink();
        address sub = address(0x5B);
        vm.deal(sub, 32 ether);
        vm.prank(sub);
        uint256 id = reactivity.subscribe(_sub(address(sink), 1_000_000));

        reactivity.fire(id, address(bank), new bytes32[](0), "");
        assertEq(sink.calls(), 1);
        assertEq(sink.lastEmitter(), address(bank));

        vm.expectRevert(SomniaEventHandler.OnlyReactivityPrecompile.selector);
        sink.onEvent(address(bank), new bytes32[](0), "");
    }
}

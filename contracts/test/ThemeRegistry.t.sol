// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {MockMarginBank} from "./mocks/MockMarginBank.sol";
import {MockPerpPool} from "./mocks/MockPerpPool.sol";
import {FakePool} from "./mocks/FakePool.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {Leg} from "../src/Types.sol";

contract ThemeRegistryTest is Base {
    event ThemeCreated(uint256 indexed themeId, address indexed creator, string name);
    event ThemeRebalanced(uint256 indexed themeId, uint32 version);

    ThemeRegistry internal reg;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public override {
        super.setUp();
        reg = new ThemeRegistry(address(bank));
    }

    function _two() internal view returns (Leg[] memory legs) {
        legs = new Leg[](2);
        legs[0] = Leg(address(btc), 10_000);
        legs[1] = Leg(address(eth), -10_000);
    }

    function _create() internal returns (uint256) {
        vm.prank(alice);
        return reg.createTheme("btc-vs-eth", "ipfs://x", _two());
    }

    function test_create_emitsAndStores() public {
        vm.expectEmit(true, true, false, true, address(reg));
        emit ThemeCreated(1, alice, "btc-vs-eth");
        uint256 id = _create();
        assertEq(id, 1);
        (address creator, string memory name, string memory uri, uint32 version) = reg.themeOf(id);
        assertEq(creator, alice);
        assertEq(name, "btc-vs-eth");
        assertEq(uri, "ipfs://x");
        assertEq(version, 1);
        Leg[] memory legs = reg.legsOf(id);
        assertEq(legs.length, 2);
        assertEq(legs[0].pool, address(btc));
        assertEq(legs[0].weightBps, 10_000);
        assertEq(legs[1].pool, address(eth));
        assertEq(legs[1].weightBps, -10_000);
        assertEq(_create(), 2);
    }

    function test_rejects_duplicatePool() public {
        Leg[] memory legs = new Leg[](2);
        legs[0] = Leg(address(btc), 1_000);
        legs[1] = Leg(address(btc), -1_000);
        vm.expectRevert(ThemeRegistry.DuplicatePool.selector);
        reg.createTheme("n", "", legs);
    }

    function test_rejects_zeroWeight() public {
        Leg[] memory legs = _two();
        legs[1].weightBps = 0;
        vm.expectRevert(ThemeRegistry.ZeroWeight.selector);
        reg.createTheme("n", "", legs);
    }

    // Every leg carries at least MIN_LEG_WEIGHT_BPS either way, at create and at rebalance, so a
    // creator cannot park followers in dust legs that only ever reduce.
    function test_rejects_weightBelowMinimum() public {
        assertEq(reg.MIN_LEG_WEIGHT_BPS(), 500);
        Leg[] memory legs = _two();
        legs[1].weightBps = -499;
        vm.expectRevert(ThemeRegistry.WeightTooSmall.selector);
        reg.createTheme("n", "", legs);
        legs[1].weightBps = 499;
        vm.expectRevert(ThemeRegistry.WeightTooSmall.selector);
        reg.createTheme("n", "", legs);
        legs[1].weightBps = -500;
        reg.createTheme("n", "", legs);
        legs[1].weightBps = 500;
        reg.createTheme("n", "", legs);

        vm.prank(alice);
        uint256 id = reg.createTheme("n", "", _two());
        vm.warp(block.timestamp + reg.MIN_REBALANCE_INTERVAL());
        legs = _two();
        legs[0].weightBps = 1;
        vm.prank(alice);
        vm.expectRevert(ThemeRegistry.WeightTooSmall.selector);
        reg.rebalance(id, legs);
    }

    function test_rejects_noLegs() public {
        vm.expectRevert(ThemeRegistry.NoLegs.selector);
        reg.createTheme("n", "", new Leg[](0));
    }

    function test_rejects_tooManyLegs() public {
        Leg[] memory legs = new Leg[](9);
        for (uint256 i; i < 9; ++i) {
            legs[i] = Leg(address(new MockPerpPool(bank, 1e18, 1, 1, 1, 1)), 100);
        }
        vm.expectRevert(ThemeRegistry.TooManyLegs.selector);
        reg.createTheme("n", "", legs);
    }

    function test_rejects_grossOver3x() public {
        Leg[] memory legs = _two();
        legs[0].weightBps = 20_000;
        legs[1].weightBps = -10_001;
        vm.expectRevert(ThemeRegistry.GrossTooHigh.selector);
        reg.createTheme("n", "", legs);
        legs[1].weightBps = -10_000;
        reg.createTheme("n", "", legs);
    }

    function test_rejects_foreignPool() public {
        MockMarginBank other = new MockMarginBank();
        MockPerpPool foreign = new MockPerpPool(other, 1e18, 1, 1, 1, 1);
        Leg[] memory legs = _two();
        legs[1].pool = address(foreign);
        vm.expectRevert(ThemeRegistry.ForeignPool.selector);
        reg.createTheme("n", "", legs);
    }

    // A contract that only claims the bank is not one of its markets, at create and at
    // rebalance; neither is a real pool the bank never registered.
    function test_rejects_fakePoolClaimingBank() public {
        FakePool fake = new FakePool(address(bank));
        assertEq(fake.marginBank(), address(bank));
        Leg[] memory legs = _two();
        legs[1].pool = address(fake);
        vm.expectRevert(ThemeRegistry.ForeignPool.selector);
        reg.createTheme("n", "", legs);

        legs[1].pool = address(new MockPerpPool(bank, 1e18, 1, 1, 1, 1));
        vm.expectRevert(ThemeRegistry.ForeignPool.selector);
        reg.createTheme("n", "", legs);

        uint256 id = _create();
        vm.warp(block.timestamp + reg.MIN_REBALANCE_INTERVAL());
        legs[1].pool = address(fake);
        vm.prank(alice);
        vm.expectRevert(ThemeRegistry.ForeignPool.selector);
        reg.rebalance(id, legs);
    }

    function test_rebalance_onlyCreator() public {
        uint256 id = _create();
        vm.prank(bob);
        vm.expectRevert(ThemeRegistry.NotCreator.selector);
        reg.rebalance(id, _two());
    }

    function test_rebalance_unknownTheme() public {
        vm.expectRevert(ThemeRegistry.UnknownTheme.selector);
        reg.rebalance(7, _two());
        vm.expectRevert(ThemeRegistry.UnknownTheme.selector);
        reg.legsOf(0);
    }

    function test_rebalance_bumpsVersion_emits() public {
        uint256 id = _create();
        vm.warp(block.timestamp + reg.MIN_REBALANCE_INTERVAL());
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(address(btc), 5_000);
        vm.expectEmit(true, false, false, true, address(reg));
        emit ThemeRebalanced(id, 2);
        vm.recordLogs();
        vm.prank(alice);
        reg.rebalance(id, legs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], keccak256("ThemeRebalanced(uint256,uint32)"));
        assertEq(logs[0].topics[1], bytes32(id));
        (,,, uint32 v) = reg.themeOf(id);
        assertEq(v, 2);
        Leg[] memory got = reg.legsOf(id);
        assertEq(got.length, 1);
        assertEq(got[0].weightBps, 5_000);
        assertEq(reg.versionOf(id), 2);
    }

    function test_rebalance_validatesLegs() public {
        uint256 id = _create();
        vm.warp(block.timestamp + reg.MIN_REBALANCE_INTERVAL());
        Leg[] memory legs = _two();
        legs[0].weightBps = 0;
        vm.prank(alice);
        vm.expectRevert(ThemeRegistry.ZeroWeight.selector);
        reg.rebalance(id, legs);
    }

    function test_topicConstant() public view {
        assertEq(reg.THEME_REBALANCED_TOPIC(), keccak256("ThemeRebalanced(uint256,uint32)"));
    }

    // Identical legs, in any order, are not a rebalance: every follower would pay to re-check its book.
    function test_rebalance_rejectsNoChange() public {
        uint256 id = _create();
        vm.warp(block.timestamp + reg.MIN_REBALANCE_INTERVAL());
        Leg[] memory same = _two();
        Leg[] memory swapped = new Leg[](2);
        swapped[0] = same[1];
        swapped[1] = same[0];
        vm.startPrank(alice);
        vm.expectRevert(ThemeRegistry.NoChange.selector);
        reg.rebalance(id, same);
        vm.expectRevert(ThemeRegistry.NoChange.selector);
        reg.rebalance(id, swapped);

        // a different weight, a dropped leg or an added one is a change
        same[1].weightBps = -9_999;
        reg.rebalance(id, same);
        vm.warp(block.timestamp + reg.MIN_REBALANCE_INTERVAL());
        Leg[] memory one = new Leg[](1);
        one[0] = same[0];
        reg.rebalance(id, one);
        vm.stopPrank();
        assertEq(reg.versionOf(id), 3);
    }

    function test_rebalance_minInterval() public {
        uint256 id = _create();
        assertEq(reg.MIN_REBALANCE_INTERVAL(), 60);
        Leg[] memory legs = _two();
        legs[0].weightBps = 5_000;

        vm.startPrank(alice);
        // counted from the creation
        vm.warp(block.timestamp + 59);
        vm.expectRevert(ThemeRegistry.RebalanceTooSoon.selector);
        reg.rebalance(id, legs);
        vm.warp(block.timestamp + 1);
        reg.rebalance(id, legs);

        // and from the last rebalance
        legs[0].weightBps = 6_000;
        vm.expectRevert(ThemeRegistry.RebalanceTooSoon.selector);
        reg.rebalance(id, legs);
        vm.warp(block.timestamp + 60);
        reg.rebalance(id, legs);
        vm.stopPrank();
        assertEq(reg.versionOf(id), 3);

        vm.expectRevert(ThemeRegistry.UnknownTheme.selector);
        reg.versionOf(9);
    }
}

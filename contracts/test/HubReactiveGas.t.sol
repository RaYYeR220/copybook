// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {MockReactivity} from "./mocks/MockReactivity.sol";
import {CopybookHub} from "../src/CopybookHub.sol";
import {ThemeRegistry} from "../src/ThemeRegistry.sol";
import {Policy, SourceKind} from "../src/Types.sol";
import {IMarginBank} from "../src/interfaces/IDreamPerps.sol";

/// A group member whose order runs out of gas, in groups of 8 and 64. The handler must survive it,
/// report the member as Deferred rather than refused, and not bill it for a slot it could not finish.
contract HubReactiveGasTest is Base {
    bytes32 internal constant POSITION_UPDATED = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;
    uint256 internal constant TANK = 0.5 ether;

    CopybookHub internal hub;
    address internal trader = address(0x7AD3);
    bytes32 internal sid;

    function _f(uint256 i) internal pure returns (address) {
        return address(uint160(0xF000 + i));
    }

    function _one() internal view returns (address[] memory p) {
        p = new address[](1);
        p[0] = address(btc);
    }

    function _setup(uint32 groupSize, uint256 n) internal {
        hub = new CopybookHub(IMarginBank(address(bank)), new ThemeRegistry(address(bank)), groupSize, address(0x0A11));
        vm.deal(address(hub), 40 ether);
        btc.approve(trader, address(this));
        btc.setLiquidity(100_000_000, 100_000_000, 10);
        sid = hub.sourceIdOf(SourceKind.Trader, uint256(uint160(trader)));
        Policy memory p = Policy({
            scaleBps: 10_000, allocation: 0, maxNotional: 100e18, maxTotalNotional: 0, bandBps: 50, equityFloor: 0
        });
        for (uint256 i = 1; i <= n; ++i) {
            address who = _f(i);
            vm.deal(who, 1 ether);
            btc.approve(who, address(hub));
            vm.prank(who);
            hub.follow{value: TANK}(SourceKind.Trader, uint256(uint160(trader)), p, new address[](0));
        }
    }

    function _traderEvent() internal returns (Vm.Log memory ev) {
        vm.recordLogs();
        btc.placeOrderFor(trader, true, 0, 88_000e18, 50_000, type(uint64).max, 2, 0, address(0), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bank) && logs[i].topics[0] == POSITION_UPDATED) ev = logs[i];
        }
        require(ev.emitter == address(bank), "no PositionUpdated");
    }

    /// Delivers the event through the precompile with a gas cap; returns whether the handler survived.
    function _fire(uint256 gas, Vm.Log memory ev) internal returns (bool ok, uint256 used) {
        bytes memory call =
            abi.encodeCall(MockReactivity.fire, (hub.subscriptionOf(sid, 0), ev.emitter, ev.topics, ev.data));
        uint256 g0 = gasleft();
        (ok,) = REACTIVITY.call{gas: gas}(call);
        used = g0 - gasleft();
    }

    function _count(Vm.Log[] memory logs, bytes32 sig) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub) && logs[i].topics[0] == sig) n++;
        }
    }

    function _countFor(Vm.Log[] memory logs, bytes32 sig, address who) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(hub) && logs[i].topics[0] == sig
                    && logs[i].topics[1] == bytes32(uint256(uint160(who)))
            ) n++;
        }
    }

    function test_oogMember_groupOf8_isDeferredNotRefused() public {
        _setup(8, 8);
        btc.setBombFor(_f(1), true);
        Vm.Log memory ev = _traderEvent();
        vm.fee(6 gwei);

        // too little for any member: the whole group is deferred without touching a venue
        vm.recordLogs();
        (bool ok,) = _fire(6_300_000, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok, "handler survives");
        assertEq(_count(logs, CopybookHub.Deferred.selector), 8);
        assertEq(_count(logs, CopybookHub.Refused.selector), 0);
        assertEq(_count(logs, CopybookHub.Copied.selector), 0);

        // enough to reach member #0 but not a full slot: its order burns the slot, and it is deferred
        // with every member after it, unbilled
        vm.recordLogs();
        uint256 used;
        (ok, used) = _fire(12_000_000, ev);
        logs = vm.getRecordedLogs();
        assertTrue(ok, "handler survives");
        assertGt(used, 8_000_000, "member #0 spent its slot");
        assertEq(_count(logs, CopybookHub.Deferred.selector), 8);
        assertEq(_countFor(logs, CopybookHub.Deferred.selector, _f(1)), 1);
        assertEq(_count(logs, CopybookHub.Refused.selector), 0);
        assertEq(_count(logs, CopybookHub.TankCharged.selector), 0);
        assertEq(hub.tankOf(_f(1)), TANK, "no charge for the burned slot");

        for (uint256 i = 2; i <= 8; ++i) {
            hub.catchUp(_f(i), _one());
            assertEq(bank.getPosition(_f(i), address(btc)).size, 50_000);
        }
    }

    function test_oogMember_largeGroup_handlerSurvives() public {
        _setup(64, 64);
        btc.setBombFor(_f(1), true);
        Vm.Log memory ev = _traderEvent();

        vm.recordLogs();
        (bool ok,) = _fire(6_300_000, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok, "handler survives");
        assertEq(_count(logs, CopybookHub.Deferred.selector), 64);

        vm.recordLogs();
        uint256 used;
        (ok, used) = _fire(14_000_000, ev);
        logs = vm.getRecordedLogs();
        assertTrue(ok, "one member's out-of-gas does not abort the handler");
        assertGt(used, 8_000_000, "member #0 spent its slot");
        assertEq(_count(logs, CopybookHub.Deferred.selector), 64);
        assertEq(_count(logs, CopybookHub.Refused.selector), 0);
        assertEq(_count(logs, CopybookHub.Copied.selector), 0);
        assertEq(hub.tankOf(_f(1)), TANK);
    }

    // With gas to spare the member gets a full slot; burning all of it is its own doing, so only it is
    // deferred (and billed) while the rest of the group is copied.
    function test_oogMember_fullSlot_defersOnlyItself() public {
        _setup(8, 8);
        btc.setBombFor(_f(1), true);
        Vm.Log memory ev = _traderEvent();
        vm.fee(6 gwei);

        vm.recordLogs();
        (bool ok,) = _fire(100_000_000, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok);
        assertEq(_count(logs, CopybookHub.Deferred.selector), 1);
        assertEq(_countFor(logs, CopybookHub.Deferred.selector, _f(1)), 1);
        assertEq(_count(logs, CopybookHub.Refused.selector), 0);
        assertEq(_count(logs, CopybookHub.Copied.selector), 7);
        assertLt(hub.tankOf(_f(1)), TANK, "a full slot is billed");
        for (uint256 i = 2; i <= 8; ++i) {
            assertEq(bank.getPosition(_f(i), address(btc)).size, 50_000);
        }
    }

    function test_largeGroup_noBomb_copiesThenDefers() public {
        _setup(64, 64);
        Vm.Log memory ev = _traderEvent();
        vm.recordLogs();
        (bool ok,) = _fire(14_000_000, ev);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(ok);
        uint256 copied = _count(logs, CopybookHub.Copied.selector);
        assertGt(copied, 0);
        assertEq(copied + _count(logs, CopybookHub.Deferred.selector), 64);
    }
}

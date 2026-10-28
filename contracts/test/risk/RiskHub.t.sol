// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "../Base.t.sol";
import {MockPerpPool} from "../mocks/MockPerpPool.sol";
import {MockMailbox} from "./mocks/MockMailbox.sol";
import {CopybookHub} from "../../src/CopybookHub.sol";
import {ThemeRegistry} from "../../src/ThemeRegistry.sol";
import {Policy, Reason, SourceKind} from "../../src/Types.sol";
import {IMarginBank} from "../../src/interfaces/IDreamPerps.sol";
import {RiskGate} from "../../src/risk/RiskGate.sol";
import {IMailbox} from "../../src/risk/IHyperlane.sol";
import {Tier, RiskMessages} from "../../src/risk/RiskTypes.sol";

/// The hub, unchanged, consulting the gate through `IRiskGate.allowIncrease` on its fixed gas budget.
contract RiskHubTest is Base {
    uint32 internal constant SHANNON = 50312;
    uint32 internal constant HIDEKI = 50383;
    uint256 internal constant TANK = 0.5 ether;

    CopybookHub internal hub;
    MockMailbox internal mailbox;
    RiskGate internal gate;

    address internal owner = address(0x0A11);
    address internal trader = address(0x7AD3);
    address internal shannonReviewer = address(0x5A770);
    address internal guarded = address(0xF001);
    address internal open = address(0xF002);
    bytes32 internal sid;

    function setUp() public override {
        super.setUp();
        ThemeRegistry themes = new ThemeRegistry(address(bank));
        hub = new CopybookHub(IMarginBank(address(bank)), themes, 8, owner);
        vm.deal(address(hub), 40 ether);
        btc.approve(trader, address(this));
        btc.setLiquidity(10_000_000, 10_000_000, 10);
        sid = hub.sourceIdOf(SourceKind.Trader, uint256(uint160(trader)));

        mailbox = new MockMailbox(HIDEKI);
        gate = new RiskGate(owner, IMailbox(address(mailbox)), SHANNON);
        vm.startPrank(owner);
        gate.setReviewer(shannonReviewer);
        hub.setRiskGate(address(gate));
        vm.stopPrank();

        _follow(guarded);
        _follow(open);
        vm.prank(open);
        gate.setGuard(false);
    }

    function _follow(address who) internal {
        vm.deal(who, 1 ether);
        btc.approve(who, address(hub));
        vm.prank(who);
        hub.follow{value: TANK}(
            SourceKind.Trader,
            uint256(uint160(trader)),
            Policy({
                scaleBps: 10_000, allocation: 0, maxNotional: 100e18, maxTotalNotional: 0, bandBps: 50, equityFloor: 0
            }),
            new address[](0)
        );
    }

    function _move(int256 target) internal {
        int256 d = target - _size(trader);
        if (d == 0) return;
        bool bid = d > 0;
        uint256 price = (bid ? btc.mark() * 11 / 10 : btc.mark() * 9 / 10) / btc.tick() * btc.tick();
        btc.placeOrderFor(trader, bid, 0, price, uint256(bid ? d : -d), type(uint64).max, 2, 0, address(0), 0);
    }

    function _size(address account) internal view returns (int256) {
        return bank.getPosition(account, address(btc)).size;
    }

    function _pools() internal view returns (address[] memory p) {
        p = new address[](1);
        p[0] = address(btc);
    }

    function _sync() internal {
        hub.catchUp(guarded, _pools());
        hub.catchUp(open, _pools());
    }

    function _verdict(Tier tier) internal {
        vm.deal(address(this), 1 ether);
        uint64 nonce = gate.requestReview{value: 0.5 ether}(trader);
        mailbox.process(
            SHANNON,
            bytes32(uint256(uint160(shannonReviewer))),
            address(gate),
            RiskMessages.encodeVerdict(trader, nonce, uint8(tier), 77, keccak256("s"))
        );
    }

    function test_gateUsesTheHubSourceId() public view {
        assertEq(gate.sourceIdOf(trader), sid);
        assertEq(hub.riskGate(), address(gate));
    }

    function test_liveHub_blockRefusesGuardedIncreasesOnly_exitsStillCopy() public {
        _move(50_000);
        _sync();
        assertEq(_size(guarded), 50_000);
        assertEq(_size(open), 50_000);

        _verdict(Tier.Block);

        // an increase: refused for the guarded follower, copied for the one who opted out
        _move(80_000);
        vm.expectEmit(true, true, true, true, address(hub));
        emit CopybookHub.Refused(guarded, sid, address(btc), Reason.RiskGate, "");
        hub.catchUp(guarded, _pools());
        hub.catchUp(open, _pools());
        assertEq(_size(guarded), 50_000, "guarded: no new size");
        assertEq(_size(open), 80_000, "unguarded: copied");

        // an exit never asks the gate
        _move(0);
        _sync();
        assertEq(_size(guarded), 0, "guarded: exit copied");
        assertEq(_size(open), 0);

        // once the verdict is older than the TTL the guarded follower copies again
        _move(40_000);
        vm.warp(vm.getBlockTimestamp() + 7 days + 1);
        _sync();
        assertEq(_size(guarded), 40_000);
    }

    function test_liveHub_cautionAndOkNeverRefuse() public {
        _verdict(Tier.Caution);
        _move(30_000);
        _sync();
        assertEq(_size(guarded), 30_000);

        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        _verdict(Tier.Ok);
        _move(60_000);
        _sync();
        assertEq(_size(guarded), 60_000);
    }
}

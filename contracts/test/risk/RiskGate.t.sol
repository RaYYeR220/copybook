// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RiskBase} from "./RiskBase.t.sol";
import {MockMailbox} from "./mocks/MockMailbox.sol";
import {RiskGate} from "../../src/risk/RiskGate.sol";
import {IMailbox} from "../../src/risk/IHyperlane.sol";
import {Tier, Verdict, RiskMessages} from "../../src/risk/RiskTypes.sol";
import {IRiskGate} from "../../src/interfaces/IDreamPerps.sol";

contract RejectingReceiver {
    receive() external payable {
        revert("no");
    }
}

contract RiskGateTest is RiskBase {
    bytes32 internal constant H = keccak256("summary");

    // ---------- defaults ----------

    function test_defaults() public view {
        assertEq(gate.reviewFee(), 0.5 ether);
        assertEq(gate.VERDICT_TTL(), 7 days);
        assertEq(gate.REVIEW_COOLDOWN(), 10 minutes);
        assertEq(gate.PENDING_TIMEOUT(), 30 minutes);
        assertEq(gate.BLOCK_HOLD(), 24 hours);
        assertEq(address(gate.MAILBOX()), address(hideki));
        assertEq(gate.REVIEWER_DOMAIN(), SHANNON);
        assertEq(gate.reviewer(), address(reviewer));
        assertEq(gate.owner(), owner);
        assertTrue(gate.guardOf(follower), "guarded by default");
        assertEq(uint8(gate.verdictOf(trader).tier), uint8(Tier.None));
        assertTrue(gate.allowIncrease(_sid(trader), follower));
    }

    // The gate keys verdicts by the hub's trader source id.
    function test_sourceIdOf_matchesHub() public view {
        assertEq(gate.sourceIdOf(trader), _sid(trader));
        assertEq(RiskMessages.traderSourceId(trader), _sid(trader));
    }

    // ---------- requestReview ----------

    function test_requestReview_dispatchesToReviewer() public {
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.ReviewRequested(trader, 1, requester);
        uint64 nonce = _request(trader);
        assertEq(nonce, 1);
        assertEq(gate.requestNonce(), 1);

        MockMailbox.Message memory m = hideki.last();
        assertEq(m.sender, address(gate));
        assertEq(m.destination, SHANNON);
        assertEq(m.recipient, _b32(address(reviewer)));
        assertEq(m.body, abi.encode(trader, uint64(1)));

        RiskGate.PendingReview memory p = gate.pendingOf(trader);
        assertEq(p.nonce, 1);
        assertEq(p.requestedAt, T0);
        assertEq(address(gate).balance, FEE);
    }

    function test_requestReview_paysTheMailboxQuote() public {
        hideki.setFee(0.01 ether);
        _request(trader);
        assertEq(hideki.last().value, 0.01 ether);
        assertEq(address(gate).balance, FEE - 0.01 ether);
    }

    function test_requestReview_rejectsZeroTraderAndMissingReviewer() public {
        vm.prank(requester);
        vm.expectRevert(RiskGate.ZeroAddress.selector);
        gate.requestReview{value: FEE}(address(0));

        RiskGate bare = new RiskGate(owner, IMailbox(address(hideki)), SHANNON);
        vm.prank(requester);
        vm.expectRevert(RiskGate.NoReviewer.selector);
        bare.requestReview{value: FEE}(trader);
    }

    // A fee, one pending review per source, and a cooldown after each verdict.
    function test_requestReview_cooldownAndPending() public {
        // fee
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.FeeTooLow.selector, 0.4 ether, FEE));
        gate.requestReview{value: 0.4 ether}(trader);

        vm.prank(owner);
        gate.setReviewFee(1 ether);
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.FeeTooLow.selector, FEE, 1 ether));
        gate.requestReview{value: FEE}(trader);
        vm.prank(owner);
        gate.setReviewFee(FEE);

        // one pending per source
        uint64 first = _request(trader);
        uint256 replaceableAt = T0 + 30 minutes;
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.Pending.selector, first, replaceableAt));
        gate.requestReview{value: FEE}(trader);

        vm.warp(replaceableAt - 1);
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.Pending.selector, first, replaceableAt));
        gate.requestReview{value: FEE}(trader);

        // other sources are independent
        address other = makeAddr("other");
        _request(other);

        // a pending review older than the timeout can be replaced; its late verdict is then ignored
        vm.warp(replaceableAt);
        uint64 second = _request(trader);
        assertEq(second, first + 2);
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.StaleVerdict(trader, first);
        _deliverVerdict(trader, first, uint8(Tier.Block), 7, H);
        assertEq(uint8(gate.verdictOf(trader).tier), uint8(Tier.None));
        assertEq(gate.pendingOf(trader).nonce, second);

        // after a verdict, a cooldown
        _deliverVerdict(trader, second, uint8(Tier.Ok), 8, H);
        uint256 readyAt = vm.getBlockTimestamp() + 10 minutes;
        assertEq(gate.pendingOf(trader).nonce, 0);
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.Cooldown.selector, readyAt));
        gate.requestReview{value: FEE}(trader);

        vm.warp(readyAt - 1);
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.Cooldown.selector, readyAt));
        gate.requestReview{value: FEE}(trader);

        vm.warp(readyAt);
        _request(trader);
    }

    // A failed review leaves no cooldown behind: the next request may follow at once.
    function test_failedReview_clearsPendingWithoutCooldown() public {
        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.None), 0, bytes32(0));
        assertEq(gate.pendingOf(trader).nonce, 0);
        _request(trader);
    }

    // ---------- handle ----------

    // Only the reviewer on Shannon, through the Hideki mailbox, can write a verdict.
    function test_handle_rejectsWrongOriginSenderOrCaller() public {
        uint64 nonce = _request(trader);
        bytes memory body = RiskMessages.encodeVerdict(trader, nonce, uint8(Tier.Block), 9, H);

        // not the mailbox
        vm.prank(stranger);
        vm.expectRevert(RiskGate.NotMailbox.selector);
        gate.handle(SHANNON, _b32(address(reviewer)), body);

        // another mailbox (right origin, right sender)
        MockMailbox rogue = new MockMailbox(HIDEKI);
        vm.expectRevert(RiskGate.NotMailbox.selector);
        rogue.process(SHANNON, _b32(address(reviewer)), address(gate), body);

        // wrong origin
        vm.expectRevert(abi.encodeWithSelector(RiskGate.UnknownOrigin.selector, HIDEKI));
        hideki.process(HIDEKI, _b32(address(reviewer)), address(gate), body);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.UnknownOrigin.selector, uint32(1)));
        hideki.process(1, _b32(address(reviewer)), address(gate), body);

        // wrong sender (any other contract on Shannon, the gate's own address, a dirty high word)
        vm.expectRevert(abi.encodeWithSelector(RiskGate.UnknownSender.selector, _b32(stranger)));
        hideki.process(SHANNON, _b32(stranger), address(gate), body);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.UnknownSender.selector, _b32(address(gate))));
        hideki.process(SHANNON, _b32(address(gate)), address(gate), body);
        bytes32 dirty = _b32(address(reviewer)) | bytes32(uint256(1) << 200);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.UnknownSender.selector, dirty));
        hideki.process(SHANNON, dirty, address(gate), body);

        assertEq(uint8(gate.verdictOf(trader).tier), uint8(Tier.None));
        assertEq(gate.pendingOf(trader).nonce, nonce);

        // the reviewer through the mailbox
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.VerdictReceived(_sid(trader), trader, Tier.Block, 9, H);
        hideki.process(SHANNON, _b32(address(reviewer)), address(gate), body);
        _assertVerdict(trader, Tier.Block, vm.getBlockTimestamp(), 9, H);

        // a replaced reviewer can no longer write
        vm.prank(owner);
        gate.setReviewer(stranger);
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        uint64 next = _request(trader);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.UnknownSender.selector, _b32(address(reviewer))));
        _deliverVerdict(trader, next, uint8(Tier.Ok), 10, H);
    }

    function test_handle_storesVerdictAndClearsPending() public {
        uint64 nonce = _request(trader);
        vm.warp(T0 + 25);
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.VerdictReceived(_sid(trader), trader, Tier.Caution, 42, H);
        _deliverVerdict(trader, nonce, uint8(Tier.Caution), 42, H);
        _assertVerdict(trader, Tier.Caution, T0 + 25, 42, H);
        assertEq(gate.pendingOf(trader).nonce, 0);
    }

    // A failed or out-of-range verdict changes nothing but the pending slot.
    function test_failedOrOutOfRangeVerdict_keepsPrevious() public {
        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 11, H);
        uint256 at = vm.getBlockTimestamp();

        vm.warp(at + 10 minutes);
        nonce = _request(trader);
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.ReviewFailed(trader, nonce);
        _deliverVerdict(trader, nonce, uint8(Tier.None), 12, keccak256("other"));
        _assertVerdict(trader, Tier.Block, at, 11, H);
        assertEq(gate.pendingOf(trader).nonce, 0);

        nonce = _request(trader);
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.ReviewFailed(trader, nonce);
        _deliverVerdict(trader, nonce, 4, 13, keccak256("other"));
        nonce = _request(trader);
        _deliverVerdict(trader, nonce, type(uint8).max, 14, keccak256("other"));
        _assertVerdict(trader, Tier.Block, at, 11, H);
    }

    // A verdict that matches no pending review is ignored.
    function test_handle_ignoresUnmatchedNonce() public {
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.StaleVerdict(trader, 1);
        _deliverVerdict(trader, 1, uint8(Tier.Block), 1, H);

        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce + 1, uint8(Tier.Block), 1, H);
        _deliverVerdict(trader, 0, uint8(Tier.Block), 1, H);
        _deliverVerdict(makeAddr("other"), nonce, uint8(Tier.Block), 1, H);
        assertEq(uint8(gate.verdictOf(trader).tier), uint8(Tier.None));
        assertEq(gate.pendingOf(trader).nonce, nonce);

        // delivered twice: the second copy is stale
        _deliverVerdict(trader, nonce, uint8(Tier.Ok), 2, H);
        uint256 at = vm.getBlockTimestamp();
        vm.warp(at + 1);
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.StaleVerdict(trader, nonce);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 3, H);
        _assertVerdict(trader, Tier.Ok, at, 2, H);
    }

    // A milder verdict within BLOCK_HOLD of a Block is held (pending still clears); from 24 h on it replaces.
    function test_blockHold_milderVerdictHeldFor24Hours() public {
        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 1, H);
        uint256 blockedAt = vm.getBlockTimestamp();

        vm.warp(blockedAt + 1 hours);
        nonce = _request(trader);
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.BlockHeld(_sid(trader), trader, Tier.Ok, nonce);
        _deliverVerdict(trader, nonce, uint8(Tier.Ok), 2, keccak256("ok"));
        _assertVerdict(trader, Tier.Block, blockedAt, 1, H);
        assertEq(gate.pendingOf(trader).nonce, 0, "pending cleared");
        assertFalse(gate.allowIncrease(_sid(trader), follower));

        vm.warp(blockedAt + 24 hours - 1);
        nonce = _request(trader);
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.BlockHeld(_sid(trader), trader, Tier.Caution, nonce);
        _deliverVerdict(trader, nonce, uint8(Tier.Caution), 3, keccak256("caution"));
        _assertVerdict(trader, Tier.Block, blockedAt, 1, H);

        vm.warp(blockedAt + 24 hours);
        nonce = _request(trader);
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.VerdictReceived(_sid(trader), trader, Tier.Ok, 4, keccak256("ok"));
        _deliverVerdict(trader, nonce, uint8(Tier.Ok), 4, keccak256("ok"));
        _assertVerdict(trader, Tier.Ok, blockedAt + 24 hours, 4, keccak256("ok"));
        assertTrue(gate.allowIncrease(_sid(trader), follower));
    }

    // A new Block refreshes a Block at any time, and the hold restarts from it.
    function test_blockHold_newBlockRefreshesAnytime() public {
        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 1, H);
        uint256 refreshedAt = vm.getBlockTimestamp() + 10 minutes;

        vm.warp(refreshedAt);
        nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 2, keccak256("again"));
        _assertVerdict(trader, Tier.Block, refreshedAt, 2, keccak256("again"));

        vm.warp(refreshedAt + 23 hours);
        nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Ok), 3, H);
        _assertVerdict(trader, Tier.Block, refreshedAt, 2, keccak256("again"));

        vm.warp(refreshedAt + 24 hours);
        nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Ok), 4, H);
        _assertVerdict(trader, Tier.Ok, refreshedAt + 24 hours, 4, H);
    }

    // ---------- allowIncrease ----------

    function test_allowIncrease_blocksGuardedFollowersOfABlockedTraderOnly() public {
        address open = makeAddr("open");
        vm.prank(open);
        gate.setGuard(false);

        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 1, H);
        assertFalse(gate.allowIncrease(_sid(trader), follower), "guarded follower of a blocked trader");
        assertTrue(gate.allowIncrease(_sid(trader), open), "unguarded follower");
        assertTrue(gate.allowIncrease(_sid(makeAddr("other")), follower), "other source");
        assertTrue(gate.allowIncrease(bytes32(0), follower), "zero source");

        for (uint8 t = uint8(Tier.Ok); t <= uint8(Tier.Caution); ++t) {
            address x = address(uint160(0xC0DE + t));
            nonce = _request(x);
            _deliverVerdict(x, nonce, t, 1, H);
            assertTrue(gate.allowIncrease(_sid(x), follower), "ok/caution never block");
        }
    }

    // A Block older than the TTL stops blocking; a fresh one blocks again.
    function test_staleBlock_allows() public {
        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 1, H);
        uint256 at = vm.getBlockTimestamp();

        vm.warp(at + 7 days);
        assertFalse(gate.allowIncrease(_sid(trader), follower), "at the TTL");
        vm.warp(at + 7 days + 1);
        assertTrue(gate.allowIncrease(_sid(trader), follower), "past the TTL");

        nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 2, H);
        assertFalse(gate.allowIncrease(_sid(trader), follower), "re-reviewed");
    }

    // Total for any source, follower, stored verdict and clock. The 2M cap is the hub's default riskGateGas; this is
    // EVM metering, not a Somnia budget (see allowIncrease: Somnia needs ~1M available for a cold or missing key).
    function test_allowIncrease_neverReverts_fuzz(
        address t,
        address who,
        bytes32 randomSource,
        uint8 tierRaw,
        bool unguard,
        uint32 reviewedOffset,
        uint64 now_
    ) public {
        vm.assume(t != address(0));
        uint8 tier = tierRaw;
        vm.warp(T0 + reviewedOffset);
        uint64 nonce = _request(t);
        _deliverVerdict(t, nonce, tier, 1, H);
        uint256 reviewedAt = vm.getBlockTimestamp();
        if (unguard) {
            vm.prank(who);
            gate.setGuard(false);
        }
        vm.warp(now_);

        bool stored = tier >= uint8(Tier.Ok) && tier <= uint8(Tier.Block);
        bool fresh = now_ <= reviewedAt + 7 days;
        bool expected = !(stored && tier == uint8(Tier.Block) && fresh && !unguard);

        (bool ok, bytes memory ret) =
            address(gate).staticcall{gas: 2_000_000}(abi.encodeCall(IRiskGate.allowIncrease, (_sid(t), who)));
        assertTrue(ok, "never reverts");
        assertEq(ret.length, 32);
        assertEq(abi.decode(ret, (bool)), expected);

        (ok, ret) =
            address(gate).staticcall{gas: 2_000_000}(abi.encodeCall(IRiskGate.allowIncrease, (randomSource, who)));
        assertTrue(ok, "never reverts on any source");
        assertEq(ret.length, 32);
        if (randomSource != _sid(t)) assertTrue(abi.decode(ret, (bool)));
    }

    // EVM gas as forge meters it, cold (account and storage). These bounds are not Somnia budgets: on Somnia a cold or
    // missing key needs ~1M gas available though little is used, so the hub's riskGateGas must stay >= ~1.5M.
    function test_allowIncrease_gas() public {
        uint64 nonce = _request(trader);
        _deliverVerdict(trader, nonce, uint8(Tier.Block), 1, H);

        uint256 blockedGas = _coldGas(_sid(trader), follower);
        uint256 openGas = _coldGas(_sid(makeAddr("fresh")), follower);
        emit log_named_uint("allowIncrease cold gas, blocked source + guarded follower", blockedGas);
        emit log_named_uint("allowIncrease cold gas, unreviewed source", openGas);
        assertLt(blockedGas, 10_000);
        assertLt(openGas, 7_500);
    }

    function _coldGas(bytes32 source, address who) internal returns (uint256 used) {
        bytes memory data = abi.encodeCall(IRiskGate.allowIncrease, (source, who));
        vm.cool(address(gate));
        uint256 g = gasleft();
        (bool ok,) = address(gate).staticcall(data);
        used = g - gasleft();
        assertTrue(ok);
    }

    // ---------- guard ----------

    function test_setGuard_perFollower() public {
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.GuardSet(follower, false);
        vm.prank(follower);
        gate.setGuard(false);
        assertFalse(gate.guardOf(follower));
        assertTrue(gate.guardOf(stranger));

        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.GuardSet(follower, true);
        vm.prank(follower);
        gate.setGuard(true);
        assertTrue(gate.guardOf(follower));
    }

    // ---------- owner ----------

    function test_owner_controls() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(unauthorized);
        gate.setReviewer(stranger);
        vm.expectRevert(unauthorized);
        gate.setReviewFee(0);
        vm.expectRevert(unauthorized);
        gate.withdraw(stranger, 0);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(RiskGate.ZeroAddress.selector);
        gate.setReviewer(address(0));
        vm.expectEmit(false, false, false, true, address(gate));
        emit RiskGate.ReviewerSet(stranger);
        gate.setReviewer(stranger);
        assertEq(gate.reviewer(), stranger);
        vm.expectEmit(false, false, false, true, address(gate));
        emit RiskGate.ReviewFeeSet(2 ether);
        gate.setReviewFee(2 ether);
        assertEq(gate.reviewFee(), 2 ether);
        vm.stopPrank();
    }

    function test_withdraw() public {
        _request(trader);
        address to = makeAddr("treasury");
        vm.startPrank(owner);
        vm.expectRevert(RiskGate.ZeroAddress.selector);
        gate.withdraw(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.InsufficientBalance.selector, FEE + 1, FEE));
        gate.withdraw(to, FEE + 1);
        address bad = address(new RejectingReceiver());
        vm.expectRevert(RiskGate.TransferFailed.selector);
        gate.withdraw(bad, 1);
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.Withdrawn(to, 0.2 ether);
        gate.withdraw(to, 0.2 ether);
        vm.stopPrank();
        assertEq(to.balance, 0.2 ether);
        assertEq(address(gate).balance, FEE - 0.2 ether);
    }

    function test_renounceOwnership_disabled_twoStepTransfer() public {
        vm.prank(owner);
        vm.expectRevert(RiskGate.RenounceDisabled.selector);
        gate.renounceOwnership();
        vm.prank(owner);
        gate.transferOwnership(stranger);
        assertEq(gate.owner(), owner);
        vm.prank(stranger);
        gate.acceptOwnership();
        assertEq(gate.owner(), stranger);
    }

    // The reviewer's domain is neither 0 nor this chain's own (when the mailbox reports it).
    function test_constructor_rejectsBadDomain() public {
        vm.expectRevert(abi.encodeWithSelector(RiskGate.InvalidDomain.selector, uint32(0)));
        new RiskGate(owner, IMailbox(address(hideki)), 0);
        vm.expectRevert(abi.encodeWithSelector(RiskGate.InvalidDomain.selector, HIDEKI));
        new RiskGate(owner, IMailbox(address(hideki)), HIDEKI);
        // a mailbox that does not report its domain is only checked against 0
        RiskGate g = new RiskGate(owner, IMailbox(address(new RejectingReceiver())), HIDEKI);
        assertEq(g.REVIEWER_DOMAIN(), HIDEKI);
    }

    function test_constructor_rejectsZeroMailbox() public {
        vm.expectRevert(RiskGate.ZeroAddress.selector);
        new RiskGate(owner, IMailbox(address(0)), SHANNON);
    }
}

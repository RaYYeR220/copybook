// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RiskBase} from "./RiskBase.t.sol";
import {RiskGate} from "../../src/risk/RiskGate.sol";
import {RiskReviewer} from "../../src/risk/RiskReviewer.sol";
import {IAgentRequester} from "../../src/risk/interfaces/IAgentRequester.sol";
import {Tier, Verdict} from "../../src/risk/RiskTypes.sol";

/// Hideki gate -> Hyperlane -> Shannon reviewer -> two committee stages -> Hyperlane -> Hideki gate.
contract RiskEndToEndTest is RiskBase {
    uint256 internal constant SUMMARY_DEPOSIT = 0.12 ether;
    uint256 internal constant VERDICT_DEPOSIT = 0.24 ether;

    function test_happyPath_blockAcrossBothMailboxes() public {
        address open = makeAddr("open");
        vm.prank(open);
        gate.setGuard(false);
        bytes32 summaryHash = keccak256(bytes(SUMMARY));

        // Hideki: anyone pays for a review
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.ReviewRequested(trader, 1, requester);
        uint64 nonce = _request(trader);
        assertEq(hideki.undelivered(), 1);

        // Hideki -> Shannon
        vm.warp(T0 + 8);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.SummaryRequested(trader, nonce, 101, SUMMARY_DEPOSIT);
        hideki.deliverNext();
        uint256 summaryId = platform.lastId();

        // Shannon stage 1: the JSON agent's committee returns the summary
        vm.warp(T0 + 10);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.SummaryReceived(trader, nonce, summaryId, summaryHash, SUMMARY);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        uint256 llmId = platform.lastId();
        assertEq(llmId, summaryId + 1);

        // Shannon stage 2: the LLM committee classifies; the tier goes back over Hyperlane
        vm.warp(T0 + 12);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.VerdictTallied(trader, nonce, llmId, Tier.Block, 0, 0, 3, 3);
        vm.expectEmit(true, false, false, true, address(reviewer));
        emit RiskReviewer.VerdictSent(trader, nonce, Tier.Block, keccak256(abi.encode(SHANNON, uint256(1))));
        _success(llmId, _three("BLOCK", "Block", "BLOCK - repeated liquidations"));
        assertEq(shannon.undelivered(), 1);

        // Shannon -> Hideki
        vm.warp(T0 + 20);
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.VerdictReceived(_sid(trader), trader, Tier.Block, llmId, summaryHash);
        shannon.deliverNext();

        _assertVerdict(trader, Tier.Block, T0 + 20, llmId, summaryHash);
        assertEq(gate.pendingOf(trader).nonce, 0);
        assertFalse(gate.allowIncrease(_sid(trader), follower), "guarded follower gets no new size");
        assertTrue(gate.allowIncrease(_sid(trader), open), "unguarded follower unaffected");

        // the reviewer paid both stages from its own balance; the fee stays on Hideki
        assertEq(address(platform).balance, SUMMARY_DEPOSIT + VERDICT_DEPOSIT);
        assertEq(address(reviewer).balance, 10 ether - SUMMARY_DEPOSIT - VERDICT_DEPOSIT);
        assertEq(address(gate).balance, FEE);

        // an OK one hour later is held: the block stands for 24 hours
        vm.warp(T0 + 20 + 1 hours);
        (uint64 heldNonce,) = _reviewOnShannon(trader, "OK", "ok", "CAUTION");
        vm.expectEmit(true, true, false, true, address(gate));
        emit RiskGate.BlockHeld(_sid(trader), trader, Tier.Ok, heldNonce);
        shannon.deliverNext();
        _assertVerdict(trader, Tier.Block, T0 + 20, llmId, summaryHash);
        assertFalse(gate.allowIncrease(_sid(trader), follower));

        // an OK review 24 hours after the block lifts it
        vm.warp(T0 + 20 + 24 hours);
        (, uint256 nextLlm) = _review(trader, "OK", "ok", "CAUTION");
        _assertVerdict(trader, Tier.Ok, T0 + 20 + 24 hours, nextLlm, summaryHash);
        assertTrue(gate.allowIncrease(_sid(trader), follower));
    }

    // A failed review or garbage output never BLOCKs and never changes a stored verdict.
    function test_garbageVerdict_keepsPrevious() public {
        // never reviewed: garbage leaves the trader unreviewed and copyable
        (uint64 nonce,) = _reviewOnShannon(trader, "BLOCKED", "maybe block", "I think BLOCK");
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.ReviewFailed(trader, nonce);
        shannon.deliverNext();
        assertEq(uint8(gate.verdictOf(trader).tier), uint8(Tier.None));
        assertTrue(gate.allowIncrease(_sid(trader), follower));

        // a real CAUTION, then garbage: the CAUTION stands as it was
        (, uint256 cautionId) = _review(trader, "CAUTION", "caution", "OK");
        uint256 cautionAt = vm.getBlockTimestamp();
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        (nonce,) = _reviewOnShannon(trader, "BLOCKS", "{\"tier\":\"BLOCK\"}", "");
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.ReviewFailed(trader, nonce);
        shannon.deliverNext();
        _assertVerdict(trader, Tier.Caution, cautionAt, cautionId, keccak256(bytes(SUMMARY)));
        assertTrue(gate.allowIncrease(_sid(trader), follower));

        // a lone BLOCK among unusable answers is not a verdict
        _review(trader, "BLOCK", "garbage", "unsure");
        _assertVerdict(trader, Tier.Caution, cautionAt, cautionId, keccak256(bytes(SUMMARY)));

        // a split committee is not a verdict
        _review(trader, "BLOCK", "OK", "CAUTION");
        _assertVerdict(trader, Tier.Caution, cautionAt, cautionId, keccak256(bytes(SUMMARY)));

        // a timed-out summary stage is not a verdict
        nonce = _request(trader);
        hideki.deliverNext();
        platform.respond(platform.lastId(), new IAgentRequester.Response[](0), IAgentRequester.ResponseStatus.TimedOut);
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.ReviewFailed(trader, nonce);
        shannon.deliverNext();

        // a failed inference stage is not a verdict
        nonce = _request(trader);
        hideki.deliverNext();
        _success(platform.lastId(), _three(SUMMARY, SUMMARY, SUMMARY));
        platform.respond(platform.lastId(), _three("BLOCK", "BLOCK", "BLOCK"), IAgentRequester.ResponseStatus.Failed);
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.ReviewFailed(trader, nonce);
        shannon.deliverNext();

        _assertVerdict(trader, Tier.Caution, cautionAt, cautionId, keccak256(bytes(SUMMARY)));
        assertTrue(gate.allowIncrease(_sid(trader), follower));
        assertEq(gate.pendingOf(trader).nonce, 0);
    }

    // A review that never comes back holds the source for the pending timeout only.
    function test_lostReview_canBeReplacedAfterTimeout() public {
        uint64 lost = _request(trader);
        hideki.deliverNext();
        uint256 lostSummary = platform.lastId();

        vm.warp(T0 + 30 minutes);
        uint64 nonce = _request(trader);
        hideki.deliverNext();
        _success(platform.lastId(), _three(SUMMARY, SUMMARY, SUMMARY));
        _success(platform.lastId(), _three("CAUTION", "CAUTION", "OK"));
        shannon.deliverNext();
        assertEq(uint8(gate.verdictOf(trader).tier), uint8(Tier.Caution));
        assertEq(nonce, lost + 1);

        // the lost review finally completes with BLOCK: stale on arrival
        _success(lostSummary, _three(SUMMARY, SUMMARY, SUMMARY));
        _success(platform.lastId(), _three("BLOCK", "BLOCK", "BLOCK"));
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.StaleVerdict(trader, lost);
        shannon.deliverNext();
        Verdict memory v = gate.verdictOf(trader);
        assertEq(uint8(v.tier), uint8(Tier.Caution));
    }

    // EVM gas per hop, mocks included (an upper bound for the contracts' own share). Not Somnia budgets: Somnia prices
    // storage differently (a cold or missing key needs ~1M gas available).
    function test_gasProfile() public {
        uint256 g = gasleft();
        _request(trader);
        emit log_named_uint("gate.requestReview", g - gasleft());

        g = gasleft();
        hideki.deliverNext();
        emit log_named_uint("reviewer.handle (stage 1 request)", g - gasleft());

        IAgentRequester.Response[] memory summaries = _three(SUMMARY, SUMMARY, SUMMARY);
        g = gasleft();
        _success(platform.lastId(), summaries);
        emit log_named_uint("reviewer.handleSummary (stage 2 request)", g - gasleft());

        IAgentRequester.Response[] memory answers = _three("BLOCK", "BLOCK", "OK");
        g = gasleft();
        _success(platform.lastId(), answers);
        emit log_named_uint("reviewer.handleVerdict (reply dispatch)", g - gasleft());

        g = gasleft();
        shannon.deliverNext();
        emit log_named_uint("gate.handle (verdict stored)", g - gasleft());
        assertEq(uint8(gate.verdictOf(trader).tier), uint8(Tier.Block));
    }
}

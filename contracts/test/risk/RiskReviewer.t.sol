// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RiskBase} from "./RiskBase.t.sol";
import {MockMailbox} from "./mocks/MockMailbox.sol";
import {MockAgentPlatform} from "./mocks/MockAgentPlatform.sol";
import {RiskReviewer} from "../../src/risk/RiskReviewer.sol";
import {RiskGate} from "../../src/risk/RiskGate.sol";
import {IMailbox} from "../../src/risk/IHyperlane.sol";
import {IAgentRequester, IJsonApiAgent, ILLMInferenceAgent} from "../../src/risk/interfaces/IAgentRequester.sol";
import {Tier, RiskMessages} from "../../src/risk/RiskTypes.sol";

contract RiskReviewerTest is RiskBase {
    string internal constant PROMPT =
        "You review perpetual-futures traders for people who copy their positions automatically. Read the 30-day stats (key=value). n/a means unknown, not safe. partial=1 means only the most recent activity was read. history=none means no trades. Answer with exactly one word: BLOCK if a follower copying this trader is likely to be wiped out (repeated liquidations or a drawdown near or above the margin), CAUTION if risk is elevated or the data is too thin to judge, OK otherwise.";

    uint256 internal constant SUMMARY_DEPOSIT = 0.03 ether + 3 * 0.03 ether;
    uint256 internal constant VERDICT_DEPOSIT = 0.03 ether + 3 * 0.07 ether;

    // ---------- helpers ----------

    /// Request on Hideki and carry it to Shannon; returns the gate nonce and the summary request id.
    function _intake(address t) internal returns (uint64 nonce, uint256 summaryId) {
        nonce = _request(t);
        hideki.deliverNext();
        summaryId = platform.lastId();
    }

    function _lastReply()
        internal
        view
        returns (address t, uint64 nonce, uint8 tier, uint256 requestId, bytes32 summaryHash)
    {
        MockMailbox.Message memory m = shannon.last();
        assertEq(m.sender, address(reviewer));
        assertEq(m.destination, HIDEKI);
        assertEq(m.recipient, _b32(address(gate)));
        return abi.decode(m.body, (address, uint64, uint8, uint256, bytes32));
    }

    function _assertFailedReply(address t, uint64 nonce) internal view {
        (address rt, uint64 rn, uint8 tier,,) = _lastReply();
        assertEq(rt, t);
        assertEq(rn, nonce);
        assertEq(tier, uint8(Tier.None));
    }

    /// Runs the inference stage with the given answers and returns the tier the reviewer sent back.
    function _tierFor(IAgentRequester.Response[] memory answers) internal returns (Tier) {
        address t = address(uint160(uint256(keccak256(abi.encode(answers.length, platform.count())))));
        (, uint256 summaryId) = _intake(t);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        _success(platform.lastId(), answers);
        (,, uint8 tier,,) = _lastReply();
        return Tier(tier);
    }

    // ---------- wiring ----------

    function test_defaults() public view {
        assertEq(address(reviewer.PLATFORM()), address(platform));
        assertEq(address(reviewer.MAILBOX()), address(shannon));
        assertEq(reviewer.GATE_DOMAIN(), HIDEKI);
        assertEq(reviewer.gate(), address(gate));
        assertEq(reviewer.baseUrl(), BASE_URL);
        assertEq(reviewer.systemPrompt(), PROMPT);
        assertEq(reviewer.jsonAgentId(), 13174292974160097713);
        assertEq(reviewer.llmAgentId(), 12847293847561029384);
        assertEq(reviewer.COMMITTEE_SIZE(), 3);
        assertEq(reviewer.COMMITTEE_THRESHOLD(), 2);
        (uint256 s, uint256 v) = reviewer.quote();
        assertEq(s, SUMMARY_DEPOSIT);
        assertEq(v, VERDICT_DEPOSIT);
    }

    // Only the gate on Hideki, through the Shannon mailbox, can start a review.
    function test_reviewerHandle_rejectsWrongOriginSenderOrCaller() public {
        bytes memory body = RiskMessages.encodeRequest(trader, 1);

        vm.prank(stranger);
        vm.expectRevert(RiskReviewer.NotMailbox.selector);
        reviewer.handle(HIDEKI, _b32(address(gate)), body);

        MockMailbox rogue = new MockMailbox(SHANNON);
        vm.expectRevert(RiskReviewer.NotMailbox.selector);
        rogue.process(HIDEKI, _b32(address(gate)), address(reviewer), body);

        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownOrigin.selector, SHANNON));
        shannon.process(SHANNON, _b32(address(gate)), address(reviewer), body);

        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownSender.selector, _b32(stranger)));
        shannon.process(HIDEKI, _b32(stranger), address(reviewer), body);

        assertEq(platform.count(), 0, "nothing spent");
        shannon.process(HIDEKI, _b32(address(gate)), address(reviewer), body);
        assertEq(platform.count(), 1);
    }

    // Stage 1: the JSON agent fetches `summary` from baseUrl + the lowercase trader address.
    function test_stage1_fetchesSummaryFromTheEndpoint() public {
        address t = address(uint160(uint256(keccak256("mixed case"))));
        string memory hexLower = vm.toLowercase(vm.toString(t));
        assertEq(bytes(hexLower).length, 42);
        uint64 nonce = _request(t);
        vm.expectEmit(true, false, false, true, address(reviewer));
        emit RiskReviewer.ReviewReceived(t, nonce);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.SummaryRequested(t, nonce, 101, SUMMARY_DEPOSIT);
        hideki.deliverNext();
        uint256 id = platform.lastId();

        MockAgentPlatform.Call memory c = platform.callOf(id);
        assertEq(c.agentId, 13174292974160097713);
        assertEq(c.callback, address(reviewer));
        assertEq(c.selector, RiskReviewer.handleSummary.selector);
        assertEq(
            c.payload,
            abi.encodeWithSelector(
                IJsonApiAgent.fetchString.selector,
                string.concat("https://copybook.example/api/risk/", hexLower),
                "summary"
            )
        );
        assertEq(c.size, 3);
        assertEq(c.threshold, 2);
        assertEq(uint8(c.consensus), uint8(IAgentRequester.ConsensusType.Threshold));
        assertEq(c.timeout, 300);
        assertEq(c.deposit, SUMMARY_DEPOSIT);
        (address jt, uint64 jn) = reviewer.summaryJobs(id);
        assertEq(jt, t);
        assertEq(jn, nonce);
    }

    // Stage 2: the LLM agent gets the stored prompt plus the agreed summary, restricted to the three words.
    function test_stage2_asksTheModelWithTheStoredPrompt() public {
        (uint64 nonce, uint256 summaryId) = _intake(trader);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.SummaryReceived(trader, nonce, summaryId, keccak256(bytes(SUMMARY)), SUMMARY);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.VerdictRequested(trader, nonce, summaryId + 1, VERDICT_DEPOSIT);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        (address consumed,) = reviewer.summaryJobs(summaryId);
        assertEq(consumed, address(0), "summary job consumed");

        uint256 id = platform.lastId();
        MockAgentPlatform.Call memory c = platform.callOf(id);
        string[] memory allowed = new string[](3);
        allowed[0] = "OK";
        allowed[1] = "CAUTION";
        allowed[2] = "BLOCK";
        string memory prompt = string.concat(PROMPT, "\nStats: ", SUMMARY);
        assertEq(reviewer.promptFor(SUMMARY), prompt);
        assertEq(c.agentId, 12847293847561029384);
        assertEq(c.callback, address(reviewer));
        assertEq(c.selector, RiskReviewer.handleVerdict.selector);
        assertEq(c.payload, abi.encodeWithSelector(ILLMInferenceAgent.inferString.selector, prompt, "", false, allowed));
        assertEq(c.size, 3);
        assertEq(c.threshold, 2);
        assertEq(uint8(c.consensus), uint8(IAgentRequester.ConsensusType.Threshold));
        assertEq(c.timeout, 300);
        assertEq(c.deposit, VERDICT_DEPOSIT);
        (address jt, uint64 jn, bytes32 jh) = reviewer.verdictJobs(id);
        assertEq(jt, trader);
        assertEq(jn, nonce);
        assertEq(jh, keccak256(bytes(SUMMARY)));
    }

    // The tier sent back, its request id and the hash of the summary the committee read.
    function test_stage2_repliesWithTheMajorityTier() public {
        (uint64 nonce, uint256 summaryId) = _intake(trader);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        uint256 id = platform.lastId();
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.VerdictTallied(trader, nonce, id, Tier.Block, 0, 1, 2, 3);
        _success(id, _three("BLOCK", "CAUTION", "block"));
        (address t, uint64 n, uint8 tier, uint256 rid, bytes32 h) = _lastReply();
        assertEq(t, trader);
        assertEq(n, nonce);
        assertEq(tier, uint8(Tier.Block));
        assertEq(rid, id);
        assertEq(h, keccak256(bytes(SUMMARY)));
        (address consumed,,) = reviewer.verdictJobs(id);
        assertEq(consumed, address(0), "verdict job consumed");
    }

    // ---------- stage 1 reduction ----------

    function test_stage1_usesTheSummaryMostValidatorsReturned() public {
        string memory other = "trades30d=1 history=partial";
        (, uint256 id) = _intake(trader);
        _success(id, _three(other, SUMMARY, SUMMARY));
        (,, bytes32 h) = reviewer.verdictJobs(platform.lastId());
        assertEq(h, keccak256(bytes(SUMMARY)));

        // a failed response does not count against the agreeing two
        (, id) = _intake(makeAddr("t2"));
        _success(id, _list(_failedResp(), _resp(SUMMARY), _resp(SUMMARY)));
        (,, h) = reviewer.verdictJobs(platform.lastId());
        assertEq(h, keccak256(bytes(SUMMARY)));
    }

    function test_stage1_withoutAgreementRepliesNone() public {
        // three different summaries
        (uint64 nonce, uint256 id) = _intake(trader);
        uint256 before = platform.count();
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.ReviewFailed(trader, nonce, id, RiskReviewer.Failure.NoSummary);
        _success(id, _three("a=1", "a=2", "a=3"));
        assertEq(platform.count(), before, "no inference bought");
        _assertFailedReply(trader, nonce);

        // a single summary is not agreement
        address t2 = makeAddr("t2");
        (nonce, id) = _intake(t2);
        _success(id, _list(_resp(SUMMARY), _failedResp(), _resp("")));
        _assertFailedReply(t2, nonce);

        // nothing usable
        address t3 = makeAddr("t3");
        (nonce, id) = _intake(t3);
        _success(id, _list(_resp(""), _raw(hex"01"), _failedResp()));
        _assertFailedReply(t3, nonce);
    }

    function test_stage1_committeeFailureRepliesNone() public {
        (uint64 nonce, uint256 id) = _intake(trader);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.ReviewFailed(trader, nonce, id, RiskReviewer.Failure.CommitteeFailed);
        platform.respond(id, _three(SUMMARY, SUMMARY, SUMMARY), IAgentRequester.ResponseStatus.Failed);
        _assertFailedReply(trader, nonce);

        address t2 = makeAddr("t2");
        (nonce, id) = _intake(t2);
        platform.respond(id, new IAgentRequester.Response[](0), IAgentRequester.ResponseStatus.TimedOut);
        _assertFailedReply(t2, nonce);
    }

    // ---------- stage 2 reduction ----------

    function test_classify() public view {
        assertEq(uint8(reviewer.classify("OK")), uint8(Tier.Ok));
        assertEq(uint8(reviewer.classify("ok")), uint8(Tier.Ok));
        assertEq(uint8(reviewer.classify("  Block\n")), uint8(Tier.Block));
        assertEq(uint8(reviewer.classify("BLOCK: repeated liquidations")), uint8(Tier.Block));
        assertEq(uint8(reviewer.classify("Caution - thin data")), uint8(Tier.Caution));
        assertEq(uint8(reviewer.classify("**CAUTION**")), uint8(Tier.Caution));
        assertEq(uint8(reviewer.classify("\"ok\".")), uint8(Tier.Ok));
        assertEq(uint8(reviewer.classify("OKAY")), uint8(Tier.None));
        assertEq(uint8(reviewer.classify("BLOCKED")), uint8(Tier.None));
        assertEq(uint8(reviewer.classify("not ok")), uint8(Tier.None));
        assertEq(uint8(reviewer.classify("")), uint8(Tier.None));
        assertEq(uint8(reviewer.classify("   ")), uint8(Tier.None));
        assertEq(uint8(reviewer.classify("I cannot tell")), uint8(Tier.None));
        assertEq(uint8(reviewer.classify("C")), uint8(Tier.None));
    }

    // A tier needs a strict majority of the successful responses and at least the committee threshold.
    function test_stage2_strictMajority() public {
        assertEq(uint8(_tierFor(_three("BLOCK", "BLOCK", "OK"))), uint8(Tier.Block));
        assertEq(uint8(_tierFor(_three("ok", " OK", "CAUTION"))), uint8(Tier.Ok));
        assertEq(uint8(_tierFor(_three("caution: thin", "CAUTION", "Caution"))), uint8(Tier.Caution));
        assertEq(uint8(_tierFor(_list(_resp("BLOCK"), _resp("BLOCK"), _failedResp()))), uint8(Tier.Block));

        assertEq(uint8(_tierFor(_three("BLOCK", "OK", "CAUTION"))), uint8(Tier.None), "split");
        assertEq(uint8(_tierFor(_three("BLOCK", "garbage", "maybe"))), uint8(Tier.None), "one of three");
        assertEq(uint8(_tierFor(_list(_resp("BLOCK"), _resp("nope"), _failedResp()))), uint8(Tier.None), "1 of 2");
        assertEq(uint8(_tierFor(_list(_resp("BLOCK"), _failedResp(), _failedResp()))), uint8(Tier.None), "alone");
        assertEq(uint8(_tierFor(new IAgentRequester.Response[](0))), uint8(Tier.None), "empty");
    }

    // Malformed or oversized results are unparseable answers, never a revert.
    function test_stage2_malformedResultsAreIgnored() public {
        bytes memory wrongOffset = abi.encode(uint256(64), uint256(5), bytes32("BLOCK"));
        bytes memory shortLength = abi.encodePacked(uint256(32), uint256(500), bytes32("BLOCK"));
        bytes memory huge = abi.encode(string(new bytes(2_000)));
        assertEq(uint8(_tierFor(_list(_raw(wrongOffset), _raw(shortLength), _raw(huge)))), uint8(Tier.None));
        assertEq(uint8(_tierFor(_list(_raw(hex"00"), _raw(""), _raw(abi.encode(uint256(3)))))), uint8(Tier.None));
        assertEq(uint8(_tierFor(_list(_raw(huge), _resp("BLOCK"), _resp("BLOCK")))), uint8(Tier.Block));
    }

    function test_stage2_committeeFailureRepliesNone() public {
        (uint64 nonce, uint256 summaryId) = _intake(trader);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        uint256 id = platform.lastId();
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.ReviewFailed(trader, nonce, id, RiskReviewer.Failure.CommitteeFailed);
        platform.respond(id, _three("BLOCK", "BLOCK", "BLOCK"), IAgentRequester.ResponseStatus.TimedOut);
        _assertFailedReply(trader, nonce);
    }

    // ---------- funding and platform failures ----------

    function test_unfunded_repliesNoneWithoutSpending() public {
        vm.prank(owner);
        reviewer.withdraw(owner, 10 ether - (SUMMARY_DEPOSIT + VERDICT_DEPOSIT) + 1);
        uint256 balance = address(reviewer).balance;

        uint64 nonce = _request(trader);
        vm.expectEmit(true, false, false, true, address(reviewer));
        emit RiskReviewer.Unfunded(trader, nonce, SUMMARY_DEPOSIT + VERDICT_DEPOSIT, balance);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.ReviewFailed(trader, nonce, 0, RiskReviewer.Failure.Unfunded);
        hideki.deliverNext();
        assertEq(platform.count(), 0);
        assertEq(address(reviewer).balance, balance);
        _assertFailedReply(trader, nonce);

        // the reply reaches the gate as a failed review
        vm.expectEmit(true, false, false, true, address(gate));
        emit RiskGate.ReviewFailed(trader, nonce);
        shannon.deliverNext();
    }

    function test_unfundedBetweenStages_repliesNone() public {
        (uint64 nonce, uint256 summaryId) = _intake(trader);
        uint256 left = address(reviewer).balance;
        vm.prank(owner);
        reviewer.withdraw(owner, left - VERDICT_DEPOSIT + 1);

        vm.expectEmit(true, false, false, true, address(reviewer));
        emit RiskReviewer.Unfunded(trader, nonce, VERDICT_DEPOSIT, VERDICT_DEPOSIT - 1);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        assertEq(platform.count(), 1, "no inference bought");
        _assertFailedReply(trader, nonce);
    }

    function test_platformRejection_repliesNone() public {
        platform.setRejectRequests(true);
        uint64 nonce = _request(trader);
        vm.expectEmit(true, true, false, true, address(reviewer));
        emit RiskReviewer.ReviewFailed(trader, nonce, 0, RiskReviewer.Failure.AgentUnavailable);
        hideki.deliverNext();
        _assertFailedReply(trader, nonce);

        platform.setRejectRequests(false);
        platform.setBrokenQuotes(true);
        address t2 = makeAddr("t2");
        nonce = _request(t2);
        hideki.deliverNext();
        _assertFailedReply(t2, nonce);

        // rejected at stage 2
        platform.setBrokenQuotes(false);
        address t3 = makeAddr("t3");
        uint256 summaryId;
        (nonce, summaryId) = _intake(t3);
        platform.setRejectRequests(true);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        _assertFailedReply(t3, nonce);
    }

    // A reply the mailbox refuses is reported, not reverted (the platform's callback must not fail).
    function test_replyFailure_isReported() public {
        (uint64 nonce, uint256 summaryId) = _intake(trader);
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        uint256 id = platform.lastId();
        uint256 sent = shannon.outboxLength();
        shannon.setFee(100 ether);
        vm.expectEmit(true, false, false, true, address(reviewer));
        emit RiskReviewer.ReplyFailed(trader, nonce, Tier.Ok);
        _success(id, _three("OK", "OK", "OK"));
        assertEq(shannon.outboxLength(), sent);

        // a payable quote is paid from the reviewer's balance
        shannon.setFee(0.01 ether);
        (, summaryId) = _intake(makeAddr("t2"));
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        _success(platform.lastId(), _three("OK", "OK", "OK"));
        assertEq(shannon.last().value, 0.01 ether);
    }

    // ---------- callbacks ----------

    function test_callbacks_onlyPlatformAndOnce() public {
        IAgentRequester.Response[] memory rs = _three(SUMMARY, SUMMARY, SUMMARY);
        IAgentRequester.Request memory r;
        vm.prank(stranger);
        vm.expectRevert(RiskReviewer.NotPlatform.selector);
        reviewer.handleSummary(1, rs, IAgentRequester.ResponseStatus.Success, r);
        vm.prank(stranger);
        vm.expectRevert(RiskReviewer.NotPlatform.selector);
        reviewer.handleVerdict(1, rs, IAgentRequester.ResponseStatus.Success, r);

        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownRequest.selector, 999));
        platform.respondAs(address(reviewer), RiskReviewer.handleSummary.selector, 999);
        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownRequest.selector, 999));
        platform.respondAs(address(reviewer), RiskReviewer.handleVerdict.selector, 999);

        (, uint256 summaryId) = _intake(trader);
        _success(summaryId, rs);
        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownRequest.selector, summaryId));
        _success(summaryId, rs);
        // a summary request id is not a verdict request id
        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownRequest.selector, summaryId));
        platform.respondAs(address(reviewer), RiskReviewer.handleVerdict.selector, summaryId);

        uint256 id = platform.lastId();
        _success(id, _three("OK", "OK", "OK"));
        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownRequest.selector, id));
        _success(id, _three("BLOCK", "BLOCK", "BLOCK"));
    }

    // ---------- owner ----------

    function test_owner_controls() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(unauthorized);
        reviewer.setBaseUrl("x");
        vm.expectRevert(unauthorized);
        reviewer.setSystemPrompt("x");
        vm.expectRevert(unauthorized);
        reviewer.setGate(stranger);
        vm.expectRevert(unauthorized);
        reviewer.setAgents(1, 2);
        vm.expectRevert(unauthorized);
        reviewer.withdraw(stranger, 1);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(RiskReviewer.EmptyValue.selector);
        reviewer.setBaseUrl("");
        vm.expectRevert(RiskReviewer.EmptyValue.selector);
        reviewer.setSystemPrompt("");
        vm.expectRevert(RiskReviewer.ZeroAddress.selector);
        reviewer.setGate(address(0));
        vm.expectRevert(RiskReviewer.EmptyValue.selector);
        reviewer.setAgents(0, 2);
        vm.expectRevert(RiskReviewer.EmptyValue.selector);
        reviewer.setAgents(1, 0);
        vm.expectRevert(RiskReviewer.RenounceDisabled.selector);
        reviewer.renounceOwnership();

        vm.expectEmit(false, false, false, true, address(reviewer));
        emit RiskReviewer.BaseUrlSet("https://x.example/r/");
        reviewer.setBaseUrl("https://x.example/r/");
        vm.expectEmit(false, false, false, true, address(reviewer));
        emit RiskReviewer.SystemPromptSet("Say OK.");
        reviewer.setSystemPrompt("Say OK.");
        vm.expectEmit(false, false, false, true, address(reviewer));
        emit RiskReviewer.AgentsSet(11, 22);
        reviewer.setAgents(11, 22);
        vm.stopPrank();

        (, uint256 summaryId) = _intake(trader);
        MockAgentPlatform.Call memory c = platform.callOf(summaryId);
        assertEq(c.agentId, 11);
        assertEq(
            c.payload,
            abi.encodeWithSelector(
                IJsonApiAgent.fetchString.selector,
                string.concat("https://x.example/r/", vm.toLowercase(vm.toString(trader))),
                "summary"
            )
        );
        _success(summaryId, _three(SUMMARY, SUMMARY, SUMMARY));
        c = platform.callOf(platform.lastId());
        assertEq(c.agentId, 22);
        assertEq(reviewer.promptFor("s"), "Say OK.\nStats: s");

        // a re-pointed gate: the old one can no longer start reviews, replies go to the new one
        address newGate = makeAddr("newGate");
        vm.expectEmit(false, false, false, true, address(reviewer));
        emit RiskReviewer.GateSet(newGate);
        vm.prank(owner);
        reviewer.setGate(newGate);
        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.UnknownSender.selector, _b32(address(gate))));
        shannon.process(HIDEKI, _b32(address(gate)), address(reviewer), RiskMessages.encodeRequest(trader, 9));
        _success(platform.lastId(), _three("OK", "OK", "OK"));
        assertEq(shannon.last().recipient, _b32(newGate));
    }

    function test_funding_andWithdraw() public {
        (bool ok,) = address(reviewer).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(reviewer).balance, 11 ether);

        address to = makeAddr("treasury");
        vm.startPrank(owner);
        vm.expectRevert(RiskReviewer.ZeroAddress.selector);
        reviewer.withdraw(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(RiskReviewer.InsufficientBalance.selector, 12 ether, 11 ether));
        reviewer.withdraw(to, 12 ether);
        vm.expectEmit(true, false, false, true, address(reviewer));
        emit RiskReviewer.Withdrawn(to, 4 ether);
        reviewer.withdraw(to, 4 ether);
        vm.stopPrank();
        assertEq(to.balance, 4 ether);
    }

    function test_constructor_rejectsZeroWiring() public {
        vm.expectRevert(RiskReviewer.ZeroAddress.selector);
        new RiskReviewer(
            owner, IAgentRequester(address(0)), IMailbox(address(shannon)), HIDEKI, address(gate), BASE_URL
        );
        vm.expectRevert(RiskReviewer.ZeroAddress.selector);
        new RiskReviewer(
            owner, IAgentRequester(address(platform)), IMailbox(address(0)), HIDEKI, address(gate), BASE_URL
        );
        vm.expectRevert(RiskReviewer.ZeroAddress.selector);
        new RiskReviewer(
            owner, IAgentRequester(address(platform)), IMailbox(address(shannon)), HIDEKI, address(0), BASE_URL
        );
        vm.expectRevert(RiskReviewer.EmptyValue.selector);
        new RiskReviewer(
            owner, IAgentRequester(address(platform)), IMailbox(address(shannon)), HIDEKI, address(gate), ""
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockMailbox} from "./mocks/MockMailbox.sol";
import {MockAgentPlatform} from "./mocks/MockAgentPlatform.sol";
import {RiskGate} from "../../src/risk/RiskGate.sol";
import {RiskReviewer} from "../../src/risk/RiskReviewer.sol";
import {IMailbox} from "../../src/risk/IHyperlane.sol";
import {IAgentRequester} from "../../src/risk/interfaces/IAgentRequester.sol";
import {Tier, Verdict, RiskMessages} from "../../src/risk/RiskTypes.sol";
import {SourceKind} from "../../src/Types.sol";

abstract contract RiskBase is Test {
    uint32 internal constant HIDEKI = 50383;
    uint32 internal constant SHANNON = 50312;
    uint256 internal constant FEE = 0.5 ether;
    uint256 internal constant T0 = 1_800_000_000;
    string internal constant BASE_URL = "https://copybook.example/api/risk/";
    string internal constant SUMMARY =
        "trades30d=41 activeDays30d=12 markets=2 realizedPnl30d=-812.40 liquidations30d=3 maxDrawdown30d=1900.00 maxDrawdownPct30d=n/a partial=0";

    MockMailbox internal hideki;
    MockMailbox internal shannon;
    MockAgentPlatform internal platform;
    RiskGate internal gate;
    RiskReviewer internal reviewer;

    address internal owner = makeAddr("owner");
    address internal trader = makeAddr("trader");
    address internal follower = makeAddr("follower");
    address internal requester = makeAddr("requester");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(T0);
        hideki = new MockMailbox(HIDEKI);
        shannon = new MockMailbox(SHANNON);
        hideki.pair(shannon);
        shannon.pair(hideki);
        platform = new MockAgentPlatform();

        gate = new RiskGate(owner, IMailbox(address(hideki)), SHANNON);
        reviewer = new RiskReviewer(
            owner, IAgentRequester(address(platform)), IMailbox(address(shannon)), HIDEKI, address(gate), BASE_URL
        );
        vm.prank(owner);
        gate.setReviewer(address(reviewer));

        vm.deal(address(reviewer), 10 ether);
        vm.deal(requester, 100 ether);
    }

    // ---------- helpers ----------

    function _sid(address t) internal pure returns (bytes32) {
        return keccak256(abi.encode(SourceKind.Trader, uint256(uint160(t))));
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _request(address t) internal returns (uint64 nonce) {
        vm.prank(requester);
        nonce = gate.requestReview{value: FEE}(t);
    }

    function _resp(string memory s) internal pure returns (IAgentRequester.Response memory r) {
        r.validator = address(0x7A1);
        r.result = abi.encode(s);
        r.status = IAgentRequester.ResponseStatus.Success;
    }

    function _raw(bytes memory result) internal pure returns (IAgentRequester.Response memory r) {
        r.validator = address(0x7A1);
        r.result = result;
        r.status = IAgentRequester.ResponseStatus.Success;
    }

    function _failedResp() internal pure returns (IAgentRequester.Response memory r) {
        r.validator = address(0x7A1);
        r.status = IAgentRequester.ResponseStatus.Failed;
    }

    function _list(
        IAgentRequester.Response memory a,
        IAgentRequester.Response memory b,
        IAgentRequester.Response memory c
    ) internal pure returns (IAgentRequester.Response[] memory rs) {
        rs = new IAgentRequester.Response[](3);
        rs[0] = a;
        rs[1] = b;
        rs[2] = c;
    }

    function _three(string memory a, string memory b, string memory c)
        internal
        pure
        returns (IAgentRequester.Response[] memory)
    {
        return _list(_resp(a), _resp(b), _resp(c));
    }

    function _success(uint256 id, IAgentRequester.Response[] memory rs) internal {
        platform.respond(id, rs, IAgentRequester.ResponseStatus.Success);
    }

    /// Runs one whole review: request on Hideki, carry it to Shannon, answer both committee stages, carry the
    /// verdict back. Returns the gate nonce and the inference request id.
    function _review(address t, string memory a, string memory b, string memory c)
        internal
        returns (uint64 nonce, uint256 llmId)
    {
        (nonce, llmId) = _reviewOnShannon(t, a, b, c);
        shannon.deliverNext();
    }

    /// `_review` up to the reply waiting in the Shannon mailbox.
    function _reviewOnShannon(address t, string memory a, string memory b, string memory c)
        internal
        returns (uint64 nonce, uint256 llmId)
    {
        nonce = _request(t);
        hideki.deliverNext();
        _success(platform.lastId(), _three(SUMMARY, SUMMARY, SUMMARY));
        llmId = platform.lastId();
        _success(llmId, _three(a, b, c));
    }

    /// Delivers a verdict to the gate as the reviewer, through the Hideki mailbox.
    function _deliverVerdict(address t, uint64 nonce, uint8 tier, uint256 requestId, bytes32 summaryHash) internal {
        hideki.process(
            SHANNON,
            _b32(address(reviewer)),
            address(gate),
            RiskMessages.encodeVerdict(t, nonce, tier, requestId, summaryHash)
        );
    }

    function _assertVerdict(address t, Tier tier, uint256 reviewedAt, uint256 requestId, bytes32 h) internal view {
        Verdict memory v = gate.verdictOf(t);
        assertEq(uint8(v.tier), uint8(tier), "tier");
        assertEq(v.reviewedAt, reviewedAt, "reviewedAt");
        assertEq(v.shannonRequestId, requestId, "requestId");
        assertEq(v.summaryHash, h, "summaryHash");
    }
}

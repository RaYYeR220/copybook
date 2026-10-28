// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IMailbox, IMessageRecipient} from "./IHyperlane.sol";
import {IAgentRequester, IJsonApiAgent, ILLMInferenceAgent} from "./interfaces/IAgentRequester.sol";
import {Tier, RiskMessages} from "./RiskTypes.sol";

/// @title RiskReviewer
/// @notice Reviews a trader for the gate on Hideki using two Somnia validator committees on Shannon. A review
/// request arrives over Hyperlane; stage 1 has the JSON API agent fetch the trader's risk summary from
/// `baseUrl + <trader>` (field `summary`); stage 2 has the LLM agent classify that summary as OK, CAUTION or
/// BLOCK. The reduced tier goes back to the gate over Hyperlane. Every accepted request ends in a reply: on any
/// failure (unfunded, platform refusal, committee failure or timeout, no agreed summary, no majority tier) the
/// reply carries `Tier.None`, which the gate treats as "no verdict".
/// @dev Agent deposits are paid from this contract's balance; the owner funds it.
contract RiskReviewer is IMessageRecipient, Ownable2Step {
    using Strings for address;

    uint256 public constant DEFAULT_JSON_AGENT_ID = 13174292974160097713;
    uint256 public constant DEFAULT_LLM_AGENT_ID = 12847293847561029384;
    /// @notice Validators asked per stage, and the responses each stage needs (Threshold consensus).
    uint256 public constant COMMITTEE_SIZE = 3;
    uint256 public constant COMMITTEE_THRESHOLD = 2;
    /// @notice Seconds the platform waits for a committee before reporting a timeout.
    uint256 public constant REQUEST_TIMEOUT = 300;
    /// @notice Per-validator reward on top of the platform's deposit floor.
    uint256 public constant JSON_PER_AGENT_COST = 0.03 ether;
    uint256 public constant LLM_PER_AGENT_COST = 0.07 ether;
    /// @notice Longest summary or answer read from a validator; longer results are ignored.
    uint256 public constant MAX_TEXT_BYTES = 1024;
    string public constant SUMMARY_FIELD = "summary";
    string public constant DEFAULT_SYSTEM_PROMPT =
        "You review perpetual-futures traders for people who copy their positions automatically. Read the 30-day stats (key=value). n/a means unknown, not safe. partial=1 means only the most recent activity was read. history=none means no trades. Answer with exactly one word: BLOCK if a follower copying this trader is likely to be wiped out (repeated liquidations or a drawdown near or above the margin), CAUTION if risk is elevated or the data is too thin to judge, OK otherwise.";

    enum Failure {
        Unfunded,
        AgentUnavailable,
        CommitteeFailed,
        NoSummary,
        NoMajority
    }

    struct SummaryJob {
        address trader;
        uint64 nonce;
    }

    struct VerdictJob {
        address trader;
        uint64 nonce;
        bytes32 summaryHash;
    }

    IAgentRequester public immutable PLATFORM;
    IMailbox public immutable MAILBOX;
    /// @notice Hyperlane domain of the gate's chain (Hideki, 50383).
    uint32 public immutable GATE_DOMAIN;

    address public gate;
    uint256 public jsonAgentId;
    uint256 public llmAgentId;
    /// @notice Risk summary endpoint; the lowercase trader address is appended.
    string public baseUrl;
    string public systemPrompt;
    mapping(uint256 requestId => SummaryJob) public summaryJobs;
    mapping(uint256 requestId => VerdictJob) public verdictJobs;

    event ReviewReceived(address indexed trader, uint64 nonce);
    event SummaryRequested(address indexed trader, uint64 nonce, uint256 indexed requestId, uint256 deposit);
    event SummaryReceived(
        address indexed trader, uint64 nonce, uint256 indexed requestId, bytes32 summaryHash, string summary
    );
    event VerdictRequested(address indexed trader, uint64 nonce, uint256 indexed requestId, uint256 deposit);
    /// @dev Votes per tier among the successful responses; `responded` also counts unparseable ones.
    event VerdictTallied(
        address indexed trader,
        uint64 nonce,
        uint256 indexed requestId,
        Tier tier,
        uint8 ok,
        uint8 caution,
        uint8 blocked,
        uint8 responded
    );
    /// @dev `requestId` is the review's latest platform request (summary or inference), or 0 when none was made;
    /// `summaryHash` is the agreed summary's hash, or 0 when none was agreed.
    event ReviewFailed(
        address indexed trader, uint64 nonce, uint256 indexed requestId, bytes32 summaryHash, Failure reason
    );
    event Unfunded(address indexed trader, uint64 nonce, uint256 needed, uint256 available);
    event VerdictSent(address indexed trader, uint64 nonce, Tier tier, bytes32 messageId);
    /// @notice The reply could not be dispatched; the gate's pending review expires after its timeout.
    event ReplyFailed(address indexed trader, uint64 nonce, Tier tier);
    event BaseUrlSet(string baseUrl);
    event SystemPromptSet(string systemPrompt);
    event GateSet(address gate);
    event AgentsSet(uint256 jsonAgentId, uint256 llmAgentId);
    event Withdrawn(address indexed to, uint256 amount);

    error NotMailbox();
    error UnknownOrigin(uint32 origin);
    error UnknownSender(bytes32 sender);
    error NotPlatform();
    error UnknownRequest(uint256 requestId);
    error ZeroAddress();
    error InvalidDomain(uint32 domain);
    error EmptyValue();
    error RenounceDisabled();
    error TransferFailed();
    error InsufficientBalance(uint256 requested, uint256 available);

    /// @param platform_ Somnia's agent platform on this chain
    /// @param mailbox_ the Hyperlane Mailbox on this chain
    /// @param gateDomain_ the Hyperlane domain the gate lives on; neither 0 nor this chain's
    /// @param gate_ the gate, the only sender whose requests are accepted and the recipient of every reply
    /// @param baseUrl_ risk summary endpoint prefix, e.g. `https://host/api/risk/`
    constructor(
        address owner_,
        IAgentRequester platform_,
        IMailbox mailbox_,
        uint32 gateDomain_,
        address gate_,
        string memory baseUrl_
    ) Ownable(owner_) {
        if (address(platform_) == address(0) || address(mailbox_) == address(0) || gate_ == address(0)) {
            revert ZeroAddress();
        }
        if (!RiskMessages.isRemoteDomain(address(mailbox_), gateDomain_)) revert InvalidDomain(gateDomain_);
        if (bytes(baseUrl_).length == 0) revert EmptyValue();
        PLATFORM = platform_;
        MAILBOX = mailbox_;
        GATE_DOMAIN = gateDomain_;
        gate = gate_;
        baseUrl = baseUrl_;
        systemPrompt = DEFAULT_SYSTEM_PROMPT;
        jsonAgentId = DEFAULT_JSON_AGENT_ID;
        llmAgentId = DEFAULT_LLM_AGENT_ID;
    }

    /// @notice Funds agent deposits.
    receive() external payable {}

    // ---------------------------------------------------------------- intake

    /// @notice Starts a review requested by the gate. Only the local Mailbox may call, and only for a message from
    /// the gate on `GATE_DOMAIN`. Once accepted, nothing here reverts: every failure is answered with `Tier.None`.
    function handle(uint32 origin, bytes32 sender, bytes calldata body) external payable {
        if (msg.sender != address(MAILBOX)) revert NotMailbox();
        if (origin != GATE_DOMAIN) revert UnknownOrigin(origin);
        if (sender != RiskMessages.toBytes32(gate)) revert UnknownSender(sender);

        (address trader, uint64 nonce) = RiskMessages.decodeRequest(body);
        emit ReviewReceived(trader, nonce);

        (bool quoted, uint256 summaryDeposit, uint256 verdictDeposit) = _quote();
        if (!quoted) return _fail(trader, nonce, 0, bytes32(0), Failure.AgentUnavailable);
        // Both stages up front: a summary bought without the means to classify it is wasted.
        if (!_funded(trader, nonce, summaryDeposit + verdictDeposit)) {
            return _fail(trader, nonce, 0, bytes32(0), Failure.Unfunded);
        }

        bytes memory payload = abi.encodeWithSelector(
            IJsonApiAgent.fetchString.selector, string.concat(baseUrl, trader.toHexString()), SUMMARY_FIELD
        );
        try PLATFORM.createAdvancedRequest{value: summaryDeposit}(
            jsonAgentId,
            address(this),
            this.handleSummary.selector,
            payload,
            COMMITTEE_SIZE,
            COMMITTEE_THRESHOLD,
            IAgentRequester.ConsensusType.Threshold,
            REQUEST_TIMEOUT
        ) returns (
            uint256 requestId
        ) {
            summaryJobs[requestId] = SummaryJob(trader, nonce);
            emit SummaryRequested(trader, nonce, requestId, summaryDeposit);
        } catch {
            _fail(trader, nonce, 0, bytes32(0), Failure.AgentUnavailable);
        }
    }

    // ---------------------------------------------------------------- stage 1: summary

    /// @notice Platform callback for the summary fetch. Takes the summary most validators returned (at least
    /// `COMMITTEE_THRESHOLD` identical copies) and asks the LLM committee to classify it.
    function handleSummary(
        uint256 requestId,
        IAgentRequester.Response[] calldata responses,
        IAgentRequester.ResponseStatus status,
        IAgentRequester.Request calldata
    ) external {
        if (msg.sender != address(PLATFORM)) revert NotPlatform();
        SummaryJob memory job = summaryJobs[requestId];
        if (job.trader == address(0)) revert UnknownRequest(requestId);
        delete summaryJobs[requestId];

        if (status != IAgentRequester.ResponseStatus.Success) {
            return _fail(job.trader, job.nonce, requestId, bytes32(0), Failure.CommitteeFailed);
        }
        (bool found, string memory summary) = _agreedSummary(responses);
        if (!found) return _fail(job.trader, job.nonce, requestId, bytes32(0), Failure.NoSummary);

        bytes32 summaryHash = keccak256(bytes(summary));
        emit SummaryReceived(job.trader, job.nonce, requestId, summaryHash, summary);
        _requestVerdict(job.trader, job.nonce, requestId, summary, summaryHash);
    }

    /// @dev A failure here reports the summary request and the summary hash already known.
    function _requestVerdict(
        address trader,
        uint64 nonce,
        uint256 summaryRequestId,
        string memory summary,
        bytes32 summaryHash
    ) internal {
        (bool quoted,, uint256 deposit) = _quote();
        if (!quoted) return _fail(trader, nonce, summaryRequestId, summaryHash, Failure.AgentUnavailable);
        if (!_funded(trader, nonce, deposit)) {
            return _fail(trader, nonce, summaryRequestId, summaryHash, Failure.Unfunded);
        }

        string[] memory allowed = new string[](3);
        allowed[0] = "OK";
        allowed[1] = "CAUTION";
        allowed[2] = "BLOCK";
        bytes memory payload =
            abi.encodeWithSelector(ILLMInferenceAgent.inferString.selector, promptFor(summary), "", false, allowed);
        try PLATFORM.createAdvancedRequest{value: deposit}(
            llmAgentId,
            address(this),
            this.handleVerdict.selector,
            payload,
            COMMITTEE_SIZE,
            COMMITTEE_THRESHOLD,
            IAgentRequester.ConsensusType.Threshold,
            REQUEST_TIMEOUT
        ) returns (
            uint256 requestId
        ) {
            verdictJobs[requestId] = VerdictJob(trader, nonce, summaryHash);
            emit VerdictRequested(trader, nonce, requestId, deposit);
        } catch {
            _fail(trader, nonce, summaryRequestId, summaryHash, Failure.AgentUnavailable);
        }
    }

    // ---------------------------------------------------------------- stage 2: verdict

    /// @notice Platform callback for the classification. A tier needs a strict majority of the successful
    /// responses and at least `COMMITTEE_THRESHOLD` votes; anything else is answered with `Tier.None`.
    function handleVerdict(
        uint256 requestId,
        IAgentRequester.Response[] calldata responses,
        IAgentRequester.ResponseStatus status,
        IAgentRequester.Request calldata
    ) external {
        if (msg.sender != address(PLATFORM)) revert NotPlatform();
        VerdictJob memory job = verdictJobs[requestId];
        if (job.trader == address(0)) revert UnknownRequest(requestId);
        delete verdictJobs[requestId];

        if (status != IAgentRequester.ResponseStatus.Success) {
            return _fail(job.trader, job.nonce, requestId, job.summaryHash, Failure.CommitteeFailed);
        }

        uint256[4] memory votes;
        uint256 responded;
        for (uint256 i; i < responses.length; ++i) {
            if (responses[i].status != IAgentRequester.ResponseStatus.Success) continue;
            ++responded;
            (bool ok, string memory answer) = _text(responses[i].result);
            if (ok) ++votes[uint8(classify(answer))];
        }
        Tier tier = Tier.None;
        for (uint8 t = uint8(Tier.Ok); t <= uint8(Tier.Block); ++t) {
            if (votes[t] * 2 > responded && votes[t] >= COMMITTEE_THRESHOLD) tier = Tier(t);
        }
        emit VerdictTallied(
            job.trader,
            job.nonce,
            requestId,
            tier,
            _u8(votes[uint8(Tier.Ok)]),
            _u8(votes[uint8(Tier.Caution)]),
            _u8(votes[uint8(Tier.Block)]),
            _u8(responded)
        );
        if (tier == Tier.None) return _fail(job.trader, job.nonce, requestId, job.summaryHash, Failure.NoMajority);
        _reply(job.trader, job.nonce, tier, requestId, job.summaryHash);
    }

    // ---------------------------------------------------------------- views

    /// @return summaryDeposit the stage-1 deposit at the current platform floor
    /// @return verdictDeposit the stage-2 deposit at the current platform floor
    function quote() external view returns (uint256 summaryDeposit, uint256 verdictDeposit) {
        uint256 floor = PLATFORM.getAdvancedRequestDeposit(COMMITTEE_SIZE);
        return (floor + JSON_PER_AGENT_COST * COMMITTEE_SIZE, floor + LLM_PER_AGENT_COST * COMMITTEE_SIZE);
    }

    /// @notice The prompt stage 2 sends for `summary`.
    function promptFor(string memory summary) public view returns (string memory) {
        return string.concat(systemPrompt, "\nStats: ", summary);
    }

    /// @notice Reads one validator's answer: the first run of ASCII letters (leading non-letters skipped),
    /// case-insensitive, must be exactly OK, CAUTION or BLOCK; anything else is `Tier.None`.
    function classify(string memory answer) public pure returns (Tier) {
        bytes memory b = bytes(answer);
        uint256 n = b.length;
        uint256 i;
        while (i < n && !_isLetter(b[i])) ++i;
        uint256 start = i;
        while (i < n && _isLetter(b[i])) ++i;
        uint256 len = i - start;
        if (len == 2 && _wordIs(b, start, "OK")) return Tier.Ok;
        if (len == 7 && _wordIs(b, start, "CAUTION")) return Tier.Caution;
        if (len == 5 && _wordIs(b, start, "BLOCK")) return Tier.Block;
        return Tier.None;
    }

    // ---------------------------------------------------------------- owner

    function setBaseUrl(string calldata baseUrl_) external onlyOwner {
        if (bytes(baseUrl_).length == 0) revert EmptyValue();
        baseUrl = baseUrl_;
        emit BaseUrlSet(baseUrl_);
    }

    function setSystemPrompt(string calldata systemPrompt_) external onlyOwner {
        if (bytes(systemPrompt_).length == 0) revert EmptyValue();
        systemPrompt = systemPrompt_;
        emit SystemPromptSet(systemPrompt_);
    }

    function setGate(address gate_) external onlyOwner {
        if (gate_ == address(0)) revert ZeroAddress();
        gate = gate_;
        emit GateSet(gate_);
    }

    function setAgents(uint256 jsonAgentId_, uint256 llmAgentId_) external onlyOwner {
        if (jsonAgentId_ == 0 || llmAgentId_ == 0) revert EmptyValue();
        jsonAgentId = jsonAgentId_;
        llmAgentId = llmAgentId_;
        emit AgentsSet(jsonAgentId_, llmAgentId_);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = address(this).balance;
        if (amount > balance) revert InsufficientBalance(amount, balance);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    /// @notice Disabled: the endpoint, prompt, agents and funds must stay manageable.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------- internals

    function _quote() internal view returns (bool ok, uint256 summaryDeposit, uint256 verdictDeposit) {
        try PLATFORM.getAdvancedRequestDeposit(COMMITTEE_SIZE) returns (uint256 floor) {
            return (true, floor + JSON_PER_AGENT_COST * COMMITTEE_SIZE, floor + LLM_PER_AGENT_COST * COMMITTEE_SIZE);
        } catch {
            return (false, 0, 0);
        }
    }

    function _funded(address trader, uint64 nonce, uint256 needed) internal returns (bool) {
        uint256 available = address(this).balance;
        if (available >= needed) return true;
        emit Unfunded(trader, nonce, needed, available);
        return false;
    }

    function _fail(address trader, uint64 nonce, uint256 requestId, bytes32 summaryHash, Failure reason) internal {
        emit ReviewFailed(trader, nonce, requestId, summaryHash, reason);
        _reply(trader, nonce, Tier.None, requestId, summaryHash);
    }

    /// @dev Never reverts, so neither the Mailbox delivery nor a platform callback can fail on the way out.
    function _reply(address trader, uint64 nonce, Tier tier, uint256 requestId, bytes32 summaryHash) internal {
        bytes memory body = RiskMessages.encodeVerdict(trader, nonce, uint8(tier), requestId, summaryHash);
        bytes32 recipient = RiskMessages.toBytes32(gate);
        uint256 fee;
        try MAILBOX.quoteDispatch(GATE_DOMAIN, recipient, body) returns (uint256 quoted) {
            fee = quoted;
        } catch {
            return _replyFailed(trader, nonce, tier);
        }
        if (fee > address(this).balance) return _replyFailed(trader, nonce, tier);
        try MAILBOX.dispatch{value: fee}(GATE_DOMAIN, recipient, body) returns (bytes32 messageId) {
            emit VerdictSent(trader, nonce, tier, messageId);
        } catch {
            _replyFailed(trader, nonce, tier);
        }
    }

    function _replyFailed(address trader, uint64 nonce, Tier tier) internal {
        emit ReplyFailed(trader, nonce, tier);
    }

    /// @dev The summary returned by at least `COMMITTEE_THRESHOLD` successful responses, and by more of them than
    /// any other summary.
    function _agreedSummary(IAgentRequester.Response[] calldata responses)
        internal
        pure
        returns (bool found, string memory summary)
    {
        uint256 n = responses.length;
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            if (responses[i].status != IAgentRequester.ResponseStatus.Success) continue;
            (bool ok, string memory text) = _text(responses[i].result);
            if (ok) hashes[i] = keccak256(bytes(text));
        }
        uint256 best;
        uint256 bestCount;
        bool tied;
        for (uint256 i; i < n; ++i) {
            if (hashes[i] == bytes32(0)) continue;
            uint256 count;
            for (uint256 j; j < n; ++j) {
                if (hashes[j] == hashes[i]) ++count;
            }
            if (count > bestCount) {
                (best, bestCount, tied) = (i, count, false);
            } else if (count == bestCount && hashes[i] != hashes[best]) {
                tied = true;
            }
        }
        if (bestCount < COMMITTEE_THRESHOLD || tied) return (false, "");
        (, summary) = _text(responses[best].result);
        return (true, summary);
    }

    /// @dev Decodes an ABI-encoded string result without reverting: canonical offset, length within the data,
    /// non-empty and at most `MAX_TEXT_BYTES`.
    function _text(bytes calldata result) internal pure returns (bool ok, string memory text) {
        if (result.length < 64) return (false, "");
        if (uint256(bytes32(result[0:32])) != 32) return (false, "");
        uint256 len = uint256(bytes32(result[32:64]));
        if (len == 0 || len > MAX_TEXT_BYTES || len > result.length - 64) return (false, "");
        return (true, string(result[64:64 + len]));
    }

    function _isLetter(bytes1 c) internal pure returns (bool) {
        return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
    }

    /// @dev Case-insensitive match of `b[start:start + word.length]` against an uppercase `word`.
    function _wordIs(bytes memory b, uint256 start, bytes memory word) internal pure returns (bool) {
        for (uint256 k; k < word.length; ++k) {
            bytes1 c = b[start + k];
            if (c >= "a" && c <= "z") c = bytes1(uint8(c) - 32);
            if (c != word[k]) return false;
        }
        return true;
    }

    function _u8(uint256 x) internal pure returns (uint8) {
        return x > type(uint8).max ? type(uint8).max : uint8(x);
    }
}

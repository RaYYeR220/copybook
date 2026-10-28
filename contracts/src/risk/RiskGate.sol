// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IRiskGate} from "../interfaces/IDreamPerps.sol";
import {IMailbox, IMessageRecipient} from "./IHyperlane.sol";
import {Tier, Verdict, RiskMessages} from "./RiskTypes.sol";

/// @title RiskGate
/// @notice Holds validator-reviewed risk verdicts for traders on Hideki and answers the hub's `allowIncrease`.
/// Anyone may pay for a review of a trader; the request travels over Hyperlane to the reviewer on Shannon, whose
/// validator committees classify the trader, and the verdict comes back the same way. A follower is guarded unless
/// they opt out, and a guarded follower gets no new size from a trader whose latest verdict is a `Block` younger
/// than `VERDICT_TTL`. A milder verdict can replace a `Block` only after `BLOCK_HOLD`. Exits never reach the gate.
contract RiskGate is IRiskGate, IMessageRecipient, Ownable2Step {
    /// @notice How long a `Block` keeps blocking.
    uint256 public constant VERDICT_TTL = 7 days;
    /// @notice Minimum age of a stored `Block` before a milder verdict may replace it. A new `Block` may refresh it
    /// at any time.
    uint256 public constant BLOCK_HOLD = 24 hours;
    /// @notice Wait after a stored verdict before the same trader can be reviewed again.
    uint256 public constant REVIEW_COOLDOWN = 10 minutes;
    /// @notice Age after which an unanswered review may be replaced by a new one.
    uint256 public constant PENDING_TIMEOUT = 30 minutes;
    uint256 public constant DEFAULT_REVIEW_FEE = 0.5 ether;

    struct PendingReview {
        uint64 nonce;
        uint64 requestedAt;
    }

    IMailbox public immutable MAILBOX;
    /// @notice Hyperlane domain of the reviewer's chain (Shannon, 50312).
    uint32 public immutable REVIEWER_DOMAIN;

    address public reviewer;
    uint256 public reviewFee;
    uint64 public requestNonce;

    mapping(bytes32 sourceId => Verdict) internal _verdicts;
    mapping(address follower => bool) internal _guardOff;
    mapping(address trader => PendingReview) internal _pending;

    event ReviewRequested(address indexed trader, uint64 nonce, address indexed requester);
    event VerdictReceived(
        bytes32 indexed sourceId, address indexed trader, Tier tier, uint256 shannonRequestId, bytes32 summaryHash
    );
    /// @notice The review produced no verdict; the stored one, if any, is unchanged.
    event ReviewFailed(address indexed trader, uint64 nonce);
    /// @notice A verdict arrived for a review that is no longer pending (replaced or already answered).
    event StaleVerdict(address indexed trader, uint64 nonce);
    /// @notice A milder verdict arrived within `BLOCK_HOLD` of a stored `Block`; the `Block` stands.
    event BlockHeld(bytes32 indexed sourceId, address indexed trader, Tier newTier, uint64 nonce);
    event GuardSet(address indexed follower, bool on);
    event ReviewerSet(address reviewer);
    event ReviewFeeSet(uint256 fee);
    event Withdrawn(address indexed to, uint256 amount);

    error NotMailbox();
    error UnknownOrigin(uint32 origin);
    error UnknownSender(bytes32 sender);
    error FeeTooLow(uint256 sent, uint256 fee);
    error Pending(uint64 nonce, uint256 replaceableAt);
    error Cooldown(uint256 readyAt);
    error NoReviewer();
    error ZeroAddress();
    error InvalidDomain(uint32 domain);
    error RenounceDisabled();
    error TransferFailed();
    error InsufficientBalance(uint256 requested, uint256 available);

    /// @param mailbox_ the Hyperlane Mailbox on this chain
    /// @param reviewerDomain_ the Hyperlane domain the reviewer lives on; neither 0 nor this chain's
    constructor(address owner_, IMailbox mailbox_, uint32 reviewerDomain_) Ownable(owner_) {
        if (address(mailbox_) == address(0)) revert ZeroAddress();
        if (!RiskMessages.isRemoteDomain(address(mailbox_), reviewerDomain_)) revert InvalidDomain(reviewerDomain_);
        MAILBOX = mailbox_;
        REVIEWER_DOMAIN = reviewerDomain_;
        reviewFee = DEFAULT_REVIEW_FEE;
    }

    // ---------------------------------------------------------------- hub

    /// @inheritdoc IRiskGate
    /// @dev Total: never reverts. One storage read for an unblocked source, two for a blocked one. On Somnia a cold
    /// or missing storage key needs about 1M gas available (little of it is consumed), so the hub's `riskGateGas`
    /// must stay at or above ~1.5M; its default of 2M is enough.
    function allowIncrease(bytes32 sourceId, address follower) external view returns (bool) {
        Verdict storage v = _verdicts[sourceId];
        if (v.tier != Tier.Block) return true;
        if (block.timestamp > uint256(v.reviewedAt) + VERDICT_TTL) return true;
        return _guardOff[follower];
    }

    // ---------------------------------------------------------------- followers

    /// @notice Turns the caller's guard on or off. Every account is guarded until it opts out.
    function setGuard(bool on) external {
        _guardOff[msg.sender] = !on;
        emit GuardSet(msg.sender, on);
    }

    // ---------------------------------------------------------------- reviews

    /// @notice Pays for a validator review of `trader`. One review per trader may be pending at a time (replaceable
    /// after `PENDING_TIMEOUT`), and a trader with a stored verdict can be reviewed again after `REVIEW_COOLDOWN`.
    /// The whole payment is kept; the Hyperlane dispatch fee, if any, is paid from it.
    function requestReview(address trader) external payable returns (uint64 nonce) {
        if (trader == address(0)) revert ZeroAddress();
        address peer = reviewer;
        if (peer == address(0)) revert NoReviewer();
        uint256 fee = reviewFee;
        if (msg.value < fee) revert FeeTooLow(msg.value, fee);

        PendingReview memory p = _pending[trader];
        if (p.nonce != 0) {
            uint256 replaceableAt = uint256(p.requestedAt) + PENDING_TIMEOUT;
            if (block.timestamp < replaceableAt) revert Pending(p.nonce, replaceableAt);
        }
        uint256 reviewedAt = _verdicts[RiskMessages.traderSourceId(trader)].reviewedAt;
        if (reviewedAt != 0 && block.timestamp < reviewedAt + REVIEW_COOLDOWN) {
            revert Cooldown(reviewedAt + REVIEW_COOLDOWN);
        }

        nonce = ++requestNonce;
        _pending[trader] = PendingReview(nonce, uint64(block.timestamp));

        bytes memory body = RiskMessages.encodeRequest(trader, nonce);
        bytes32 recipient = RiskMessages.toBytes32(peer);
        uint256 dispatchFee = MAILBOX.quoteDispatch(REVIEWER_DOMAIN, recipient, body);
        MAILBOX.dispatch{value: dispatchFee}(REVIEWER_DOMAIN, recipient, body);
        emit ReviewRequested(trader, nonce, msg.sender);
    }

    /// @notice Receives a verdict from the reviewer. Only the local Mailbox may call, and only for a message from
    /// the reviewer on `REVIEWER_DOMAIN`. A verdict for anything but the trader's pending review is ignored; a
    /// failed review (tier 0, or out of range) clears the pending review and keeps the stored verdict, and so does
    /// a milder verdict arriving within `BLOCK_HOLD` of a stored `Block`.
    function handle(uint32 origin, bytes32 sender, bytes calldata body) external payable {
        if (msg.sender != address(MAILBOX)) revert NotMailbox();
        if (origin != REVIEWER_DOMAIN) revert UnknownOrigin(origin);
        address peer = reviewer;
        if (peer == address(0) || sender != RiskMessages.toBytes32(peer)) revert UnknownSender(sender);

        (address trader, uint64 nonce, uint8 tier, uint256 requestId, bytes32 summaryHash) =
            RiskMessages.decodeVerdict(body);
        if (nonce == 0 || _pending[trader].nonce != nonce) {
            emit StaleVerdict(trader, nonce);
            return;
        }
        delete _pending[trader];

        if (tier == uint8(Tier.None) || tier > uint8(Tier.Block)) {
            emit ReviewFailed(trader, nonce);
            return;
        }
        bytes32 sourceId = RiskMessages.traderSourceId(trader);
        Verdict storage current = _verdicts[sourceId];
        if (
            tier != uint8(Tier.Block) && current.tier == Tier.Block
                && block.timestamp < uint256(current.reviewedAt) + BLOCK_HOLD
        ) {
            emit BlockHeld(sourceId, trader, Tier(tier), nonce);
            return;
        }
        _verdicts[sourceId] = Verdict(Tier(tier), uint64(block.timestamp), requestId, summaryHash);
        emit VerdictReceived(sourceId, trader, Tier(tier), requestId, summaryHash);
    }

    // ---------------------------------------------------------------- views

    function verdictOf(address trader) external view returns (Verdict memory) {
        return _verdicts[RiskMessages.traderSourceId(trader)];
    }

    /// @return on whether increases for `follower` respect `Block` verdicts
    function guardOf(address follower) external view returns (bool on) {
        return !_guardOff[follower];
    }

    /// @return the trader's pending review; nonce 0 when none
    function pendingOf(address trader) external view returns (PendingReview memory) {
        return _pending[trader];
    }

    /// @notice The hub's source id for a trader.
    function sourceIdOf(address trader) public pure returns (bytes32) {
        return RiskMessages.traderSourceId(trader);
    }

    // ---------------------------------------------------------------- owner

    function setReviewer(address reviewer_) external onlyOwner {
        if (reviewer_ == address(0)) revert ZeroAddress();
        reviewer = reviewer_;
        emit ReviewerSet(reviewer_);
    }

    function setReviewFee(uint256 fee) external onlyOwner {
        reviewFee = fee;
        emit ReviewFeeSet(fee);
    }

    /// @notice Sends collected review fees.
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = address(this).balance;
        if (amount > balance) revert InsufficientBalance(amount, balance);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    /// @notice Disabled: the reviewer and fee must stay settable.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}

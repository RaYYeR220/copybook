// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaEventHandler.sol";
import {CopyEngine} from "./CopyEngine.sol";
import {GroupRelay} from "./GroupRelay.sol";
import {PolicyLib} from "./PolicyLib.sol";
import {ThemeRegistry} from "./ThemeRegistry.sol";
import {Leg, Policy, Reason, SourceKind} from "./Types.sol";
import {IMarginBank} from "./interfaces/IDreamPerps.sol";

/// @title CopybookHub
/// @notice The operator followers link on dreamDEX. Keeps each follower's perp positions in sync with
/// one source under the follower's Policy: a trader's live book, or a thesis basket from ThemeRegistry.
/// In the markets a follow manages, reductions are never gated; increases are fill-or-kill priced inside
/// the follower's band and pass every policy gate first. A thesis opens all its legs or none.
/// The per-follower sync runs in the linked CopyEngine library, on this contract's storage.
contract CopybookHub is Ownable2Step, ReentrancyGuard {
    error AlreadyFollowing();
    error NotFollowing();
    error TankTooLow();
    error InsufficientTank();
    error TransferFailed();
    error InvalidSource();
    error ForeignPool();
    error TooManyPools();
    error FollowsPaused();
    error InvalidGroupSize();
    error NotRelay();
    error BadEvent();
    error StillBelowFloor();
    error NotSelf();
    error TankFloor();
    error UnsubscribeOutOfGas();
    error OutOfGasInSync();
    error SubscriptionUnreadable();
    error JoinPoolsNotAllowed();
    error LegFailed(address pool, bytes venueError);
    error NotThemeFollow();
    /// @dev `field`: 1-based position of the rejected argument of the admin call.
    error InvalidParam(uint8 field);
    error InsufficientSurplus();
    error NotOrphan();
    error NoMembers();
    error GasLimitTooLow();
    error NotOwnSubscription();
    error RenounceDisabled();
    error FlattenPending();

    event Followed(address indexed follower, bytes32 indexed sourceId, SourceKind kind, uint256 ref);
    event Unfollowed(address indexed follower, bytes32 indexed sourceId, bool flattened);
    event PolicyUpdated(address indexed follower);
    event Resumed(address indexed follower);
    event Copied(
        address indexed follower,
        bytes32 indexed sourceId,
        address indexed pool,
        int256 fromSize,
        int256 toSize,
        uint256 price,
        bool capped
    );
    event Refused(
        address indexed follower, bytes32 indexed sourceId, address indexed pool, Reason reason, bytes venueError
    );
    event Stopped(address indexed follower, int256 equity);
    event GroupOpened(bytes32 indexed sourceId, uint32 group, address relay, uint256 subscriptionId);
    event TankCharged(address indexed follower, uint256 amount);
    event GroupClosed(bytes32 indexed sourceId, uint32 group, uint256 subscriptionId, bool cancelled);
    event Deferred(address indexed follower, bytes32 indexed sourceId);
    /// @notice The handler stopped early: members `fromIndex` onward of the group, as listed by
    /// membersOf at that block, were not synced and wait for catchUp. Read the list at the event's block:
    /// an unfollow moves the group's last member into the leaver's seat. The member at `fromIndex` may
    /// already have had its exits.
    event GroupDeferred(bytes32 indexed sourceId, uint32 group, uint256 fromIndex);
    event RiskGateSet(address gate);
    event SubParamsSet(
        uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 traderGasLimit, uint64 themeGasLimit, bool guaranteed
    );
    event GasParamsSet(
        uint64 floor,
        uint64 perFollowerCap,
        uint64 themePerFollowerCap,
        uint64 tailBase,
        uint64 perDefer,
        uint64 chargeOverhead
    );
    event NewFollowsPaused(bool paused);
    event SurplusWithdrawn(address indexed to, uint256 amount);
    /// @notice An owner attempt to cancel a recorded orphan; a failed one stays recorded.
    event OrphanCancelled(uint256 subscriptionId, bool cancelled);
    /// @notice A pending flatten was released with this position still open: dust the venue cannot take, or a
    /// market it could not price.
    event FlattenIncomplete(address indexed follower, address indexed pool);

    struct SubParams {
        uint64 priorityFeePerGas;
        uint64 maxFeePerGas;
        uint64 traderGasLimit;
        uint64 themeGasLimit;
        bool guaranteed;
    }

    /// @dev Gas budget of a group handler. Each member runs its exits in one self-call on everything above
    /// the reserve, then its increases in a second one of at least `floor` and at most `perFollowerCap`
    /// (`themePerFollowerCap` for a theme member, which syncs every leg). The handler always keeps
    /// `tailBase + perDefer * remainingMembers` (plus a fixed allowance for one Deferred and its latch) back so
    /// it can still report the rest of the group as deferred. Each member is billed its measured gas plus `chargeOverhead` for the shared work around it
    /// (the tank write, a cold key on Somnia).
    struct GasParams {
        uint64 floor;
        uint64 perFollowerCap;
        uint64 themePerFollowerCap;
        uint64 tailBase;
        uint64 perDefer;
        uint64 chargeOverhead;
    }

    /// @dev One event as every member's phases see it: the trader's pool and live size, or the theme's legs.
    struct Delivery {
        bytes32 sourceId;
        uint32 group;
        bool theme;
        address pool;
        int256 size;
        Leg[] legs;
        uint32 version;
        uint256 cap;
        uint256 rate;
    }

    uint256 public constant MIN_TANK = 0.2 ether;
    uint256 public constant MIN_TANK_FOR_INCREASE = CopyEngine.MIN_TANK_FOR_INCREASE;
    uint256 public constant ORDER_TTL = CopyEngine.ORDER_TTL;
    /// @dev Bounds per-follower loops (flatten, total cap, a theme's markets) that run inside a shared
    /// group handler.
    uint256 public constant MAX_JOIN_POOLS = CopyEngine.MAX_JOIN_POOLS;
    bytes32 public constant THEME_REBALANCED_TOPIC = keccak256("ThemeRebalanced(uint256,uint32)");
    /// @dev A theme leg on the right side within this share of its target is left alone, so mark drift
    /// alone does not trade.
    uint256 public constant THEME_DRIFT_BPS = CopyEngine.THEME_DRIFT_BPS;
    bytes32 public constant POSITION_UPDATED_TOPIC = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;

    /// @dev Somnia's minimum base fee; handler gas is never charged below it.
    uint256 public constant MIN_CHARGE_GAS_PRICE = 6 gwei;
    /// @dev Fixed budget for cancelling a subscription; an unfollow that empties a group must afford it.
    uint256 public constant UNSUB_GAS = 2_000_000;
    /// @dev Somnia: touching a storage key that is cold or does not exist yet (a tank charged to zero) can
    /// cost or require about this much gas.
    uint256 internal constant COLD_KEY_GAS = 1_000_000;
    /// @dev The precompile's rule: a subscription owner keeps at least this balance.
    uint256 public constant MIN_SUBSCRIPTION_BALANCE = 32 ether;
    /// @dev The precompile's ceiling for a handler's gas limit.
    uint256 internal constant MAX_HANDLER_GAS = 200_000_000;
    /// @dev Admin floors for the handler budget: a member slot, and one deferral's log and slot read.
    uint256 internal constant MIN_SLOT_GAS = 1_000_000;
    uint256 internal constant MIN_PER_DEFER = 20_000;
    uint256 internal constant MIN_CHARGE_OVERHEAD = 20_000;
    uint256 internal constant MAX_CHARGE_OVERHEAD = 2_000_000;
    /// @dev Room a subscription's gas limit keeps above the handler's floor and tail reserve for its own
    /// dispatch and the event checks.
    uint256 internal constant HANDLER_MARGIN_GAS = 2_000_000;
    /// @dev Smallest tailBase: a cold member read on Somnia plus the closing GroupDeferred.
    uint256 internal constant MIN_TAIL_BASE = 1_100_000;
    /// @dev Kept back on top of the reserve so a member Deferred (and latched) out of the reserve still leaves
    /// the next member's read and a GroupDeferred funded.
    uint256 public constant DEFER_ALLOWANCE_GAS = 30_000;
    /// @dev Kept back from a trader member's exits on top of the reserve, so if they run out of gas the event's
    /// market can still join its synced set: up to four cold or new keys on Somnia (epoch, flag, list length,
    /// list entry).
    uint256 public constant EXIT_MARK_GAS = 4 * COLD_KEY_GAS;
    /// @dev Smallest subscription gas limits, so a member's exits always get a slot well above one venue order
    /// (up to 7.7M gas on Hideki), and a theme member's several.
    uint256 internal constant MIN_TRADER_GAS_LIMIT = 40_000_000;
    uint256 internal constant MIN_THEME_GAS_LIMIT = 120_000_000;
    /// @dev Ceiling for a subscription's maxFeePerGas: handler fees come out of the balance that backs tanks.
    uint256 public constant MAX_FEE_PER_GAS = 100 gwei;

    address internal constant REACTIVITY = address(0x0100);

    IMarginBank public immutable bank;
    ThemeRegistry public immutable themes;
    uint32 public immutable groupSize;

    address public riskGate;
    bool public followsPaused;
    SubParams public subParams;
    uint256 public totalTanks;

    mapping(address => uint256) public tankOf;
    mapping(bytes32 => mapping(uint32 => address)) public relayOf;
    mapping(bytes32 => mapping(uint32 => uint256)) public subscriptionOf;

    mapping(bytes32 => mapping(uint32 => address[])) internal _members;
    /// @dev Follows, synced pools, epochs and allowlists: the storage CopyEngine runs on.
    CopyEngine.Books internal _books;
    /// @dev Groups ever opened per source. An emptied group keeps its relay and is reused.
    mapping(bytes32 => uint32) public groupCount;
    mapping(bytes32 => mapping(uint32 => bool)) public subscribed;
    GasParams public gasParams;
    /// @dev Members per theme group (trader groups hold `groupSize`): a theme member's sync is heavy.
    uint32 public themeGroupSize;
    /// @notice Subscription ids the hub failed to cancel when no group used them any more; only these can
    /// go to cancelOrphan.
    mapping(uint256 => bool) public orphanSubs;

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(IMarginBank bank_, ThemeRegistry themes_, uint32 groupSize_, address owner_) Ownable(owner_) {
        if (groupSize_ == 0) revert InvalidGroupSize();
        bank = bank_;
        themes = themes_;
        groupSize = groupSize_;
        subParams = SubParams({
            priorityFeePerGas: 0,
            maxFeePerGas: 20 gwei,
            traderGasLimit: 200_000_000,
            themeGasLimit: 200_000_000,
            guaranteed: false
        });
        gasParams = GasParams({
            floor: 8_000_000,
            perFollowerCap: 20_000_000,
            themePerFollowerCap: 90_000_000,
            tailBase: 1_200_000,
            perDefer: 30_000,
            chargeOverhead: 300_000
        });
        themeGroupSize = 2;
    }

    /// @dev Funds the subscription balance the Reactivity precompile requires of the hub.
    receive() external payable {}

    // ---------------------------------------------------------------- follower lifecycle

    /// @notice Follow a source. Trader, `joinPools` non-empty: the hub manages only those markets and
    /// copies the source's current positions there now; every other market of the follower is never
    /// touched. Empty (`allowAll`): the hub manages every market the source trades, including any position
    /// the follower already holds there, and nothing is opened until the source moves.
    /// Theme (`ref` = themeId, `joinPools` empty): the hub manages every pool that is or becomes a leg of
    /// the theme while followed, sized from `p.allocation`, including a position the follower opened there
    /// by hand; use a dedicated wallet per source. The whole basket opens now, all legs or none.
    /// If the handler ever runs out of gas on a follow's exits it latches the follow (pendingOf) until a paid
    /// catchUp, resync or poke; unfollowing and following again also starts clean. With the minimum subscription
    /// gas limits a single venue order (up to 7.7M gas on Hideki) fits a member's exits unless the handler reaches
    /// it with barely its floor left, so in practice only exits needing many orders latch.
    function follow(SourceKind kind, uint256 ref, Policy calldata p, address[] calldata joinPools)
        external
        payable
        nonReentrant
        returns (bytes32 sourceId)
    {
        if (followsPaused) revert FollowsPaused();
        CopyEngine.Follow storage f = _books.follows[msg.sender];
        if (f.sourceId != 0) revert AlreadyFollowing();
        if (msg.value < MIN_TANK) revert TankTooLow();
        bool theme = kind == SourceKind.Theme;
        if (theme) {
            if (ref == 0 || ref > themes.themeCount()) revert InvalidSource();
            if (joinPools.length != 0) revert JoinPoolsNotAllowed();
        } else if (ref == 0 || ref > type(uint160).max || address(uint160(ref)) == msg.sender) {
            revert InvalidSource();
        }
        if (joinPools.length > MAX_JOIN_POOLS) revert TooManyPools();
        PolicyLib.validate(p, kind);

        sourceId = sourceIdOf(kind, ref);
        f.sourceId = sourceId;
        f.ref = ref;
        f.policy = p;
        f.kind = kind;
        f.allowAll = !theme && joinPools.length == 0;
        tankOf[msg.sender] += msg.value;
        totalTanks += msg.value;
        _joinGroup(msg.sender, f, sourceId, kind, ref);
        emit Followed(msg.sender, sourceId, kind, ref);
        if (theme) _syncThemeNow(msg.sender, f, false);
        else if (joinPools.length != 0) CopyEngine.joinPools(_books, _env(msg.sender), joinPools);
    }

    /// @notice Stop following. With `flatten`, every synced position is closed first; `flattened`
    /// in the event reports whether all of them reached zero.
    function unfollow(bool flatten) external nonReentrant {
        CopyEngine.Follow storage f = _active(msg.sender);
        bytes32 sourceId = f.sourceId;
        bool flat = flatten && CopyEngine.flatten(_books, _env(msg.sender));
        _leaveGroup(f);
        delete _books.follows[msg.sender];
        delete _books.synced[msg.sender];
        ++_books.epoch[msg.sender];
        emit Unfollowed(msg.sender, sourceId, flat);
    }

    function updatePolicy(Policy calldata p) external {
        CopyEngine.Follow storage f = _active(msg.sender);
        PolicyLib.validate(p, f.kind);
        f.policy = p;
        f.lastSyncComplete = false;
        emit PolicyUpdated(msg.sender);
    }

    /// @notice Lifts a stop. Allowed when the floor is off or equity is back at or above it, and never while
    /// the stop's closes are still pending (poke finishes them).
    function resume() external {
        CopyEngine.Follow storage f = _active(msg.sender);
        if (f.flattenPending) revert FlattenPending();
        uint256 floor = f.policy.equityFloor;
        if (floor != 0) {
            (int256 equity,,,) = bank.getAccountHealth(msg.sender);
            if (equity < int256(floor)) revert StillBelowFloor();
        }
        f.paused = false;
        emit Resumed(msg.sender);
    }

    function fundTank() external payable {
        tankOf[msg.sender] += msg.value;
        totalTanks += msg.value;
    }

    /// @notice While following, the tank must keep MIN_TANK; all of it comes out after unfollowing.
    function withdrawTank(uint256 amount) external nonReentrant {
        uint256 tank = tankOf[msg.sender];
        if (amount > tank) revert InsufficientTank();
        uint256 left = tank - amount;
        if (left < MIN_TANK && _books.follows[msg.sender].sourceId != 0) revert TankFloor();
        tankOf[msg.sender] = left;
        totalTanks -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- permissionless sync

    /// @notice Re-sync `pools` of `follower` to the source's current on-chain positions. Anyone may call;
    /// the target always comes from the source, so a call can only move the follower toward it.
    /// A theme follow ignores `pools` and syncs the whole basket, and only when the theme has a version
    /// the follower's book does not match yet or its last sync did not finish; otherwise nothing happens.
    /// When the handler ran out of gas on the follow's exits (see pendingOf), this call does them on its own
    /// gas: the whole basket for a theme, every synced market for a trader. Then the handler takes the
    /// follow back.
    function catchUp(address follower, address[] calldata pools) external nonReentrant {
        CopyEngine.Follow storage f = _active(follower);
        bool pending = f.exitPending;
        if (f.kind == SourceKind.Theme) {
            _syncThemeNow(follower, f, !pending);
        } else {
            if (pending) CopyEngine.syncPools(_books, _env(follower), _books.synced[follower]);
            CopyEngine.syncPools(_books, _env(follower), pools);
        }
        if (pending) f.exitPending = false;
    }

    /// @notice Equity-floor check. Below the floor the follow is paused and every synced position closed.
    /// A stop raised in the handler whose closes did not finish (see pendingOf) is finished here, on this
    /// call's gas, whatever the floor says now. Once a pass has run to the end (out of gas reverts it) the
    /// follow is released from pendingOf; any position still open (dust the venue cannot take, or a market
    /// it cannot price now) is reported with FlattenIncomplete.
    function poke(address follower) external nonReentrant {
        CopyEngine.Follow storage f = _active(follower);
        if (f.flattenPending) {
            CopyEngine.flatten(_books, _env(follower));
        } else {
            uint256 floor = f.policy.equityFloor;
            if (floor == 0) return;
            (int256 equity,,,) = bank.getAccountHealth(follower);
            if (equity >= int256(floor)) return;
            CopyEngine.stop(_books, _env(follower), equity);
        }
        if (f.exitPending || f.flattenPending) {
            address[] storage pools = _books.synced[follower];
            for (uint256 i; i < pools.length; ++i) {
                if (bank.getPosition(follower, pools[i]).size != 0) emit FlattenIncomplete(follower, pools[i]);
            }
            (f.exitPending, f.flattenPending) = (false, false);
        }
    }

    /// @notice Subscribes a group again, with its relay and the current subParams, when the chain dropped its
    /// subscription while the group still has members. A live hub-owned subscription, or a group without
    /// members, is left alone. Fails closed: an answer the hub cannot read reverts instead of risking a
    /// duplicate subscription.
    function ensureSubscribed(bytes32 sourceId, uint32 group) external nonReentrant {
        address[] storage members = _members[sourceId][group];
        if (members.length == 0) return;
        uint256 oldId = subscriptionOf[sourceId][group];
        // low-level: the precompile has no code. The answer is 14 static words of SubscriptionData, then the owner.
        (bool ok, bytes memory ret) =
            REACTIVITY.staticcall(abi.encodeCall(ISomniaReactivityPrecompile.getSubscriptionInfo, (oldId)));
        if (!ok || ret.length < 480) revert SubscriptionUnreadable();
        (, address subOwner) = abi.decode(ret, (ISomniaReactivityPrecompile.SubscriptionData, address));
        if (subOwner == address(this)) return;
        _resubscribe(sourceId, group, members[0]);
    }

    /// @notice Entry point for a group's relay, run by the hub's own subscription only (Somnia makes the
    /// subscription owner the transaction origin). The event only names the pool (trader) or the theme; the
    /// source is read live (the trader's position, the theme's legs), so a delayed or reordered event can
    /// never open what the source no longer holds.
    /// Each member runs in two self-calls (see GasParams), so one member's failure stays with it. First its
    /// exits, on everything above the reserve: they only reduce and stand whatever follows; if they run out
    /// of gas the member is Deferred, unbilled, and latched (pendingOf). Then its increases in a bounded slot;
    /// an equity stop they report is written here, before the closes it calls for, so the pause stands even if
    /// the closes run out of gas (Deferred, that part unbilled, latched). A latched member is skipped with a bare
    /// Deferred until a caller's own catchUp, resync or poke finishes its work. The handler always keeps enough back to stop cleanly with
    /// GroupDeferred, the rest waiting for catchUp: when the next slot cannot be funded, or when a member's
    /// increases run out of gas in a slot the handler had to cut short; increases that run out of a full slot
    /// leave that member Deferred alone. Members pay their own gas from their tank. One with nothing to do is
    /// billed silently: a trader member only the overhead (its no-op stops at the allowlist or one position
    /// read), a theme member the gas its sync measured (a quiet rebalance still reads every leg; the hub does
    /// not fund a creator's rebalances).
    function onSourceEvent(
        bytes32 sourceId,
        uint32 group,
        address emitter,
        bytes32[] calldata topics,
        bytes calldata /* data */
    )
        external
        nonReentrant
    {
        if (msg.sender != relayOf[sourceId][group]) revert NotRelay();
        // a subscription someone else pointed at the relay cannot drive the group or bill its tanks
        if (tx.origin != address(this)) revert NotOwnSubscription();
        GasParams memory gp = gasParams;
        Delivery memory d;
        d.sourceId = sourceId;
        d.group = group;
        d.cap = gp.perFollowerCap;
        d.theme = emitter == address(themes);
        if (d.theme) {
            if (
                topics.length < 2 || sourceIdOf(SourceKind.Theme, uint256(topics[1])) != sourceId
                    || topics[0] != THEME_REBALANCED_TOPIC
            ) revert BadEvent();
            (d.legs, d.version) = _liveTheme(uint256(topics[1]));
            d.cap = gp.themePerFollowerCap;
        } else {
            if (
                emitter != address(bank) || topics.length < 3 || topics[0] != POSITION_UPDATED_TOPIC
                    || sourceIdOf(SourceKind.Trader, uint256(topics[1])) != sourceId
            ) revert BadEvent();
            d.pool = address(uint160(uint256(topics[2])));
            d.size = bank.getPosition(address(uint160(uint256(topics[1]))), d.pool).size;
        }
        d.rate = block.basefee > MIN_CHARGE_GAS_PRICE ? block.basefee : MIN_CHARGE_GAS_PRICE;

        address[] storage members = _members[sourceId][group];
        uint256 n = members.length;
        for (uint256 i; i < n; ++i) {
            // read before measuring, so a cold member slot is not paid out of the reserve
            address follower = members[i];
            uint256 reserve = gp.tailBase + (n - i) * gp.perDefer + DEFER_ALLOWANCE_GAS;
            if (gasleft() < gp.floor + reserve + (d.theme ? 0 : EXIT_MARK_GAS)) {
                emit GroupDeferred(sourceId, group, i);
                return;
            }
            if (!_member(d, gp, follower, i, reserve)) return;
        }
    }

    /// @dev One member's share of an event: its exits, then its increases, then its bill.
    /// @return more false when the handler stopped the group with GroupDeferred
    function _member(Delivery memory d, GasParams memory gp, address follower, uint256 i, uint256 reserve)
        internal
        returns (bool more)
    {
        CopyEngine.Follow storage f = _books.follows[follower];
        if (f.exitPending || f.flattenPending) {
            // work the handler could not finish before waits for a caller's own transaction (catchUp, resync,
            // poke): until then the member is left alone, without a venue read or a bill
            emit Deferred(follower, d.sourceId);
            return true;
        }
        uint256 start = gasleft();
        // a trader member's exits keep back room to add the event's market to its synced set if they run out
        uint256 exitSlot = start - reserve - (d.theme ? 0 : EXIT_MARK_GAS);
        bytes memory args = abi.encode(d.sourceId, follower, d.pool, d.size, d.legs, d.version);
        (bool ok, bytes memory ret) = _phase(this.exitFromEvent.selector, args, exitSlot);
        uint256 spent;
        bool reported = true;
        if (ok) {
            reported = abi.decode(ret, (bool));
            if (reported || d.theme) spent = start - gasleft();
            (bool entered, uint256 entrySpent, bool entryActed) = _entryPhase(d, gp, follower, i, reserve, args);
            if (!entered) return false;
            spent += entrySpent;
            reported = reported || entryActed;
        } else if (_outOfGas(ret, start, exitSlot)) {
            // never billed: a source must not drain tanks with exits too heavy to finish. Latched, so the next
            // events skip the member instead of burning the handler on the same exits again. A trader's event
            // market joins its synced set (an all-markets follow may not have it yet), so the catchUp that
            // releases the latch runs this exit first.
            if (!d.theme) CopyEngine._markSynced(_books, follower, d.pool);
            f.exitPending = true;
            emit Deferred(follower, d.sourceId);
            return true;
        } else {
            emit Refused(follower, d.sourceId, d.pool, Reason.VenueRejected, ret);
            spent = start - gasleft();
        }
        // The tank may be a cold or missing key. Without that much headroom above the next member's
        // reserve the charge is skipped rather than paid out of the reserve.
        if (gasleft() >= COLD_KEY_GAS + reserve - gp.perDefer) {
            _charge(follower, (spent + gp.chargeOverhead) * d.rate, reported);
        }
        return true;
    }

    /// @dev A member's increases, in a slot between the floor and the per-member cap, and the equity stop
    /// they may report.
    /// @return more false when the handler stopped the group with GroupDeferred (its exits are in; its
    /// increases and the rest of the group wait for catchUp, unbilled)
    /// @return spent the gas to bill for this part
    /// @return acted whether it sent or refused anything
    function _entryPhase(
        Delivery memory d,
        GasParams memory gp,
        address follower,
        uint256 i,
        uint256 reserve,
        bytes memory args
    ) internal returns (bool more, uint256 spent, bool acted) {
        uint256 start = gasleft();
        if (start < gp.floor + reserve) {
            emit GroupDeferred(d.sourceId, d.group, i);
            return (false, 0, false);
        }
        uint256 slot = start - reserve;
        bool fullSlot = slot >= d.cap;
        if (fullSlot) slot = d.cap;
        (bool ok, bytes memory ret) = _phase(this.entryFromEvent.selector, args, slot);
        if (ok) {
            bool stop;
            int256 equity;
            (acted, stop, equity) = abi.decode(ret, (bool, bool, int256));
            if (acted || d.theme) spent = start - gasleft();
            if (stop) spent += _stopFromEvent(d.sourceId, follower, equity, reserve);
            return (true, spent, acted);
        }
        if (!_outOfGas(ret, start, slot)) {
            emit Refused(follower, d.sourceId, d.pool, Reason.VenueRejected, ret);
        } else if (fullSlot) {
            emit Deferred(follower, d.sourceId);
        } else {
            // the handler ran short, not the member: it and the rest wait for catchUp, unbilled
            emit GroupDeferred(d.sourceId, d.group, i);
            return (false, 0, false);
        }
        return (true, start - gasleft(), true);
    }

    /// @notice Exit half of one member's share of an event: every reduction it calls for, never gated. Only
    /// callable by the hub itself, from onSourceEvent.
    /// @return acted false when the follower no longer follows this source, its theme book already matches
    /// this version, or nothing needed reducing
    function exitFromEvent(
        bytes32 sourceId,
        address follower,
        address pool,
        int256 sourceSize,
        Leg[] calldata legs,
        uint32 version
    ) external onlySelf returns (bool) {
        CopyEngine.Follow storage f = _books.follows[follower];
        if (!_eventFor(f, sourceId, version)) return false;
        if (f.kind == SourceKind.Theme) return CopyEngine.exitTheme(_books, _env(follower), legs);
        return CopyEngine.exitTrader(_books, _env(follower), pool, sourceSize);
    }

    /// @notice Entry half of one member's share of an event: its increases, behind every gate. An equity stop
    /// is reported, not acted on: onSourceEvent pauses the follow and closes it. Only callable by the hub
    /// itself, from onSourceEvent.
    function entryFromEvent(
        bytes32 sourceId,
        address follower,
        address pool,
        int256 sourceSize,
        Leg[] calldata legs,
        uint32 version
    ) external onlySelf returns (bool acted, bool stop, int256 equity) {
        CopyEngine.Follow storage f = _books.follows[follower];
        if (!_eventFor(f, sourceId, version)) return (false, false, 0);
        if (f.kind == SourceKind.Theme) return CopyEngine.entryTheme(_books, _env(follower), legs, version);
        return CopyEngine.entryTrader(_books, _env(follower), pool, sourceSize);
    }

    /// @notice The closes of an equity stop raised inside onSourceEvent. Only callable by the hub itself.
    function flattenFromEvent(bytes32 sourceId, address follower) external onlySelf {
        if (_books.follows[follower].sourceId == sourceId) CopyEngine.flatten(_books, _env(follower));
    }

    /// @notice A theme sync's increase set. Only callable by the hub itself: every leg fills completely
    /// inside its band, or the whole set reverts with the first failing leg and nothing is kept.
    function applyIncreases(address follower, CopyEngine.LegOrder[] calldata orders) external onlySelf {
        CopyEngine.applyIncreases(bank, follower, orders);
    }

    /// @notice A theme follower's own full sync, at any time (mark drift within THEME_DRIFT_BPS still
    /// trades nothing). Between theme versions catchUp leaves the book alone, so legs drift with their
    /// marks without bound until this is called; the app prompts it once a leg is 5% or more off.
    function resync() external nonReentrant {
        CopyEngine.Follow storage f = _active(msg.sender);
        if (f.kind != SourceKind.Theme) revert NotThemeFollow();
        _syncThemeNow(msg.sender, f, false);
        if (f.exitPending) f.exitPending = false;
    }

    // ---------------------------------------------------------------- views

    /// @return syncedVersion theme version of the follower's last sync that left every leg at target
    /// @return lastSyncComplete whether its last sync did; when true at the current version catchUp is a no-op
    function themeSyncOf(address follower) external view returns (uint32 syncedVersion, bool lastSyncComplete) {
        CopyEngine.Follow storage f = _books.follows[follower];
        return (f.syncedVersion, f.lastSyncComplete);
    }

    function sourceIdOf(SourceKind kind, uint256 ref) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, ref));
    }

    function followOf(address follower)
        external
        view
        returns (bytes32 sourceId, SourceKind kind, uint256 ref, Policy memory policy, bool paused, uint32 group)
    {
        CopyEngine.Follow storage f = _books.follows[follower];
        return (f.sourceId, f.kind, f.ref, f.policy, f.paused, f.group);
    }

    function syncedPools(address follower) external view returns (address[] memory) {
        return _books.synced[follower];
    }

    function membersOf(bytes32 sourceId, uint32 group) external view returns (address[] memory) {
        return _members[sourceId][group];
    }

    /// @return exitPending the handler ran out of gas on the follow's exits; catchUp or resync finishes them
    /// @return flattenPending a stop's closes did not finish in the handler; poke finishes them, and resume waits
    /// for it. While either is set the handler skips the follow.
    function pendingOf(address follower) external view returns (bool exitPending, bool flattenPending) {
        CopyEngine.Follow storage f = _books.follows[follower];
        return (f.exitPending, f.flattenPending);
    }

    /// @return group the follower's group of its source
    /// @return index its position in membersOf(sourceId, group)
    function seatOf(address follower) external view returns (uint32 group, uint32 index) {
        CopyEngine.Follow storage f = _books.follows[follower];
        return (f.group, f.index);
    }

    // ---------------------------------------------------------------- admin
    // Bounded: the owner tunes the risk gate and the subscription and handler budgets within the
    // precompile's limits, pauses new follows, takes out STT above the tanks and the subscription
    // reserve, and repairs subscriptions. Nothing here moves follower margin, calls a target of the
    // owner's choosing with data, or touches a tank.

    /// @notice The gate consulted before every increase (address(0): none); it must be a contract. Reductions
    /// never ask it, and a gate that does not answer `true` within its fixed budget only refuses increases.
    function setRiskGate(address gate) external onlyOwner {
        if (gate != address(0) && gate.code.length == 0) revert InvalidParam(1);
        riskGate = gate;
        emit RiskGateSet(gate);
    }

    /// @notice Subscription settings for groups opened or subscribed again from now on (by a new member,
    /// ensureSubscribed or forceResubscribe); live subscriptions keep theirs. maxFeePerGas at most
    /// MAX_FEE_PER_GAS and at least the priority fee plus Somnia's 6 gwei base fee: handler fees come out of
    /// the balance that backs the tanks. Each gas limit at most 200M, at least 40M (trader) or 120M (theme) so a
    /// member's exits always fit, and enough for the handler's floor and tail reserve (see gasParams).
    function setSubParams(
        uint64 priorityFeePerGas,
        uint64 maxFeePerGas,
        uint64 traderGasLimit,
        uint64 themeGasLimit,
        bool guaranteed
    ) external onlyOwner {
        if (maxFeePerGas > MAX_FEE_PER_GAS || maxFeePerGas < MIN_CHARGE_GAS_PRICE) {
            revert InvalidParam(2);
        }
        if (priorityFeePerGas > maxFeePerGas - MIN_CHARGE_GAS_PRICE) revert InvalidParam(1);
        if (traderGasLimit < MIN_TRADER_GAS_LIMIT || traderGasLimit > MAX_HANDLER_GAS) revert InvalidParam(3);
        if (themeGasLimit < MIN_THEME_GAS_LIMIT || themeGasLimit > MAX_HANDLER_GAS) revert InvalidParam(4);
        GasParams memory gp = gasParams;
        _checkFits(gp.floor, gp.tailBase, gp.perDefer, traderGasLimit, themeGasLimit);
        subParams = SubParams(priorityFeePerGas, maxFeePerGas, traderGasLimit, themeGasLimit, guaranteed);
        emit SubParamsSet(priorityFeePerGas, maxFeePerGas, traderGasLimit, themeGasLimit, guaranteed);
    }

    /// @notice The group handler's budget (see GasParams), used from the next event on. `floor` at least 1M;
    /// both caps between `floor` and 200M; `tailBase` at least 1.1M (Somnia's cold-key cost, so the handler can
    /// always report a deferral); `perDefer` at least 20k; `chargeOverhead` 20k..2M. The subscription gas
    /// limits in subParams must still fund the floor and the tail reserve.
    function setGasParams(
        uint64 floor,
        uint64 perFollowerCap,
        uint64 themePerFollowerCap,
        uint64 tailBase,
        uint64 perDefer,
        uint64 chargeOverhead
    ) external onlyOwner {
        if (floor < MIN_SLOT_GAS) revert InvalidParam(1);
        if (perFollowerCap < floor || perFollowerCap > MAX_HANDLER_GAS) revert InvalidParam(2);
        if (themePerFollowerCap < floor || themePerFollowerCap > MAX_HANDLER_GAS) revert InvalidParam(3);
        if (tailBase < MIN_TAIL_BASE) revert InvalidParam(4);
        if (perDefer < MIN_PER_DEFER) revert InvalidParam(5);
        if (chargeOverhead < MIN_CHARGE_OVERHEAD || chargeOverhead > MAX_CHARGE_OVERHEAD) revert InvalidParam(6);
        SubParams memory s = subParams;
        _checkFits(floor, tailBase, perDefer, s.traderGasLimit, s.themeGasLimit);
        gasParams = GasParams(floor, perFollowerCap, themePerFollowerCap, tailBase, perDefer, chargeOverhead);
        emit GasParamsSet(floor, perFollowerCap, themePerFollowerCap, tailBase, perDefer, chargeOverhead);
    }

    /// @notice Disabled: the admin surface (risk gate, budgets, subscription repair) must stay reachable.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Stops new follows. Existing follows are untouched: they keep syncing both ways and can
    /// unfollow, catchUp, poke, resume and withdraw.
    function pauseNewFollows(bool paused) external onlyOwner {
        followsPaused = paused;
        emit NewFollowsPaused(paused);
    }

    /// @notice Sends STT the hub holds above the followers' tanks and the precompile's subscription reserve.
    function withdrawSurplus(address to, uint256 amount) external nonReentrant onlyOwner {
        if (to == address(0)) revert InvalidParam(1);
        uint256 balance = address(this).balance;
        if (amount > balance || balance - amount < MIN_SUBSCRIPTION_BALANCE + totalTanks) {
            revert InsufficientSurplus();
        }
        emit SurplusWithdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Cancels a subscription the hub failed to cancel when its group emptied or was subscribed
    /// again (see orphanSubs). Best effort: a failed attempt keeps the id recorded for another try.
    function cancelOrphan(uint256 subscriptionId) external nonReentrant onlyOwner {
        if (!orphanSubs[subscriptionId]) revert NotOrphan();
        bool cancelled = _unsubscribe(subscriptionId);
        if (cancelled) delete orphanSubs[subscriptionId];
        emit OrphanCancelled(subscriptionId, cancelled);
    }

    /// @notice Recovery for a group whose subscription the chain dropped when ensureSubscribed cannot tell
    /// (the precompile reverts reading a removed id, so it fails closed): cancels the group's current id
    /// (best effort, recorded as an orphan when that fails) and subscribes the group again with its relay and
    /// the current subParams.
    function forceResubscribe(bytes32 sourceId, uint32 group) external nonReentrant onlyOwner {
        address[] storage members = _members[sourceId][group];
        if (members.length == 0) revert NoMembers();
        _resubscribe(sourceId, group, members[0]);
    }

    // ---------------------------------------------------------------- groups

    /// @dev Seats the follower in the first group with room, opening a new group (relay + subscription)
    /// when all are full. A reused empty group is subscribed again with its existing relay.
    function _joinGroup(address follower, CopyEngine.Follow storage f, bytes32 sourceId, SourceKind kind, uint256 ref)
        internal
    {
        uint32 n = groupCount[sourceId];
        uint32 g;
        uint256 seats = kind == SourceKind.Theme ? themeGroupSize : groupSize;
        while (g < n && _members[sourceId][g].length >= seats) ++g;
        if (g == n) {
            groupCount[sourceId] = n + 1;
            relayOf[sourceId][g] = address(new GroupRelay(address(this), sourceId, g));
        }
        if (!subscribed[sourceId][g]) _subscribe(sourceId, g, kind, ref);
        address[] storage members = _members[sourceId][g];
        f.group = g;
        f.index = uint32(members.length);
        members.push(follower);
    }

    function _leaveGroup(CopyEngine.Follow storage f) internal {
        bytes32 sourceId = f.sourceId;
        uint32 g = f.group;
        address[] storage members = _members[sourceId][g];
        uint256 last = members.length - 1;
        uint32 i = f.index;
        if (i != last) {
            address moved = members[last];
            members[i] = moved;
            _books.follows[moved].index = i;
        }
        members.pop();
        if (last == 0) _closeGroup(sourceId, g);
    }

    /// @dev Cancels an empty group's subscription so it stops costing the hub; the relay is kept for reuse.
    function _closeGroup(bytes32 sourceId, uint32 g) internal {
        uint256 id = subscriptionOf[sourceId][g];
        subscribed[sourceId][g] = false;
        emit GroupClosed(sourceId, g, id, _unsubscribe(id));
    }

    /// @dev Runs the cancel on a fixed budget the caller must afford at the call itself, so a tight gas
    /// estimate cannot skip it; beyond that it is best effort, so the precompile can never trap the last
    /// member in a follow. A failed cancel is recorded in orphanSubs for cancelOrphan; the budget leaves room
    /// for that record (a new key on Somnia). Low-level: the precompile has no code, which a typed call
    /// without return data rejects.
    function _unsubscribe(uint256 id) internal returns (bool cancelled) {
        bytes memory call = abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (id));
        if (gasleft() < UNSUB_GAS * 64 / 63 + COLD_KEY_GAS + 50_000) revert UnsubscribeOutOfGas();
        (cancelled,) = REACTIVITY.call{gas: UNSUB_GAS}(call);
        if (!cancelled) orphanSubs[id] = true;
    }

    /// @dev Cancels the group's current subscription (best effort) and subscribes it again with its relay,
    /// for the source of `member`.
    function _resubscribe(bytes32 sourceId, uint32 group, address member) internal {
        _unsubscribe(subscriptionOf[sourceId][group]);
        CopyEngine.Follow storage f = _books.follows[member];
        _subscribe(sourceId, group, f.kind, f.ref);
    }

    function _subscribe(bytes32 sourceId, uint32 g, SourceKind kind, uint256 ref) internal {
        address relay = relayOf[sourceId][g];
        SubParams memory s = subParams;
        bool isTrader = kind == SourceKind.Trader;

        ISomniaReactivityPrecompile.SubscriptionData memory d;
        d.eventTopics[0] = isTrader ? POSITION_UPDATED_TOPIC : THEME_REBALANCED_TOPIC;
        // trader: the address left-padded; theme: the theme id
        d.eventTopics[1] = bytes32(ref);
        d.emitter = isTrader ? address(bank) : address(themes);
        d.handlerContractAddress = relay;
        d.handlerFunctionSelector = ISomniaEventHandler.onEvent.selector;
        d.priorityFeePerGas = s.priorityFeePerGas;
        d.maxFeePerGas = s.maxFeePerGas;
        d.gasLimit = isTrader ? s.traderGasLimit : s.themeGasLimit;
        d.isGuaranteed = s.guaranteed;

        uint256 id = ISomniaReactivityPrecompile(REACTIVITY).subscribe(d);
        subscriptionOf[sourceId][g] = id;
        subscribed[sourceId][g] = true;
        // a live group's id is never an orphan
        delete orphanSubs[id];
        emit GroupOpened(sourceId, g, relay, id);
    }

    /// @dev Every subscription's gas limit must fund the handler's floor and tail reserve for one member, with
    /// room for its own dispatch; otherwise every event would defer the whole group.
    function _checkFits(uint256 floor, uint256 tailBase, uint256 perDefer, uint256 traderGas, uint256 themeGas)
        internal
        pure
    {
        uint256 need = floor + tailBase + perDefer + HANDLER_MARGIN_GAS;
        if (traderGas < need || themeGas < need) revert GasLimitTooLow();
    }

    // ---------------------------------------------------------------- event plumbing

    /// @dev One phase of a member's share of an event, as a self-call on `gas`.
    function _phase(bytes4 selector, bytes memory args, uint256 gas) internal returns (bool, bytes memory) {
        return address(this).call{gas: gas}(abi.encodePacked(selector, args));
    }

    /// @dev Whether a phase that reverted ran out of gas, rather than answering.
    function _outOfGas(bytes memory err, uint256 before, uint256 slot) internal view returns (bool) {
        return (err.length == 4 && bytes4(err) == OutOfGasInSync.selector) || CopyEngine.starved(err, before, slot);
    }

    /// @dev Whether an event still concerns this follow: it follows the source, and for a theme its book does
    /// not match this version yet.
    function _eventFor(CopyEngine.Follow storage f, bytes32 sourceId, uint32 version) internal view returns (bool) {
        return f.sourceId == sourceId && (f.kind != SourceKind.Theme || !_themeCurrent(f, version));
    }

    /// @dev An equity stop reported inside the handler. The pause is written here, in the handler's own frame,
    /// so it stands even if the closes run out of gas; the closes get everything above the reserve, and when
    /// that is not enough the member is Deferred (that part unbilled), latched in flattenPending, and poke finishes
    /// them.
    /// @return spent the gas of the closes, to bill
    function _stopFromEvent(bytes32 sourceId, address follower, int256 equity, uint256 reserve)
        internal
        returns (uint256 spent)
    {
        CopyEngine.Follow storage f = _books.follows[follower];
        f.paused = true;
        f.lastSyncComplete = false;
        emit Stopped(follower, equity);
        uint256 start = gasleft();
        if (start > reserve) {
            (bool ok, bytes memory ret) =
                address(this).call{gas: start - reserve}(abi.encodeCall(this.flattenFromEvent, (sourceId, follower)));
            if (ok) return start - gasleft();
            if (!_outOfGas(ret, start, start - reserve)) {
                f.flattenPending = true;
                emit Refused(follower, sourceId, address(0), Reason.VenueRejected, ret);
                return start - gasleft();
            }
        }
        // latched: the handler skips the member, and resume waits, until poke finishes the closes
        f.flattenPending = true;
        emit Deferred(follower, sourceId);
    }

    // ---------------------------------------------------------------- sync plumbing

    /// @dev What CopyEngine reads for one follower besides its books.
    function _env(address follower) internal view returns (CopyEngine.Env memory) {
        return CopyEngine.Env({bank: bank, follower: follower, riskGate: riskGate, tank: tankOf[follower]});
    }

    /// @dev Syncs a theme follower against the theme's live legs and version; with `ifBehind`, only when
    /// its book does not match that version yet.
    function _syncThemeNow(address follower, CopyEngine.Follow storage f, bool ifBehind) internal {
        (Leg[] memory legs, uint32 v) = _liveTheme(f.ref);
        if (!ifBehind || !_themeCurrent(f, v)) CopyEngine.syncTheme(_books, _env(follower), legs, v);
    }

    /// @dev The theme's live legs and version.
    function _liveTheme(uint256 id) internal view returns (Leg[] memory, uint32) {
        return (themes.legsOf(id), themes.versionOf(id));
    }

    /// @dev True when the follower's book already matches theme version `v`, so catchUp and a late or
    /// repeated event leave it alone.
    function _themeCurrent(CopyEngine.Follow storage f, uint32 v) internal view returns (bool) {
        return f.lastSyncComplete && f.syncedVersion >= v;
    }

    /// @dev Moves handler gas from the follower's tank to the hub's own balance, saturating at the tank.
    /// The STT never leaves the hub: it backs the handler fees the precompile draws from it.
    function _charge(address follower, uint256 amount, bool reported) internal {
        uint256 tank = tankOf[follower];
        if (amount > tank) amount = tank;
        if (amount == 0) return;
        tankOf[follower] = tank - amount;
        totalTanks -= amount;
        if (reported) emit TankCharged(follower, amount);
    }

    function _active(address follower) internal view returns (CopyEngine.Follow storage f) {
        f = _books.follows[follower];
        if (f.sourceId == 0) revert NotFollowing();
    }
}

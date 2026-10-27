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
    /// an unfollow moves the group's last member into the leaver's seat.
    event GroupDeferred(bytes32 indexed sourceId, uint32 group, uint256 fromIndex);
    event RiskGateSet(address gate);
    event SubParamsSet(
        uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 traderGasLimit, uint64 themeGasLimit, bool guaranteed
    );
    event GasParamsSet(
        uint64 floor, uint64 perFollowerCap, uint64 themePerFollowerCap, uint64 tailBase, uint64 perDefer
    );
    event NewFollowsPaused(bool paused);
    event SurplusWithdrawn(address indexed to, uint256 amount);
    /// @notice An owner attempt to cancel a recorded orphan; a failed one stays recorded.
    event OrphanCancelled(uint256 subscriptionId, bool cancelled);

    struct SubParams {
        uint64 priorityFeePerGas;
        uint64 maxFeePerGas;
        uint64 traderGasLimit;
        uint64 themeGasLimit;
        bool guaranteed;
    }

    /// @dev Gas budget of a group handler. Each member runs in a slot of at least `floor` and at most
    /// `perFollowerCap` (`themePerFollowerCap` for a theme member, which syncs every leg); the handler
    /// always keeps `tailBase + perDefer * remainingMembers` back so it can still report the rest of the
    /// group as Deferred.
    struct GasParams {
        uint64 floor;
        uint64 perFollowerCap;
        uint64 themePerFollowerCap;
        uint64 tailBase;
        uint64 perDefer;
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

    /// @dev Added to each follower's measured gas for the shared handler work around it.
    uint256 public constant CHARGE_OVERHEAD_GAS = 60_000;
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
            perDefer: 30_000
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

    /// @notice Lifts a stop. Allowed when the floor is off or equity is back at or above it.
    function resume() external {
        CopyEngine.Follow storage f = _active(msg.sender);
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
    function catchUp(address follower, address[] calldata pools) external nonReentrant {
        CopyEngine.Follow storage f = _active(follower);
        if (f.kind == SourceKind.Theme) _syncThemeNow(follower, f, true);
        else CopyEngine.syncPools(_books, _env(follower), pools);
    }

    /// @notice Equity-floor check. Below the floor every synced position is closed and the follow paused.
    function poke(address follower) external nonReentrant {
        CopyEngine.Follow storage f = _active(follower);
        uint256 floor = f.policy.equityFloor;
        if (floor == 0) return;
        (int256 equity,,,) = bank.getAccountHealth(follower);
        if (equity >= int256(floor)) return;
        CopyEngine.stop(_books, _env(follower), equity);
    }

    /// @notice Subscribes a group again, with its relay, when the chain dropped its subscription while the
    /// group still has members. A live hub-owned subscription, or a group without members, is left alone.
    /// Fails closed: an answer the hub cannot read reverts instead of risking a duplicate subscription.
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

    /// @notice Entry point for a group's relay. The event only names the pool (trader) or the theme; the
    /// source is read live (the trader's position, the theme's legs), so a delayed or reordered event can
    /// never open what the source no longer holds.
    /// Each member runs in its own self-call with a bounded gas slot (see GasParams), so one failure stays
    /// with that member, and the handler always keeps enough back to stop cleanly with GroupDeferred, the
    /// rest waiting for catchUp: when the next slot cannot be funded, or when a member runs out of gas in a
    /// slot the handler had to cut short. A member that runs out of a full slot is Deferred alone. Members
    /// pay their own gas from their tank. One with nothing to do is billed silently: a trader member only
    /// the overhead (its no-op stops at the allowlist or one position read), a theme member the gas its sync
    /// measured (a quiet rebalance still reads every leg; the hub does not fund a creator's rebalances).
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
        GasParams memory gp = gasParams;
        uint256 cap = gp.perFollowerCap;
        address pool; // trader: the event's pool; theme: none
        int256 size;
        Leg[] memory legs;
        uint32 version;
        bool theme = emitter == address(themes);
        if (theme) {
            if (
                topics.length < 2 || sourceIdOf(SourceKind.Theme, uint256(topics[1])) != sourceId
                    || topics[0] != THEME_REBALANCED_TOPIC
            ) revert BadEvent();
            (legs, version) = _liveTheme(uint256(topics[1]));
            cap = gp.themePerFollowerCap;
        } else {
            if (
                emitter != address(bank) || topics.length < 3 || topics[0] != POSITION_UPDATED_TOPIC
                    || sourceIdOf(SourceKind.Trader, uint256(topics[1])) != sourceId
            ) revert BadEvent();
            pool = address(uint160(uint256(topics[2])));
            size = bank.getPosition(address(uint160(uint256(topics[1]))), pool).size;
        }
        uint256 rate = block.basefee > MIN_CHARGE_GAS_PRICE ? block.basefee : MIN_CHARGE_GAS_PRICE;

        address[] storage members = _members[sourceId][group];
        uint256 n = members.length;
        for (uint256 i; i < n; ++i) {
            // read before measuring, so a cold member slot is not paid out of the reserve
            address follower = members[i];
            uint256 reserve = gp.tailBase + (n - i) * gp.perDefer;
            uint256 start = gasleft();
            if (start < gp.floor + reserve) {
                emit GroupDeferred(sourceId, group, i);
                return;
            }
            uint256 slot = start - reserve;
            bool fullSlot = slot >= cap;
            if (fullSlot) slot = cap;
            uint256 spent;
            bool reported = true;
            (bool ok, bytes memory ret) = address(this).call{gas: slot}(
                theme
                    ? abi.encodeCall(this.syncThemeFromEvent, (sourceId, follower, legs, version))
                    : abi.encodeCall(this.syncFollowerFromEvent, (sourceId, follower, pool, size))
            );
            if (ok) {
                reported = abi.decode(ret, (bool));
                if (reported || theme) spent = start - gasleft();
            } else {
                bytes memory err = ret;
                bool oog =
                    (err.length == 4 && bytes4(err) == OutOfGasInSync.selector) || CopyEngine.starved(err, start, slot);
                if (!oog) {
                    emit Refused(follower, sourceId, pool, Reason.VenueRejected, err);
                } else if (fullSlot) {
                    emit Deferred(follower, sourceId);
                } else {
                    // the handler ran short, not the member: it and the rest wait for catchUp, unbilled
                    emit GroupDeferred(sourceId, group, i);
                    return;
                }
                spent = start - gasleft();
            }
            // The tank may be a cold or missing key. Without that much headroom above the next member's
            // reserve the charge is skipped rather than paid out of the reserve.
            if (gasleft() >= COLD_KEY_GAS + reserve - gp.perDefer) {
                _charge(follower, (spent + CHARGE_OVERHEAD_GAS) * rate, reported);
            }
        }
    }

    /// @notice One follower's share of a source event. Only callable by the hub itself, from onSourceEvent.
    /// @return acted false when the pool is outside the follow or the follower already matches the source
    function syncFollowerFromEvent(bytes32 sourceId, address follower, address pool, int256 sourceSize)
        external
        onlySelf
        returns (bool acted)
    {
        if (_books.follows[follower].sourceId != sourceId) return false;
        return CopyEngine.syncTrader(_books, _env(follower), pool, sourceSize);
    }

    /// @notice One theme follower's share of a rebalance, against the legs and version read once for the
    /// event. Only callable by the hub itself, from onSourceEvent.
    /// @return acted false when the follower no longer follows this theme, its book already matches this
    /// version, or the sync found nothing to send or refuse
    function syncThemeFromEvent(bytes32 sourceId, address follower, Leg[] calldata legs, uint32 version)
        external
        onlySelf
        returns (bool acted)
    {
        CopyEngine.Follow storage f = _books.follows[follower];
        if (f.sourceId != sourceId || _themeCurrent(f, version)) return false;
        return CopyEngine.syncTheme(_books, _env(follower), legs, version);
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

    /// @notice The gate consulted before every increase (address(0): none). Reductions never ask it.
    function setRiskGate(address gate) external onlyOwner {
        riskGate = gate;
        emit RiskGateSet(gate);
    }

    /// @notice Subscription settings for groups opened or subscribed again from now on; live subscriptions
    /// keep theirs. Gas limits 1..200M; maxFeePerGas at least the priority fee plus Somnia's 6 gwei base fee.
    function setSubParams(
        uint64 priorityFeePerGas,
        uint64 maxFeePerGas,
        uint64 traderGasLimit,
        uint64 themeGasLimit,
        bool guaranteed
    ) external onlyOwner {
        if (maxFeePerGas < uint256(priorityFeePerGas) + MIN_CHARGE_GAS_PRICE) {
            revert InvalidParam(2);
        }
        if (traderGasLimit == 0 || traderGasLimit > MAX_HANDLER_GAS) revert InvalidParam(3);
        if (themeGasLimit == 0 || themeGasLimit > MAX_HANDLER_GAS) revert InvalidParam(4);
        subParams = SubParams(priorityFeePerGas, maxFeePerGas, traderGasLimit, themeGasLimit, guaranteed);
        emit SubParamsSet(priorityFeePerGas, maxFeePerGas, traderGasLimit, themeGasLimit, guaranteed);
    }

    /// @notice The group handler's budget (see GasParams), used from the next event on. `floor` at least 1M;
    /// both caps between `floor` and 200M; `tailBase` at least 1M (Somnia's cold-key cost, so the handler can
    /// always report a deferral); `perDefer` at least 20k.
    function setGasParams(
        uint64 floor,
        uint64 perFollowerCap,
        uint64 themePerFollowerCap,
        uint64 tailBase,
        uint64 perDefer
    ) external onlyOwner {
        if (floor < MIN_SLOT_GAS) revert InvalidParam(1);
        if (perFollowerCap < floor || perFollowerCap > MAX_HANDLER_GAS) revert InvalidParam(2);
        if (themePerFollowerCap < floor || themePerFollowerCap > MAX_HANDLER_GAS) revert InvalidParam(3);
        if (tailBase < COLD_KEY_GAS) revert InvalidParam(4);
        if (perDefer < MIN_PER_DEFER) revert InvalidParam(5);
        gasParams = GasParams(floor, perFollowerCap, themePerFollowerCap, tailBase, perDefer);
        emit GasParamsSet(floor, perFollowerCap, themePerFollowerCap, tailBase, perDefer);
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
    /// (best effort, recorded as an orphan when that fails) and subscribes the group again with its relay.
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
        emit GroupOpened(sourceId, g, relay, id);
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

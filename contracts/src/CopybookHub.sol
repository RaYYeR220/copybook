// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    ISomniaReactivityPrecompile
} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/interfaces/ISomniaEventHandler.sol";
import {GroupRelay} from "./GroupRelay.sol";
import {PolicyLib} from "./PolicyLib.sol";
import {ThemeRegistry} from "./ThemeRegistry.sol";
import {Leg, Policy, Reason, SourceKind} from "./Types.sol";
import {IMarginBank, IPerpPool, IRiskGate} from "./interfaces/IDreamPerps.sol";

/// @title CopybookHub
/// @notice The operator followers link on dreamDEX. Keeps each follower's perp positions in sync with
/// one source under the follower's Policy: a trader's live book, or a thesis basket from ThemeRegistry.
/// In the markets a follow manages, reductions are never gated; increases are fill-or-kill priced inside
/// the follower's band and pass every policy gate first. A thesis opens all its legs or none.
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
    /// membersOf at that block, were not synced and wait for catchUp.
    event GroupDeferred(bytes32 indexed sourceId, uint32 group, uint256 fromIndex);

    struct Follow {
        bytes32 sourceId; // zero when not following
        uint256 ref;
        Policy policy;
        SourceKind kind;
        bool paused;
        bool allowAll;
        uint32 group;
        uint32 index; // position in the group's member list
    }

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

    /// @dev One fill-or-kill increase of a theme's all-or-nothing set; `expected` is the size it must reach.
    struct LegOrder {
        address pool;
        bool isBid;
        uint256 price;
        uint256 qty;
        int256 expected;
        uint256 lot;
    }

    struct Market {
        uint256 mark;
        uint256 tick;
        uint256 lot;
        uint256 minQty;
        uint256 oneBase;
    }

    /// @dev One market of a theme sync. `weight` 0: not a current leg (its target is flat).
    struct ThemePool {
        address pool;
        int32 weight;
        bool ok; // market data read
        bool capped;
        int256 cur;
        int256 target;
        int256 mid; // after the reductions
        uint256 price; // limit price of the last order that went through
        uint256 incPrice; // limit price of its increase, if one is in the set
        Market m;
    }

    uint256 public constant MIN_TANK = 0.2 ether;
    uint256 public constant MIN_TANK_FOR_INCREASE = 0.02 ether;
    uint256 public constant ORDER_TTL = 60;
    /// @dev Bounds per-follower loops (flatten, total cap, a theme's markets) that run inside a shared
    /// group handler.
    uint256 public constant MAX_JOIN_POOLS = 32;
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

    address internal constant REACTIVITY = address(0x0100);
    uint8 internal constant FOK = 1;
    uint8 internal constant IOC = 2;
    bytes4 internal constant IOC_NO_FILL = 0xd48c4403; // ImmediateOrCancelNoFill()
    bytes4 internal constant FOK_NO_FILL = 0xcd74c9c8; // FillOrKillNotFilled()

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
    mapping(address => Follow) internal _follows;
    mapping(address => address[]) internal _synced;
    // Allowlist and synced flags are keyed by a per-follower epoch so an unfollow resets them in O(1).
    mapping(address => uint64) internal _epoch;
    mapping(address => mapping(uint64 => mapping(address => bool))) internal _isSynced;
    mapping(address => mapping(uint64 => mapping(address => bool))) internal _allowed;
    /// @dev Groups ever opened per source. An emptied group keeps its relay and is reused.
    mapping(bytes32 => uint32) public groupCount;
    mapping(bytes32 => mapping(uint32 => bool)) public subscribed;
    GasParams public gasParams;
    /// @dev Members per theme group (trader groups hold `groupSize`): a theme member's sync is heavy.
    uint32 public themeGroupSize;

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
    /// Theme (`ref` = themeId, `joinPools` empty): the hub manages every market that is a leg of the theme
    /// while followed, sized from `p.allocation`, and opens the whole basket now, all legs or none.
    function follow(SourceKind kind, uint256 ref, Policy calldata p, address[] calldata joinPools)
        external
        payable
        nonReentrant
        returns (bytes32 sourceId)
    {
        if (followsPaused) revert FollowsPaused();
        Follow storage f = _follows[msg.sender];
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
        if (theme) {
            _syncTheme(msg.sender, f, themes.legsOf(ref));
            return sourceId;
        }

        mapping(address => bool) storage allowed = _allowed[msg.sender][_epoch[msg.sender]];
        for (uint256 i; i < joinPools.length; ++i) {
            address pool = joinPools[i];
            if (allowed[pool]) continue;
            if (IPerpPool(pool).marginBank() != address(bank)) revert ForeignPool();
            allowed[pool] = true;
            _markSynced(msg.sender, pool);
            _sync(msg.sender, f, pool, _target(f, pool));
        }
    }

    /// @notice Stop following. With `flatten`, every synced position is closed first; `flattened`
    /// in the event reports whether all of them reached zero.
    function unfollow(bool flatten) external nonReentrant {
        Follow storage f = _active(msg.sender);
        bytes32 sourceId = f.sourceId;
        bool flat = flatten && _flatten(msg.sender, f);
        _leaveGroup(f);
        delete _follows[msg.sender];
        delete _synced[msg.sender];
        ++_epoch[msg.sender];
        emit Unfollowed(msg.sender, sourceId, flat);
    }

    function updatePolicy(Policy calldata p) external {
        Follow storage f = _active(msg.sender);
        PolicyLib.validate(p, f.kind);
        f.policy = p;
        emit PolicyUpdated(msg.sender);
    }

    /// @notice Lifts a stop. Allowed when the floor is off or equity is back at or above it.
    function resume() external {
        Follow storage f = _active(msg.sender);
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
        if (left < MIN_TANK && _follows[msg.sender].sourceId != 0) revert TankFloor();
        tankOf[msg.sender] = left;
        totalTanks -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- permissionless sync

    /// @notice Re-sync `pools` of `follower` to the source's current on-chain positions. Anyone may call;
    /// the target always comes from the source, so a call can only move the follower toward it.
    /// A theme follow ignores `pools` and syncs the whole basket.
    function catchUp(address follower, address[] calldata pools) external nonReentrant {
        Follow storage f = _active(follower);
        if (f.kind == SourceKind.Theme) {
            _syncTheme(follower, f, themes.legsOf(f.ref));
        } else {
            for (uint256 i; i < pools.length; ++i) {
                _sync(follower, f, pools[i], _target(f, pools[i]));
            }
        }
    }

    /// @notice Equity-floor check. Below the floor every synced position is closed and the follow paused.
    function poke(address follower) external nonReentrant {
        Follow storage f = _active(follower);
        uint256 floor = f.policy.equityFloor;
        if (floor == 0) return;
        (int256 equity,,,) = bank.getAccountHealth(follower);
        if (equity >= int256(floor)) return;
        _stop(follower, f, equity);
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
        _unsubscribe(oldId);
        Follow storage f = _follows[members[0]];
        _subscribe(sourceId, group, f.kind, f.ref);
    }

    /// @notice Entry point for a group's relay. The event only names the pool (trader) or the theme; the
    /// source is read live (the trader's position, the theme's legs), so a delayed or reordered event can
    /// never open what the source no longer holds.
    /// Each member runs in its own self-call with a bounded gas slot (see GasParams), so one failure stays
    /// with that member, and the handler always keeps enough back to stop cleanly with GroupDeferred, the
    /// rest waiting for catchUp: when the next slot cannot be funded, or when a member runs out of gas in a
    /// slot the handler had to cut short. A member that runs out of a full slot is Deferred alone. Members
    /// pay their own gas from their tank; one with nothing to do pays only the overhead.
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
        bool theme = emitter == address(themes);
        if (theme) {
            if (
                topics.length < 2 || sourceIdOf(SourceKind.Theme, uint256(topics[1])) != sourceId
                    || topics[0] != themes.THEME_REBALANCED_TOPIC()
            ) revert BadEvent();
            legs = themes.legsOf(uint256(topics[1]));
            cap = gp.themePerFollowerCap;
        } else {
            if (
                emitter != address(bank) || topics.length < 3 || topics[0] != POSITION_UPDATED_TOPIC
                    || sourceIdOf(SourceKind.Trader, uint256(topics[1])) != sourceId
            ) revert BadEvent();
            pool = address(uint160(uint256(topics[2])));
            size = _size(address(uint160(uint256(topics[1]))), pool);
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
                    ? abi.encodeCall(this.syncThemeFromEvent, (sourceId, follower, legs))
                    : abi.encodeCall(this.syncFollowerFromEvent, (sourceId, follower, pool, size))
            );
            if (ok) {
                if (abi.decode(ret, (bool))) spent = start - gasleft();
                else reported = false; // nothing to do: the overhead only, silently
            } else {
                bytes memory err = ret;
                bool oog = (err.length == 4 && bytes4(err) == OutOfGasInSync.selector) || _starved(err, start, slot);
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
        Follow storage f = _follows[follower];
        if (f.sourceId != sourceId) return false;
        return _sync(follower, f, pool, PolicyLib.traderTarget(sourceSize, f.policy.scaleBps));
    }

    /// @notice One theme follower's share of a rebalance, against the legs read once for the event. Only
    /// callable by the hub itself, from onSourceEvent.
    /// @return acted false when the follower no longer follows this theme
    function syncThemeFromEvent(bytes32 sourceId, address follower, Leg[] calldata legs)
        external
        onlySelf
        returns (bool acted)
    {
        Follow storage f = _follows[follower];
        if (f.sourceId != sourceId) return false;
        _syncTheme(follower, f, legs);
        return true;
    }

    /// @notice A theme sync's increase set. Only callable by the hub itself: every leg fills completely
    /// inside its band, or the whole set reverts with the first failing leg and nothing is kept.
    function applyIncreases(address follower, LegOrder[] calldata orders) external onlySelf {
        uint64 expiry = uint64((block.timestamp + ORDER_TTL) * 1e9);
        for (uint256 i; i < orders.length; ++i) {
            LegOrder calldata o = orders[i];
            uint256 before = gasleft();
            try IPerpPool(o.pool)
                .placeOrderFor(follower, o.isBid, 0, o.price, o.qty, expiry, FOK, 0, address(0), 0) returns (
                bool success, uint128
            ) {
                if (!success) revert LegFailed(o.pool, "");
            } catch (bytes memory err) {
                _revertIfStarved(err, before);
                revert LegFailed(o.pool, err);
            }
            int256 got = _size(follower, o.pool);
            if ((o.isBid ? o.expected - got : got - o.expected) >= int256(o.lot)) revert LegFailed(o.pool, "");
        }
    }

    // ---------------------------------------------------------------- views

    function sourceIdOf(SourceKind kind, uint256 ref) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, ref));
    }

    function followOf(address follower)
        external
        view
        returns (bytes32 sourceId, SourceKind kind, uint256 ref, Policy memory policy, bool paused, uint32 group)
    {
        Follow storage f = _follows[follower];
        return (f.sourceId, f.kind, f.ref, f.policy, f.paused, f.group);
    }

    function syncedPools(address follower) external view returns (address[] memory) {
        return _synced[follower];
    }

    function membersOf(bytes32 sourceId, uint32 group) external view returns (address[] memory) {
        return _members[sourceId][group];
    }

    // ---------------------------------------------------------------- groups

    /// @dev Seats the follower in the first group with room, opening a new group (relay + subscription)
    /// when all are full. A reused empty group is subscribed again with its existing relay.
    function _joinGroup(address follower, Follow storage f, bytes32 sourceId, SourceKind kind, uint256 ref) internal {
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

    function _leaveGroup(Follow storage f) internal {
        bytes32 sourceId = f.sourceId;
        uint32 g = f.group;
        address[] storage members = _members[sourceId][g];
        uint256 last = members.length - 1;
        uint32 i = f.index;
        if (i != last) {
            address moved = members[last];
            members[i] = moved;
            _follows[moved].index = i;
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
    /// member in a follow. Low-level: the precompile has no code, which a typed call without return data
    /// rejects.
    function _unsubscribe(uint256 id) internal returns (bool cancelled) {
        bytes memory call = abi.encodeCall(ISomniaReactivityPrecompile.unsubscribe, (id));
        if (gasleft() < UNSUB_GAS * 64 / 63 + 50_000) revert UnsubscribeOutOfGas();
        (cancelled,) = REACTIVITY.call{gas: UNSUB_GAS}(call);
    }

    function _subscribe(bytes32 sourceId, uint32 g, SourceKind kind, uint256 ref) internal {
        address relay = relayOf[sourceId][g];
        SubParams memory s = subParams;
        bool isTrader = kind == SourceKind.Trader;

        ISomniaReactivityPrecompile.SubscriptionData memory d;
        d.eventTopics[0] = isTrader ? POSITION_UPDATED_TOPIC : themes.THEME_REBALANCED_TOPIC();
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

    // ---------------------------------------------------------------- sync engine

    function _target(Follow storage f, address pool) internal view returns (int256) {
        int256 size = bank.getPosition(address(uint160(f.ref)), pool).size;
        return PolicyLib.traderTarget(size, f.policy.scaleBps);
    }

    /// @dev Moves one pool of one follower toward `target`. Never reverts on venue failure.
    /// @return acted false when the pool is outside the follow or already at target (nothing else was read)
    function _sync(address follower, Follow storage f, address pool, int256 target) internal returns (bool) {
        // Outside an allowlist the hub never acts: any position there is the follower's own.
        if (!f.allowAll && !_allowed[follower][_epoch[follower]][pool]) return false;
        int256 cur = _size(follower, pool);
        if (cur == target) return false;
        bytes32 sourceId = f.sourceId;
        (uint256 reduceQty, bool reduceIsBid, uint256 increaseQty, bool increaseIsBid) = PolicyLib.split(cur, target);
        if (reduceQty == 0) {
            // increase only: a gate that already fails is reported without reading the market
            Reason early = _earlyGate(follower, f);
            if (early != Reason.None) {
                emit Refused(follower, sourceId, pool, early, "");
                return true;
            }
        }
        (bool ok, Market memory m) = _market(follower, sourceId, pool);
        if (!ok) return true;

        uint256 price;
        int256 mid = cur;
        if (reduceQty != 0) (price, mid) = _reduce(follower, f, pool, m, cur, reduceQty, reduceIsBid);

        bool capped;
        bool stop;
        int256 equity;
        if (increaseQty != 0) {
            uint256 increasePrice;
            (increasePrice, capped, stop, equity) = _increase(follower, f, pool, m, mid, target, increaseIsBid);
            if (increasePrice != 0) price = increasePrice;
        }

        int256 end = _size(follower, pool);
        if (end != cur) {
            _markSynced(follower, pool);
            emit Copied(follower, sourceId, pool, cur, end, price, capped);
        }
        if (stop) _stop(follower, f, equity);
        return true;
    }

    /// @dev Shrinks `cur` by `qty` with one IOC at the exit band. A close to zero uses the exact size; a
    /// partial trim is rounded to lots and skipped as dust. Returns the limit price (0 when nothing was
    /// sent) and the size after.
    function _reduce(
        address follower,
        Follow storage f,
        address pool,
        Market memory m,
        int256 cur,
        uint256 qty,
        bool isBid
    ) internal returns (uint256 price, int256 mid) {
        mid = cur;
        bool full = qty == _abs(cur);
        if (!full) qty = PolicyLib.toLots(qty, m.lot);
        if (!full && (qty == 0 || qty < m.minQty)) return (0, mid);
        price = PolicyLib.bandPrice(m.mark, PolicyLib.exitBand(f.policy.bandBps), isBid, m.tick);
        bool sent = _place(follower, f.sourceId, pool, isBid, price, qty, IOC);
        mid = _size(follower, pool);
        if (sent && mid == cur) emit Refused(follower, f.sourceId, pool, Reason.BandUnfilled, "");
    }

    /// @dev Moves a theme follower's whole book toward the theme. Phase A: per-market reductions (a dropped
    /// leg's target is flat), never gated and kept whatever follows. Phase B: every increase the basket
    /// needs, as one set behind the theme-level gates, filled all-or-nothing by applyIncreases. A leg
    /// whose market cannot be read, or whose flip did not close, holds the whole set back.
    function _syncTheme(address follower, Follow storage f, Leg[] memory legs) internal {
        bytes32 sourceId = f.sourceId;
        bool complete = _allowLegs(follower, sourceId, legs);
        address[] storage pools = _synced[follower];
        uint256 n = pools.length;
        ThemePool[] memory ps = new ThemePool[](n);
        bool open;
        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            s.pool = pools[i];
            s.cur = _size(follower, s.pool);
            s.mid = s.cur;
            for (uint256 j; j < legs.length; ++j) {
                if (legs[j].pool == s.pool) s.weight = legs[j].weightBps;
            }
            if (s.cur != 0) open = true;
        }
        if (!open) {
            // nothing to reduce: a gate that already fails is reported without reading any market
            Reason early = _earlyGate(follower, f);
            if (early != Reason.None) {
                emit Refused(follower, sourceId, address(0), early, "");
                return;
            }
        }

        Policy memory p = f.policy;
        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            if (s.weight == 0 && s.cur == 0) continue; // a dropped leg already closed
            (s.ok, s.m) = _market(follower, sourceId, s.pool);
            if (!s.ok) {
                if (s.weight != 0) complete = false;
                continue;
            }
            if (s.weight != 0) {
                int256 raw = PolicyLib.themeTarget(p.allocation, s.weight, s.m.mark, s.m.oneBase);
                (s.target, s.capped) = PolicyLib.clampNotional(raw, s.m.mark, s.m.oneBase, p.maxNotional);
            }
            (uint256 reduceQty, bool reduceIsBid,,) = PolicyLib.split(s.cur, s.target);
            if (reduceQty != 0) (s.price, s.mid) = _reduce(follower, f, s.pool, s.m, s.cur, reduceQty, reduceIsBid);
        }

        (LegOrder[] memory orders, uint256 total, bool setOk) = _increaseSet(follower, sourceId, ps, p.bandBps);
        bool stop;
        int256 equity;
        if (orders.length != 0 && complete && setOk) {
            Reason r;
            (r, equity) = _gate(follower, f, address(0), total);
            if (r != Reason.None) {
                emit Refused(follower, sourceId, address(0), r, "");
                stop = r == Reason.EquityFloor;
            } else if (_applySet(follower, sourceId, orders)) {
                for (uint256 i; i < n; ++i) {
                    if (ps[i].incPrice != 0) ps[i].price = ps[i].incPrice;
                }
            }
        }

        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            if (!s.ok) continue;
            int256 end = _size(follower, s.pool);
            if (end != s.cur) emit Copied(follower, sourceId, s.pool, s.cur, end, s.price, s.capped);
        }
        if (stop) _stop(follower, f, equity);
    }

    /// @dev Adds the theme's legs to the follow's markets, allowlisted and synced for the rest of the follow
    /// so a dropped leg can always be closed. Returns false when the MAX_JOIN_POOLS bound left a leg out.
    function _allowLegs(address follower, bytes32 sourceId, Leg[] memory legs) internal returns (bool all) {
        mapping(address => bool) storage allowed = _allowed[follower][_epoch[follower]];
        all = true;
        for (uint256 i; i < legs.length; ++i) {
            address pool = legs[i].pool;
            if (allowed[pool]) continue;
            if (_synced[follower].length >= MAX_JOIN_POOLS) {
                emit Refused(follower, sourceId, pool, Reason.MarketNotAllowed, "");
                all = false;
                continue;
            }
            allowed[pool] = true;
            _markSynced(follower, pool);
        }
    }

    /// @dev The increases the basket needs after the reductions, and the notional of the whole book once
    /// they fill (an unreadable market holding a position makes it unbounded, failing a total cap closed).
    /// `ok` is false when a leg's flip did not close, which holds the set back.
    function _increaseSet(address follower, bytes32 sourceId, ThemePool[] memory ps, uint16 bandBps)
        internal
        returns (LegOrder[] memory orders, uint256 total, bool ok)
    {
        uint256 n = ps.length;
        orders = new LegOrder[](n);
        uint256 k;
        ok = true;
        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            if (!s.ok) {
                if (s.cur != 0) total = type(uint256).max;
                continue;
            }
            int256 end = s.mid;
            if (s.target != 0 && s.mid != 0 && (s.mid > 0) != (s.target > 0)) {
                emit Refused(follower, sourceId, s.pool, Reason.LegFailed, "");
                ok = false;
            } else if (_abs(s.target) > _abs(s.mid)) {
                uint256 qty = PolicyLib.toLots(_abs(s.target) - _abs(s.mid), s.m.lot);
                if (qty != 0 && qty >= s.m.minQty) {
                    bool isBid = s.target > 0;
                    end = isBid ? s.mid + int256(qty) : s.mid - int256(qty);
                    s.incPrice = PolicyLib.bandPriceInward(s.m.mark, bandBps, isBid, s.m.tick);
                    orders[k++] = LegOrder(s.pool, isBid, s.incPrice, qty, end, s.m.lot);
                }
            }
            if (total != type(uint256).max) total += PolicyLib.notional(end, s.m.mark, s.m.oneBase);
        }
        assembly ("memory-safe") {
            mstore(orders, k)
        }
    }

    /// @dev Runs the increase set in a self-call so a failing leg rolls back every leg before it. A failure
    /// is reported once, on the failing leg with the venue's error.
    function _applySet(address follower, bytes32 sourceId, LegOrder[] memory orders) internal returns (bool) {
        uint256 before = gasleft();
        try this.applyIncreases(follower, orders) {
            return true;
        } catch (bytes memory err) {
            _revertIfStarved(err, before);
            bytes4 sel = bytes4(err);
            if (sel == OutOfGasInSync.selector) revert OutOfGasInSync();
            address pool;
            if (sel == LegFailed.selector) {
                assembly ("memory-safe") {
                    // drop the selector: err becomes the abi-encoded (pool, venueError)
                    let len := mload(err)
                    err := add(err, 4)
                    mstore(err, sub(len, 4))
                }
                (pool, err) = abi.decode(err, (address, bytes));
            }
            emit Refused(follower, sourceId, pool, Reason.LegFailed, err);
            return false;
        }
    }

    /// @dev The increase gates that need no market data, in _gate's order. With an equity floor armed the
    /// tank check is left to _gate, so the floor (which can stop the follow) is still evaluated first.
    function _earlyGate(address follower, Follow storage f) internal view returns (Reason) {
        if (f.paused) return Reason.Paused;
        if (f.policy.equityFloor == 0 && tankOf[follower] < MIN_TANK_FOR_INCREASE) return Reason.TankEmpty;
        return Reason.None;
    }

    /// @dev Grows the position from `mid` toward `target`, clamped, as one fill-or-kill order inside the band.
    /// Returns the limit price and cap flag when the order was accepted, and whether the equity floor tripped.
    function _increase(
        address follower,
        Follow storage f,
        address pool,
        Market memory m,
        int256 mid,
        int256 target,
        bool isBid
    ) internal returns (uint256 price, bool capped, bool stop, int256 equity) {
        // a flip whose closing leg did not complete waits for the next sync
        if (mid != 0 && (mid > 0) != (target > 0)) return (0, false, false, 0);
        int256 clamped;
        (clamped, capped) = PolicyLib.clampNotional(target, m.mark, m.oneBase, f.policy.maxNotional);
        uint256 have = _abs(mid);
        uint256 want = _abs(clamped);
        if (want <= have) return (0, false, false, 0);
        uint256 qty = PolicyLib.toLots(want - have, m.lot);
        if (qty == 0 || qty < m.minQty) return (0, false, false, 0);
        int256 expected = isBid ? mid + int256(qty) : mid - int256(qty);

        Reason r;
        (r, equity) = _gate(follower, f, pool, PolicyLib.notional(expected, m.mark, m.oneBase));
        if (r != Reason.None) {
            emit Refused(follower, f.sourceId, pool, r, "");
            return (0, false, r == Reason.EquityFloor, equity);
        }

        price = PolicyLib.bandPriceInward(m.mark, f.policy.bandBps, isBid, m.tick);
        if (!_place(follower, f.sourceId, pool, isBid, price, qty, FOK)) return (0, false, false, equity);
        int256 got = _size(follower, pool);
        int256 short = isBid ? expected - got : got - expected;
        if (short >= int256(m.lot)) emit Refused(follower, f.sourceId, pool, Reason.BandUnfilled, "");
    }

    /// @dev Increase gates in order (the allowlist is enforced earlier, in _sync). EquityFloor also returns
    /// the equity read for the stop; an unreadable account health refuses the increase without stopping.
    /// `newNotional` is the notional of `pool` after the increase, or with `pool` zero (a theme's set) the
    /// notional of the follow's whole book after it.
    function _gate(address follower, Follow storage f, address pool, uint256 newNotional)
        internal
        view
        returns (Reason, int256 equity)
    {
        Policy storage p = f.policy;
        if (f.paused) return (Reason.Paused, 0);
        if (p.equityFloor != 0) {
            uint256 before = gasleft();
            try bank.getAccountHealth(follower) returns (int256 e, uint256, uint256, uint256) {
                equity = e;
            } catch (bytes memory err) {
                _revertIfStarved(err, before);
                return (Reason.VenueRejected, 0);
            }
            if (equity < int256(uint256(p.equityFloor))) return (Reason.EquityFloor, equity);
        }
        uint256 cap = p.maxTotalNotional;
        if (cap != 0 && (pool == address(0) ? newNotional > cap : !_withinTotal(follower, pool, newNotional, cap))) {
            return (Reason.TotalCap, equity);
        }
        if (tankOf[follower] < MIN_TANK_FOR_INCREASE) return (Reason.TankEmpty, equity);
        address gate = riskGate;
        if (gate != address(0)) {
            uint256 before = gasleft();
            try IRiskGate(gate).allowIncrease(f.sourceId) returns (bool allowed) {
                if (!allowed) return (Reason.RiskGate, equity);
            } catch (bytes memory err) {
                _revertIfStarved(err, before);
                return (Reason.RiskGate, equity);
            }
        }
        return (Reason.None, equity);
    }

    /// @dev Sum of the follower's other synced positions at mark plus `sum`, against `cap`.
    /// An unreadable mark fails closed.
    function _withinTotal(address follower, address pool, uint256 sum, uint256 cap) internal view returns (bool) {
        address[] storage pools = _synced[follower];
        for (uint256 i; i < pools.length; ++i) {
            address other = pools[i];
            if (other == pool) continue;
            int256 size = _size(follower, other);
            if (size == 0) continue;
            uint256 mark;
            uint256 before = gasleft();
            try IPerpPool(other).getMarkPrice() returns (uint256 x) {
                mark = x;
            } catch (bytes memory err) {
                _revertIfStarved(err, before);
                return false;
            }
            uint256 oneBase;
            before = gasleft();
            try IPerpPool(other).getOneBase() returns (uint256 x) {
                oneBase = x;
            } catch (bytes memory err) {
                _revertIfStarved(err, before);
                return false;
            }
            if (mark == 0 || oneBase == 0) return false;
            sum += PolicyLib.notional(size, mark, oneBase);
        }
        return sum <= cap;
    }

    function _stop(address follower, Follow storage f, int256 equity) internal {
        _flatten(follower, f);
        f.paused = true;
        emit Stopped(follower, equity);
    }

    /// @return closed whether every synced position is zero afterwards
    function _flatten(address follower, Follow storage f) internal returns (bool closed) {
        address[] storage pools = _synced[follower];
        closed = true;
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            _sync(follower, f, pool, 0);
            if (_size(follower, pool) != 0) closed = false;
        }
    }

    /// @dev Reads mark and book parameters. A reverting or zero read is reported (with the revert data)
    /// and skips the pool.
    function _market(address follower, bytes32 sourceId, address pool) internal returns (bool, Market memory m) {
        bytes memory err;
        uint256 before = gasleft();
        try IPerpPool(pool).getMarkPrice() returns (uint256 x) {
            m.mark = x;
        } catch (bytes memory e) {
            _revertIfStarved(e, before);
            err = e;
        }
        if (m.mark != 0) {
            before = gasleft();
            try IPerpPool(pool).getOrderBookParameters() returns (IPerpPool.OBParams memory ob) {
                m.tick = ob.tickSize;
                m.lot = ob.lotSize;
                m.minQty = ob.minQuantity;
            } catch (bytes memory e) {
                _revertIfStarved(e, before);
                err = e;
            }
        }
        if (m.tick != 0) {
            before = gasleft();
            try IPerpPool(pool).getOneBase() returns (uint256 x) {
                m.oneBase = x;
            } catch (bytes memory e) {
                _revertIfStarved(e, before);
                err = e;
            }
        }
        if (m.mark == 0 || m.tick == 0 || m.lot == 0 || m.oneBase == 0) {
            emit Refused(follower, sourceId, pool, Reason.VenueRejected, err);
            return (false, m);
        }
        return (true, m);
    }

    /// @return filled false when the venue reported no fill or rejected the order (already reported)
    function _place(
        address follower,
        bytes32 sourceId,
        address pool,
        bool isBid,
        uint256 price,
        uint256 qty,
        uint8 orderType
    ) internal returns (bool filled) {
        uint64 expiry = uint64((block.timestamp + ORDER_TTL) * 1e9);
        uint256 before = gasleft();
        try IPerpPool(pool).placeOrderFor(follower, isBid, 0, price, qty, expiry, orderType, 0, address(0), 0) returns (
            bool success, uint128
        ) {
            if (success) return true;
            emit Refused(follower, sourceId, pool, Reason.BandUnfilled, "");
        } catch (bytes memory err) {
            _revertIfStarved(err, before);
            bytes4 sel = bytes4(err);
            Reason r = sel == IOC_NO_FILL || sel == FOK_NO_FILL ? Reason.BandUnfilled : Reason.VenueRejected;
            emit Refused(follower, sourceId, pool, r, err);
        }
        return false;
    }

    /// @dev True for a call that reverted without data after spending nearly all the gas it could get
    /// (at most `cap`): it ran out of gas somewhere below (each nested frame keeps 1/64 back) rather
    /// than answering.
    function _starved(bytes memory err, uint256 before, uint256 cap) internal view returns (bool) {
        if (err.length != 0) return false;
        uint256 given = before - before / 64;
        if (cap < given) given = cap;
        return before - gasleft() >= given - given / 8;
    }

    /// @dev Out of gas is not a venue's answer: the sync aborts. In the reactive handler the member is
    /// deferred; any other caller's transaction reverts, so its gas estimate always covers the venue calls.
    function _revertIfStarved(bytes memory err, uint256 before) internal view {
        if (_starved(err, before, type(uint256).max)) revert OutOfGasInSync();
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

    function _markSynced(address follower, address pool) internal {
        mapping(address => bool) storage synced = _isSynced[follower][_epoch[follower]];
        if (synced[pool]) return;
        synced[pool] = true;
        _synced[follower].push(pool);
    }

    function _active(address follower) internal view returns (Follow storage f) {
        f = _follows[follower];
        if (f.sourceId == 0) revert NotFollowing();
    }

    function _size(address account, address pool) internal view returns (int256) {
        return bank.getPosition(account, pool).size;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }
}

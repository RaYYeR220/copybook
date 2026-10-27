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
import {Policy, Reason, SourceKind} from "./Types.sol";
import {IMarginBank, IPerpPool, IRiskGate} from "./interfaces/IDreamPerps.sol";

/// @title CopybookHub
/// @notice The operator followers link on dreamDEX. Keeps each follower's perp positions in sync with
/// one source under the follower's Policy. In the markets a follow manages, reductions are never gated;
/// increases are fill-or-kill priced inside the follower's band and pass every policy gate first.
contract CopybookHub is Ownable2Step, ReentrancyGuard {
    error AlreadyFollowing();
    error NotFollowing();
    error TankTooLow();
    error InsufficientTank();
    error TransferFailed();
    error ThemeNotSupported();
    error InvalidSource();
    error ForeignPool();
    error TooManyPools();
    error FollowsPaused();
    error InvalidGroupSize();
    error NotRelay();
    error BadEvent();
    error StillBelowFloor();

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

    struct Market {
        uint256 mark;
        uint256 tick;
        uint256 lot;
        uint256 minQty;
        uint256 oneBase;
    }

    uint256 public constant MIN_TANK = 0.2 ether;
    uint256 public constant MIN_TANK_FOR_INCREASE = 0.02 ether;
    uint256 public constant ORDER_TTL = 60;
    /// @dev Bounds per-follower loops (flatten, total cap) that run inside a shared group handler.
    uint256 public constant MAX_JOIN_POOLS = 32;
    bytes32 public constant POSITION_UPDATED_TOPIC = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;

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

    constructor(IMarginBank bank_, ThemeRegistry themes_, uint32 groupSize_, address owner_) Ownable(owner_) {
        if (groupSize_ == 0) revert InvalidGroupSize();
        bank = bank_;
        themes = themes_;
        groupSize = groupSize_;
        subParams = SubParams({
            priorityFeePerGas: 0,
            maxFeePerGas: 20 gwei,
            traderGasLimit: 60_000_000,
            themeGasLimit: 150_000_000,
            guaranteed: false
        });
    }

    /// @dev Funds the subscription balance the Reactivity precompile requires of the hub.
    receive() external payable {}

    // ---------------------------------------------------------------- follower lifecycle

    /// @notice Follow a source. `joinPools` non-empty: the hub manages only those markets and copies the
    /// source's current positions there now; every other market of the follower is never touched.
    /// Empty (`allowAll`): the hub manages every market the source trades, including any position the
    /// follower already holds there, and nothing is opened until the source moves.
    function follow(SourceKind kind, uint256 ref, Policy calldata p, address[] calldata joinPools)
        external
        payable
        nonReentrant
        returns (bytes32 sourceId)
    {
        if (followsPaused) revert FollowsPaused();
        if (kind != SourceKind.Trader) revert ThemeNotSupported();
        Follow storage f = _follows[msg.sender];
        if (f.sourceId != 0) revert AlreadyFollowing();
        if (msg.value < MIN_TANK) revert TankTooLow();
        if (ref == 0 || ref > type(uint160).max || address(uint160(ref)) == msg.sender) revert InvalidSource();
        if (joinPools.length > MAX_JOIN_POOLS) revert TooManyPools();
        PolicyLib.validate(p, kind);

        sourceId = sourceIdOf(kind, ref);
        f.sourceId = sourceId;
        f.ref = ref;
        f.policy = p;
        f.kind = kind;
        f.allowAll = joinPools.length == 0;
        tankOf[msg.sender] += msg.value;
        totalTanks += msg.value;
        _joinGroup(msg.sender, f, sourceId, kind, ref);
        emit Followed(msg.sender, sourceId, kind, ref);

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

    function withdrawTank(uint256 amount) external nonReentrant {
        uint256 tank = tankOf[msg.sender];
        if (amount > tank) revert InsufficientTank();
        tankOf[msg.sender] = tank - amount;
        totalTanks -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- permissionless sync

    /// @notice Re-sync `pools` of `follower` to the source's current on-chain positions. Anyone may call;
    /// the target always comes from the source, so a call can only move the follower toward it.
    function catchUp(address follower, address[] calldata pools) external nonReentrant {
        Follow storage f = _active(follower);
        for (uint256 i; i < pools.length; ++i) {
            _sync(follower, f, pools[i], _target(f, pools[i]));
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

    /// @notice Entry point for a group's relay. The event only names the pool; the size is the trader's
    /// live position, so a delayed or reordered event can never open what the trader no longer holds.
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
        if (
            emitter != address(bank) || topics.length < 3 || topics[0] != POSITION_UPDATED_TOPIC
                || sourceIdOf(SourceKind.Trader, uint256(topics[1])) != sourceId
        ) revert BadEvent();
        address pool = address(uint160(uint256(topics[2])));
        int256 size = _size(address(uint160(uint256(topics[1]))), pool);

        address[] storage members = _members[sourceId][group];
        for (uint256 i; i < members.length; ++i) {
            address follower = members[i];
            Follow storage f = _follows[follower];
            _sync(follower, f, pool, PolicyLib.traderTarget(size, f.policy.scaleBps));
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

    function _joinGroup(address follower, Follow storage f, bytes32 sourceId, SourceKind kind, uint256 ref) internal {
        uint32 g = 0;
        if (relayOf[sourceId][g] == address(0)) _openGroup(sourceId, g, kind, ref);
        address[] storage members = _members[sourceId][g];
        f.group = g;
        f.index = uint32(members.length);
        members.push(follower);
    }

    function _leaveGroup(Follow storage f) internal {
        address[] storage members = _members[f.sourceId][f.group];
        uint256 last = members.length - 1;
        uint32 i = f.index;
        if (i != last) {
            address moved = members[last];
            members[i] = moved;
            _follows[moved].index = i;
        }
        members.pop();
    }

    function _openGroup(bytes32 sourceId, uint32 g, SourceKind kind, uint256 ref) internal {
        address relay = address(new GroupRelay(address(this), sourceId, g));
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
        relayOf[sourceId][g] = relay;
        subscriptionOf[sourceId][g] = id;
        emit GroupOpened(sourceId, g, relay, id);
    }

    // ---------------------------------------------------------------- sync engine

    function _target(Follow storage f, address pool) internal view returns (int256) {
        int256 size = bank.getPosition(address(uint160(f.ref)), pool).size;
        return PolicyLib.traderTarget(size, f.policy.scaleBps);
    }

    /// @dev Moves one pool of one follower toward `target`. Never reverts on venue failure.
    function _sync(address follower, Follow storage f, address pool, int256 target) internal {
        // Outside an allowlist the hub never acts: any position there is the follower's own.
        if (!f.allowAll && !_allowed[follower][_epoch[follower]][pool]) return;
        int256 cur = _size(follower, pool);
        if (cur == target) return;
        bytes32 sourceId = f.sourceId;
        (bool ok, Market memory m) = _market(follower, sourceId, pool);
        if (!ok) return;

        (uint256 reduceQty, bool reduceIsBid, uint256 increaseQty, bool increaseIsBid) = PolicyLib.split(cur, target);
        uint256 price;
        int256 mid = cur;
        if (reduceQty != 0) {
            // A close to zero uses the exact size; a partial trim is rounded to lots and skipped as dust.
            bool full = reduceQty == _abs(cur);
            if (!full) reduceQty = PolicyLib.toLots(reduceQty, m.lot);
            if (full || (reduceQty != 0 && reduceQty >= m.minQty)) {
                price = PolicyLib.bandPrice(m.mark, PolicyLib.exitBand(f.policy.bandBps), reduceIsBid, m.tick);
                bool sent = _place(follower, sourceId, pool, reduceIsBid, price, reduceQty, IOC);
                mid = _size(follower, pool);
                if (sent && mid == cur) emit Refused(follower, sourceId, pool, Reason.BandUnfilled, "");
            }
        }

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
    function _gate(address follower, Follow storage f, address pool, uint256 newNotional)
        internal
        view
        returns (Reason, int256 equity)
    {
        Policy storage p = f.policy;
        if (f.paused) return (Reason.Paused, 0);
        if (p.equityFloor != 0) {
            try bank.getAccountHealth(follower) returns (int256 e, uint256, uint256, uint256) {
                equity = e;
            } catch {
                return (Reason.VenueRejected, 0);
            }
            if (equity < int256(uint256(p.equityFloor))) return (Reason.EquityFloor, equity);
        }
        if (p.maxTotalNotional != 0 && !_withinTotal(follower, pool, newNotional, p.maxTotalNotional)) {
            return (Reason.TotalCap, equity);
        }
        if (tankOf[follower] < MIN_TANK_FOR_INCREASE) return (Reason.TankEmpty, equity);
        address gate = riskGate;
        if (gate != address(0)) {
            try IRiskGate(gate).allowIncrease(f.sourceId) returns (bool allowed) {
                if (!allowed) return (Reason.RiskGate, equity);
            } catch {
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
            try IPerpPool(other).getMarkPrice() returns (uint256 x) {
                mark = x;
            } catch {
                return false;
            }
            uint256 oneBase;
            try IPerpPool(other).getOneBase() returns (uint256 x) {
                oneBase = x;
            } catch {
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
        try IPerpPool(pool).getMarkPrice() returns (uint256 x) {
            m.mark = x;
        } catch (bytes memory e) {
            err = e;
        }
        if (m.mark != 0) {
            try IPerpPool(pool).getOrderBookParameters() returns (IPerpPool.OBParams memory ob) {
                m.tick = ob.tickSize;
                m.lot = ob.lotSize;
                m.minQty = ob.minQuantity;
            } catch (bytes memory e) {
                err = e;
            }
        }
        if (m.tick != 0) {
            try IPerpPool(pool).getOneBase() returns (uint256 x) {
                m.oneBase = x;
            } catch (bytes memory e) {
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
        try IPerpPool(pool).placeOrderFor(follower, isBid, 0, price, qty, expiry, orderType, 0, address(0), 0) returns (
            bool success, uint128
        ) {
            if (success) return true;
            emit Refused(follower, sourceId, pool, Reason.BandUnfilled, "");
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            Reason r = sel == IOC_NO_FILL || sel == FOK_NO_FILL ? Reason.BandUnfilled : Reason.VenueRejected;
            emit Refused(follower, sourceId, pool, r, err);
        }
        return false;
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

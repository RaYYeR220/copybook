// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PolicyLib} from "./PolicyLib.sol";
import {Leg, Policy, Reason, SourceKind} from "./Types.sol";
import {IMarginBank, IPerpPool, IRiskGate} from "./interfaces/IDreamPerps.sol";

/// @dev The hub's self-call that runs a theme's increase set.
interface IIncreaseSet {
    function applyIncreases(address follower, CopyEngine.LegOrder[] calldata orders) external;
}

/// @title CopyEngine
/// @notice CopybookHub's per-follower sync engine, linked as an external library: it runs by delegatecall on
/// the hub's storage (the Books the hub declares), so it acts and emits as the hub. In the markets a follow
/// manages, reductions are never gated; increases are fill-or-kill priced inside the follower's band and pass
/// every policy gate first. A thesis opens all its legs or none.
library CopyEngine {
    error ForeignPool();
    error OutOfGasInSync();
    error LegFailed(address pool, bytes venueError);

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

    struct Follow {
        bytes32 sourceId; // zero when not following
        uint256 ref;
        Policy policy;
        SourceKind kind;
        bool paused;
        bool allowAll;
        uint32 group;
        uint32 index; // position in the group's member list
        uint32 syncedVersion; // theme: registry version of the last sync that left every leg at target
        bool lastSyncComplete; // theme: the last sync left every leg at target
    }

    /// @dev The hub's per-follower books. Allowlist and synced flags are keyed by a per-follower epoch so an
    /// unfollow resets them in O(1).
    struct Books {
        mapping(address => Follow) follows;
        mapping(address => address[]) synced;
        mapping(address => uint64) epoch;
        mapping(address => mapping(uint64 => mapping(address => bool))) isSynced;
        mapping(address => mapping(uint64 => mapping(address => bool))) allowed;
    }

    /// @dev What one follower's sync reads besides its books, fixed for the call.
    struct Env {
        IMarginBank bank;
        address follower;
        address riskGate;
        uint256 tank;
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

    uint256 internal constant MIN_TANK_FOR_INCREASE = 0.02 ether;
    uint256 internal constant ORDER_TTL = 60;
    /// @dev Bounds per-follower loops (flatten, total cap, a theme's markets) that run inside a shared
    /// group handler.
    uint256 internal constant MAX_JOIN_POOLS = 32;
    /// @dev A theme leg on the right side within this share of its target is left alone, so mark drift
    /// alone does not trade.
    uint256 internal constant THEME_DRIFT_BPS = 500;

    uint8 internal constant FOK = 1;
    uint8 internal constant IOC = 2;
    bytes4 internal constant IOC_NO_FILL = 0xd48c4403; // ImmediateOrCancelNoFill()
    bytes4 internal constant FOK_NO_FILL = 0xcd74c9c8; // FillOrKillNotFilled()

    // ---------------------------------------------------------------- entry points (delegatecall)

    /// @notice Allowlists `pools` (each a perp market registered with the bank) for a trader follow and
    /// copies the source's current positions there.
    function joinPools(Books storage b, Env memory e, address[] calldata pools) external {
        Follow storage f = b.follows[e.follower];
        mapping(address => bool) storage allowed = b.allowed[e.follower][b.epoch[e.follower]];
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            if (allowed[pool]) continue;
            if (!e.bank.isPerpPoolRegistered(pool)) revert ForeignPool();
            allowed[pool] = true;
            _markSynced(b, e.follower, pool);
            _sync(b, e, f, pool, _target(e, f, pool));
        }
    }

    /// @notice Moves `pools` of a trader follow to the source's current positions.
    function syncPools(Books storage b, Env memory e, address[] calldata pools) external {
        Follow storage f = b.follows[e.follower];
        for (uint256 i; i < pools.length; ++i) {
            _sync(b, e, f, pools[i], _target(e, f, pools[i]));
        }
    }

    /// @notice Moves one pool of a trader follow to the source size read for an event.
    /// @return acted false when the pool is outside the follow or already at target
    function syncTrader(Books storage b, Env memory e, address pool, int256 sourceSize) external returns (bool) {
        Follow storage f = b.follows[e.follower];
        return _sync(b, e, f, pool, PolicyLib.traderTarget(sourceSize, f.policy.scaleBps));
    }

    /// @notice Moves a theme follow's whole book toward `legs` at theme version `version`.
    /// @return acted whether anything was sent or refused
    function syncTheme(Books storage b, Env memory e, Leg[] memory legs, uint32 version) external returns (bool) {
        return _syncTheme(b, e, b.follows[e.follower], legs, version);
    }

    /// @notice Closes every synced position of the follow.
    /// @return closed whether every synced position is zero afterwards
    function flatten(Books storage b, Env memory e) external returns (bool) {
        return _flatten(b, e, b.follows[e.follower]);
    }

    /// @notice The equity stop: every synced position is closed and the follow paused.
    function stop(Books storage b, Env memory e, int256 equity) external {
        _stop(b, e, b.follows[e.follower], equity);
    }

    /// @notice A theme sync's increase set, run inside the hub's self-call: every leg fills completely inside
    /// its band, or the whole set reverts with the first failing leg and nothing is kept.
    function applyIncreases(IMarginBank bank, address follower, LegOrder[] calldata orders) external {
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
            int256 got = _size(bank, follower, o.pool);
            if ((o.isBid ? o.expected - got : got - o.expected) >= int256(o.lot)) revert LegFailed(o.pool, "");
        }
    }

    // ---------------------------------------------------------------- shared with the hub

    /// @dev True for a call that reverted without data after spending nearly all the gas it could get
    /// (at most `cap`): it ran out of gas somewhere below (each nested frame keeps 1/64 back) rather
    /// than answering.
    function starved(bytes memory err, uint256 before, uint256 cap) internal view returns (bool) {
        if (err.length != 0) return false;
        uint256 given = before - before / 64;
        if (cap < given) given = cap;
        return before - gasleft() >= given - given / 8;
    }

    // ---------------------------------------------------------------- trader sync

    function _target(Env memory e, Follow storage f, address pool) internal view returns (int256) {
        return PolicyLib.traderTarget(_size(e.bank, address(uint160(f.ref)), pool), f.policy.scaleBps);
    }

    /// @dev Moves one pool of one follower toward `target`. Never reverts on venue failure.
    /// @return acted false when the pool is outside the follow or already at target (nothing else was read)
    function _sync(Books storage b, Env memory e, Follow storage f, address pool, int256 target)
        internal
        returns (bool)
    {
        address follower = e.follower;
        // Outside an allowlist the hub never acts: any position there is the follower's own.
        if (!f.allowAll && !b.allowed[follower][b.epoch[follower]][pool]) return false;
        int256 cur = _size(e.bank, follower, pool);
        if (cur == target) return false;
        bytes32 sourceId = f.sourceId;
        (uint256 reduceQty, bool reduceIsBid, uint256 increaseQty, bool increaseIsBid) = PolicyLib.split(cur, target);
        if (reduceQty == 0) {
            // increase only: a gate that already fails is reported without reading the market
            Reason early = _earlyGate(e, f);
            if (early != Reason.None) {
                emit Refused(follower, sourceId, pool, early, "");
                return true;
            }
        }
        (bool ok, Market memory m) = _market(follower, sourceId, pool);
        if (!ok) return true;

        uint256 price;
        int256 mid = cur;
        if (reduceQty != 0) (price, mid) = _reduce(e, f, pool, m, cur, reduceQty, reduceIsBid);

        bool capped;
        bool stopped;
        int256 equity;
        if (increaseQty != 0) {
            uint256 increasePrice;
            (increasePrice, capped, stopped, equity) = _increase(b, e, f, pool, m, mid, target, increaseIsBid);
            if (increasePrice != 0) price = increasePrice;
        }

        int256 end = _size(e.bank, follower, pool);
        if (end != cur) {
            _markSynced(b, follower, pool);
            emit Copied(follower, sourceId, pool, cur, end, price, capped);
        }
        if (stopped) _stop(b, e, f, equity);
        return true;
    }

    /// @dev Shrinks `cur` by `qty` with one IOC at the exit band. A close to zero uses the exact size; a
    /// partial trim is rounded to lots and skipped as dust. Returns the limit price (0 when nothing was
    /// sent) and the size after.
    function _reduce(Env memory e, Follow storage f, address pool, Market memory m, int256 cur, uint256 qty, bool isBid)
        internal
        returns (uint256 price, int256 mid)
    {
        mid = cur;
        bool full = qty == _abs(cur);
        if (!full) qty = PolicyLib.toLots(qty, m.lot);
        if (!full && (qty == 0 || qty < m.minQty)) return (0, mid);
        price = PolicyLib.bandPrice(m.mark, PolicyLib.exitBand(f.policy.bandBps), isBid, m.tick);
        bool sent = _place(e.follower, f.sourceId, pool, isBid, price, qty, IOC);
        mid = _size(e.bank, e.follower, pool);
        if (sent && mid == cur) emit Refused(e.follower, f.sourceId, pool, Reason.BandUnfilled, "");
    }

    /// @dev Grows the position from `mid` toward `target`, clamped, as one fill-or-kill order inside the band.
    /// Returns the limit price and cap flag when the order was accepted, and whether the equity floor tripped.
    function _increase(
        Books storage b,
        Env memory e,
        Follow storage f,
        address pool,
        Market memory m,
        int256 mid,
        int256 target,
        bool isBid
    ) internal returns (uint256 price, bool capped, bool stopped, int256 equity) {
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
        (r, equity) = _gate(b, e, f, pool, PolicyLib.notional(expected, m.mark, m.oneBase));
        if (r != Reason.None) {
            emit Refused(e.follower, f.sourceId, pool, r, "");
            return (0, false, r == Reason.EquityFloor, equity);
        }

        price = PolicyLib.bandPriceInward(m.mark, f.policy.bandBps, isBid, m.tick);
        if (!_place(e.follower, f.sourceId, pool, isBid, price, qty, FOK)) return (0, false, false, equity);
        int256 got = _size(e.bank, e.follower, pool);
        int256 short = isBid ? expected - got : got - expected;
        if (short >= int256(m.lot)) emit Refused(e.follower, f.sourceId, pool, Reason.BandUnfilled, "");
    }

    // ---------------------------------------------------------------- theme sync

    /// @dev Moves a theme follower's whole book toward the theme. Phase A: per-market reductions (a dropped
    /// leg's target is flat), never gated and kept whatever follows. Phase B: every increase the basket
    /// needs, as one set behind the theme-level gates, filled all-or-nothing by applyIncreases. A leg
    /// whose market cannot be read, whose flip did not close, or that is too small to open holds the whole
    /// set back. A leg on the right side within THEME_DRIFT_BPS of its target is left alone. When every
    /// leg ends at target, `version` is recorded as synced.
    /// @return acted whether anything was sent or refused
    function _syncTheme(Books storage b, Env memory e, Follow storage f, Leg[] memory legs, uint32 version)
        internal
        returns (bool acted)
    {
        address follower = e.follower;
        bytes32 sourceId = f.sourceId;
        bool complete = _allowLegs(b, follower, sourceId, legs);
        acted = !complete;
        address[] storage pools = b.synced[follower];
        uint256 n = pools.length;
        ThemePool[] memory ps = new ThemePool[](n);
        bool open;
        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            s.pool = pools[i];
            s.cur = _size(e.bank, follower, s.pool);
            s.mid = s.cur;
            for (uint256 j; j < legs.length; ++j) {
                if (legs[j].pool == s.pool) s.weight = legs[j].weightBps;
            }
            if (s.cur != 0) open = true;
        }
        if (!open) {
            // nothing to reduce: a gate that already fails is reported without reading any market
            Reason early = _earlyGate(e, f);
            if (early != Reason.None) {
                emit Refused(follower, sourceId, address(0), early, "");
                f.lastSyncComplete = false;
                return true;
            }
        }

        Policy memory p = f.policy;
        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            if (s.weight == 0 && s.cur == 0) continue; // a dropped leg already closed
            (s.ok, s.m) = _market(follower, sourceId, s.pool);
            if (!s.ok) {
                acted = true;
                if (s.weight != 0) complete = false;
                continue;
            }
            if (s.weight != 0) {
                int256 raw = PolicyLib.themeTarget(p.allocation, s.weight, s.m.mark, s.m.oneBase);
                (s.target, s.capped) = PolicyLib.clampNotional(raw, s.m.mark, s.m.oneBase, p.maxNotional);
            }
            if (_settled(s.cur, s.target, s.m)) continue;
            (uint256 reduceQty, bool reduceIsBid,,) = PolicyLib.split(s.cur, s.target);
            if (reduceQty != 0) {
                (s.price, s.mid) = _reduce(e, f, s.pool, s.m, s.cur, reduceQty, reduceIsBid);
                if (s.price != 0) acted = true;
            }
        }

        (LegOrder[] memory orders, uint256 total, bool setOk) = _increaseSet(follower, sourceId, ps, p.bandBps);
        if (!setOk || orders.length != 0) acted = true;
        bool stopped;
        int256 equity;
        if (orders.length != 0 && complete && setOk) {
            Reason r;
            (r, equity) = _gate(b, e, f, address(0), total);
            if (r != Reason.None) {
                emit Refused(follower, sourceId, address(0), r, "");
                stopped = r == Reason.EquityFloor;
            } else if (_applySet(follower, sourceId, orders)) {
                for (uint256 i; i < n; ++i) {
                    if (ps[i].incPrice != 0) ps[i].price = ps[i].incPrice;
                }
            }
        }

        bool done = complete;
        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            if (!s.ok) {
                if (s.cur != 0) done = false;
                continue;
            }
            int256 end = _size(e.bank, follower, s.pool);
            if (end != s.cur) emit Copied(follower, sourceId, s.pool, s.cur, end, s.price, s.capped);
            if ((s.weight != 0 && s.target == 0) || !_settled(end, s.target, s.m)) done = false;
        }
        if (done && f.syncedVersion != version) f.syncedVersion = version;
        if (f.lastSyncComplete != done) f.lastSyncComplete = done;
        if (stopped) _stop(b, e, f, equity);
    }

    /// @dev True when a theme sync leaves `size` alone against `target`: equal, on the same side within
    /// THEME_DRIFT_BPS of it, or a move below one lot or the venue minimum.
    function _settled(int256 size, int256 target, Market memory m) internal pure returns (bool) {
        if (size == target) return true;
        if (size == 0 || target == 0 || (size > 0) != (target > 0)) return false;
        uint256 have = _abs(size);
        uint256 want = _abs(target);
        uint256 gap = have > want ? have - want : want - have;
        if (gap * 1e4 < THEME_DRIFT_BPS * want) return true;
        gap = PolicyLib.toLots(gap, m.lot);
        return gap == 0 || gap < m.minQty;
    }

    /// @dev Adds the theme's legs to the follow's markets, allowlisted and synced for the rest of the follow
    /// so a dropped leg can always be closed. Returns false when the MAX_JOIN_POOLS bound left a leg out.
    function _allowLegs(Books storage b, address follower, bytes32 sourceId, Leg[] memory legs)
        internal
        returns (bool all)
    {
        mapping(address => bool) storage allowed = b.allowed[follower][b.epoch[follower]];
        all = true;
        for (uint256 i; i < legs.length; ++i) {
            address pool = legs[i].pool;
            if (allowed[pool]) continue;
            if (b.synced[follower].length >= MAX_JOIN_POOLS) {
                emit Refused(follower, sourceId, pool, Reason.MarketNotAllowed, "");
                all = false;
                continue;
            }
            allowed[pool] = true;
            _markSynced(b, follower, pool);
        }
    }

    /// @dev The increases the basket needs after the reductions, and the notional of the whole book once
    /// they fill (an unreadable market holding a position makes it unbounded, failing a total cap closed).
    /// `ok` is false when a leg cannot take its part: its flip did not close, or it is not open and its size
    /// rounds below one lot or the venue minimum. Such a leg is reported and holds the set back; a top-up of
    /// an open leg that small is skipped.
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
            if (s.weight != 0 && (s.mid == 0 || !_settled(s.mid, s.target, s.m))) {
                uint256 want = _abs(s.target);
                uint256 have = _abs(s.mid);
                bool failed = want == 0 || (have != 0 && (s.mid > 0) != (s.target > 0));
                if (!failed && want > have) {
                    // outside the band a top-up is never this small, so only an opening leg fails here
                    uint256 qty = PolicyLib.toLots(want - have, s.m.lot);
                    if (qty == 0 || qty < s.m.minQty) {
                        failed = true;
                    } else {
                        bool isBid = s.target > 0;
                        end = isBid ? s.mid + int256(qty) : s.mid - int256(qty);
                        s.incPrice = PolicyLib.bandPriceInward(s.m.mark, bandBps, isBid, s.m.tick);
                        orders[k++] = LegOrder(s.pool, isBid, s.incPrice, qty, end, s.m.lot);
                    }
                }
                if (failed) {
                    emit Refused(follower, sourceId, s.pool, Reason.LegFailed, "");
                    ok = false;
                }
            }
            if (total != type(uint256).max) total += PolicyLib.notional(end, s.m.mark, s.m.oneBase);
        }
        assembly ("memory-safe") {
            mstore(orders, k)
        }
    }

    /// @dev Runs the increase set in the hub's self-call so a failing leg rolls back every leg before it. A
    /// failure is reported once, on the failing leg with the venue's error.
    function _applySet(address follower, bytes32 sourceId, LegOrder[] memory orders) internal returns (bool) {
        uint256 before = gasleft();
        try IIncreaseSet(address(this)).applyIncreases(follower, orders) {
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

    // ---------------------------------------------------------------- gates

    /// @dev The increase gates that need no market data, in _gate's order. With an equity floor armed the
    /// tank check is left to _gate, so the floor (which can stop the follow) is still evaluated first.
    function _earlyGate(Env memory e, Follow storage f) internal view returns (Reason) {
        if (f.paused) return Reason.Paused;
        if (f.policy.equityFloor == 0 && e.tank < MIN_TANK_FOR_INCREASE) return Reason.TankEmpty;
        return Reason.None;
    }

    /// @dev Increase gates in order (the allowlist is enforced earlier, in _sync). EquityFloor also returns
    /// the equity read for the stop; an unreadable account health refuses the increase without stopping.
    /// `newNotional` is the notional of `pool` after the increase, or with `pool` zero (a theme's set) the
    /// notional of the follow's whole book after it.
    function _gate(Books storage b, Env memory e, Follow storage f, address pool, uint256 newNotional)
        internal
        view
        returns (Reason, int256 equity)
    {
        Policy storage p = f.policy;
        if (f.paused) return (Reason.Paused, 0);
        if (p.equityFloor != 0) {
            uint256 before = gasleft();
            try e.bank.getAccountHealth(e.follower) returns (int256 eq, uint256, uint256, uint256) {
                equity = eq;
            } catch (bytes memory err) {
                _revertIfStarved(err, before);
                return (Reason.VenueRejected, 0);
            }
            if (equity < int256(uint256(p.equityFloor))) return (Reason.EquityFloor, equity);
        }
        uint256 cap = p.maxTotalNotional;
        if (cap != 0 && (pool == address(0) ? newNotional > cap : !_withinTotal(b, e, pool, newNotional, cap))) {
            return (Reason.TotalCap, equity);
        }
        if (e.tank < MIN_TANK_FOR_INCREASE) return (Reason.TankEmpty, equity);
        address gate = e.riskGate;
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
    function _withinTotal(Books storage b, Env memory e, address pool, uint256 sum, uint256 cap)
        internal
        view
        returns (bool)
    {
        address[] storage pools = b.synced[e.follower];
        for (uint256 i; i < pools.length; ++i) {
            address other = pools[i];
            if (other == pool) continue;
            int256 size = _size(e.bank, e.follower, other);
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

    // ---------------------------------------------------------------- stop

    function _stop(Books storage b, Env memory e, Follow storage f, int256 equity) internal {
        _flatten(b, e, f);
        f.paused = true;
        f.lastSyncComplete = false;
        emit Stopped(e.follower, equity);
    }

    /// @return closed whether every synced position is zero afterwards
    function _flatten(Books storage b, Env memory e, Follow storage f) internal returns (bool closed) {
        address[] storage pools = b.synced[e.follower];
        closed = true;
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            _sync(b, e, f, pool, 0);
            if (_size(e.bank, e.follower, pool) != 0) closed = false;
        }
    }

    // ---------------------------------------------------------------- venue

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

    /// @dev Out of gas is not a venue's answer: the sync aborts. In the reactive handler the member is
    /// deferred; any other caller's transaction reverts, so its gas estimate always covers the venue calls.
    function _revertIfStarved(bytes memory err, uint256 before) internal view {
        if (starved(err, before, type(uint256).max)) revert OutOfGasInSync();
    }

    // ---------------------------------------------------------------- books

    function _markSynced(Books storage b, address follower, address pool) internal {
        mapping(address => bool) storage synced = b.isSynced[follower][b.epoch[follower]];
        if (synced[pool]) return;
        synced[pool] = true;
        b.synced[follower].push(pool);
    }

    function _size(IMarginBank bank, address account, address pool) internal view returns (int256) {
        return bank.getPosition(account, pool).size;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }
}

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
/// Every sync has two halves. The exit half only reduces (a flip closes there) and reads no gate; the entry
/// half runs the increases behind the gates and reports an equity stop instead of acting on it. The hub's
/// event handler runs them in separate self-calls, so an increase that fails or runs out of gas never takes
/// a reduction with it; every other caller runs them back to back.
library CopyEngine {
    error ForeignPool();
    error OutOfGasInSync();
    error LegFailed(address pool, bytes venueError);

    /// @param price the limit price of the order that moved the position (its band edge), not the fill price
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
        bool exitPending; // the handler ran out of gas on its exits: they wait for a caller's own transaction
        bool flattenPending; // the handler ran out of gas (or failed) closing a stop: the closes wait the same way
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

    /// @dev What one follower's sync reads besides its books, fixed for the call. `riskGateGas` is the fixed
    /// budget of the risk gate's answer.
    struct Env {
        IMarginBank bank;
        address follower;
        address riskGate;
        uint256 tank;
        uint256 riskGateGas;
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
        int256 mid; // where the increase set starts
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
    bytes4 internal constant FOK_NO_FILL = 0xc04ad919; // FillOrKillNotFillable()

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
            _sync(b, e, f, pool, _target(f, _sourceSize(e, f, pool)));
        }
    }

    /// @notice Moves `pools` of a trader follow to the source's current positions. A follow of every market
    /// acts only where the source holds a position now or the hub has already traded for it, so a market
    /// the source never touched stays the follower's own.
    function syncPools(Books storage b, Env memory e, address[] calldata pools) external {
        Follow storage f = b.follows[e.follower];
        mapping(address => bool) storage synced = b.isSynced[e.follower][b.epoch[e.follower]];
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            int256 size = _sourceSize(e, f, pool);
            if (f.allowAll && size == 0 && !synced[pool]) continue;
            _sync(b, e, f, pool, _target(f, size));
        }
    }

    /// @notice Exit half of a trader event: the reduction toward the source size read for the event.
    /// @return acted false when the pool is outside the follow or nothing needs reducing
    function exitTrader(Books storage b, Env memory e, address pool, int256 sourceSize) external returns (bool) {
        Follow storage f = b.follows[e.follower];
        return _exitTrader(b, e, f, pool, _target(f, sourceSize));
    }

    /// @notice Entry half of a trader event: the increase, behind every gate.
    /// @return acted false when the pool is outside the follow or nothing needs increasing
    /// @return stopped the equity floor tripped: the caller stops the follow
    /// @return equity the equity read for the stop
    function entryTrader(Books storage b, Env memory e, address pool, int256 sourceSize)
        external
        returns (bool acted, bool stopped, int256 equity)
    {
        Follow storage f = b.follows[e.follower];
        return _entryTrader(b, e, f, pool, _target(f, sourceSize));
    }

    /// @notice Moves a theme follow's whole book toward `legs` at theme version `version`, both halves.
    /// @return acted whether anything was sent or refused
    function syncTheme(Books storage b, Env memory e, Leg[] memory legs, uint32 version) external returns (bool) {
        return _syncTheme(b, e, b.follows[e.follower], legs, version);
    }

    /// @notice Exit half of a theme rebalance: every reduction the basket needs (phase A).
    function exitTheme(Books storage b, Env memory e, Leg[] memory legs) external returns (bool) {
        return _themeExit(b, e, b.follows[e.follower], legs);
    }

    /// @notice Entry half of a theme rebalance: the all-or-nothing increase set (phase B).
    function entryTheme(Books storage b, Env memory e, Leg[] memory legs, uint32 version)
        external
        returns (bool acted, bool stopped, int256 equity)
    {
        return _themeEntry(b, e, b.follows[e.follower], legs, version);
    }

    /// @notice Closes every synced position of the follow.
    /// @return closed whether every synced position is zero afterwards
    function flatten(Books storage b, Env memory e) external returns (bool) {
        return _flatten(b, e, b.follows[e.follower]);
    }

    /// @notice The equity stop: the follow is paused, then every synced position is closed. Stopped is emitted
    /// only when this pauses the follow; on one already paused the closes run again without it.
    /// @return closed whether every synced position is zero afterwards
    function stop(Books storage b, Env memory e, int256 equity) external returns (bool) {
        return _stop(b, e, b.follows[e.follower], equity);
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

    function _sourceSize(Env memory e, Follow storage f, address pool) internal view returns (int256) {
        return _size(e.bank, address(uint160(f.ref)), pool);
    }

    function _target(Follow storage f, int256 sourceSize) internal view returns (int256) {
        return PolicyLib.traderTarget(sourceSize, f.policy.scaleBps);
    }

    /// @dev Outside an allowlist the hub never acts: any position there is the follower's own.
    function _inFollow(Books storage b, Follow storage f, address follower, address pool) internal view returns (bool) {
        return f.allowAll || b.allowed[follower][b.epoch[follower]][pool];
    }

    /// @dev Both halves of one pool, back to back; an equity stop pauses and flattens the follow.
    /// @return acted false when the pool is outside the follow or already at target
    function _sync(Books storage b, Env memory e, Follow storage f, address pool, int256 target)
        internal
        returns (bool acted)
    {
        acted = _exitTrader(b, e, f, pool, target);
        (bool entered, bool stopped, int256 equity) = _entryTrader(b, e, f, pool, target);
        if (stopped) _stop(b, e, f, equity);
        return acted || entered;
    }

    /// @dev Shrinks the position toward `target` (to zero on a flip). Never gated, never reverts on a venue
    /// answer.
    function _exitTrader(Books storage b, Env memory e, Follow storage f, address pool, int256 target)
        internal
        returns (bool)
    {
        address follower = e.follower;
        if (!_inFollow(b, f, follower, pool)) return false;
        int256 cur = _size(e.bank, follower, pool);
        (uint256 reduceQty, bool reduceIsBid,,) = PolicyLib.split(cur, target);
        if (reduceQty == 0) return false;
        bytes32 sourceId = f.sourceId;
        (bool ok, Market memory m) = _market(follower, sourceId, pool, true);
        if (!ok) return true;
        (uint256 price, int256 mid) = _reduce(e, f, pool, m, cur, reduceQty, reduceIsBid);
        if (mid != cur) {
            _markSynced(b, follower, pool);
            emit Copied(follower, sourceId, pool, cur, mid, price, false);
        }
        return true;
    }

    /// @dev Grows the position toward `target`, once the exit half left it on the target's side. A flip whose
    /// close left a residue on the old side below one lot or the venue minimum (a close that filled in part)
    /// counts as closed: no close can take that residue, so the increase crosses it in the same order. A gate
    /// that already fails is reported without reading the market. Reports an equity stop, never acts on it.
    function _entryTrader(Books storage b, Env memory e, Follow storage f, address pool, int256 target)
        internal
        returns (bool, bool stopped, int256 equity)
    {
        address follower = e.follower;
        if (!_inFollow(b, f, follower, pool)) return (false, false, 0);
        int256 cur = _size(e.bank, follower, pool);
        (uint256 reduceQty,, uint256 increaseQty, bool isBid) = PolicyLib.split(cur, target);
        if (increaseQty == 0) return (false, false, 0);
        bytes32 sourceId = f.sourceId;
        bool ok;
        Market memory m;
        if (reduceQty != 0) {
            // a flip whose close did not complete waits for the next sync, unless only dust is left
            (ok, m) = _market(follower, sourceId, pool, false);
            if (!ok || _tradable(reduceQty, m) != 0) return (false, false, 0);
        }
        Reason early = _earlyGate(e, f);
        if (early != Reason.None) {
            emit Refused(follower, sourceId, pool, early, "");
            return (true, false, 0);
        }
        if (!ok) {
            (ok, m) = _market(follower, sourceId, pool, true);
            if (!ok) return (true, false, 0);
        }
        uint256 price;
        bool capped;
        (price, capped, stopped, equity) = _increase(b, e, f, pool, m, cur, target, isBid);
        int256 end = _size(e.bank, follower, pool);
        if (end != cur) {
            _markSynced(b, follower, pool);
            emit Copied(follower, sourceId, pool, cur, end, price, capped);
        }
        return (true, stopped, equity);
    }

    /// @dev Shrinks `cur` by `qty` with one IOC at the exit band, in whole lots only: a residue below one lot or
    /// the venue minimum is dust the venue cannot take, left in place without an order (an increase that
    /// crosses zero takes it with it). Returns the limit price (0 when nothing was sent) and the size after.
    function _reduce(Env memory e, Follow storage f, address pool, Market memory m, int256 cur, uint256 qty, bool isBid)
        internal
        returns (uint256 price, int256 mid)
    {
        mid = cur;
        qty = _tradable(qty, m);
        if (qty == 0) return (0, mid);
        price = PolicyLib.bandPrice(m.mark, PolicyLib.exitBand(f.policy.bandBps), isBid, m.tick);
        bool sent = _place(e.follower, f.sourceId, pool, isBid, price, qty, IOC);
        mid = _size(e.bank, e.follower, pool);
        if (sent && mid == cur) emit Refused(e.follower, f.sourceId, pool, Reason.BandUnfilled, "");
    }

    /// @dev Grows the position from `cur` toward `target`, clamped, as one fill-or-kill order inside the band.
    /// A `cur` on the other side (dust no close can take) is crossed by the same order. An increase that is
    /// already at the cap or rounds below one lot or the venue minimum is refused with that reason.
    /// Returns the limit price and cap flag when the order was accepted, and whether the equity floor tripped.
    function _increase(
        Books storage b,
        Env memory e,
        Follow storage f,
        address pool,
        Market memory m,
        int256 cur,
        int256 target,
        bool isBid
    ) internal returns (uint256 price, bool capped, bool stopped, int256 equity) {
        int256 clamped;
        (clamped, capped) = PolicyLib.clampNotional(target, m.mark, m.oneBase, f.policy.maxNotional);
        uint256 have = _abs(cur);
        uint256 want = _abs(clamped);
        bool cross = cur != 0 && (cur > 0) != isBid;
        Reason r;
        uint256 qty;
        if (!cross && want <= have) {
            r = Reason.AtCap;
        } else {
            qty = _tradable(cross ? want + have : want - have, m);
            if (qty == 0) r = Reason.BelowMinimum;
        }
        int256 expected = isBid ? cur + int256(qty) : cur - int256(qty);

        if (r == Reason.None) (r, equity) = _gate(b, e, f, pool, PolicyLib.notional(expected, m.mark, m.oneBase));
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

    /// @dev Both halves of a theme sync, back to back; an equity stop pauses and flattens the follow.
    /// @return acted whether anything was sent or refused
    function _syncTheme(Books storage b, Env memory e, Follow storage f, Leg[] memory legs, uint32 version)
        internal
        returns (bool acted)
    {
        acted = _themeExit(b, e, f, legs);
        (bool entered, bool stopped, int256 equity) = _themeEntry(b, e, f, legs, version);
        if (stopped) _stop(b, e, f, equity);
        return acted || entered;
    }

    /// @dev Phase A: adds new legs to the follow's markets, then makes every reduction the basket needs (a
    /// dropped leg's target is flat, a flip closes here). Never gated, so it stands whatever phase B does. A
    /// leg on the right side within THEME_DRIFT_BPS of its target is left alone. Unreadable markets are
    /// reported by phase B.
    function _themeExit(Books storage b, Env memory e, Follow storage f, Leg[] memory legs)
        internal
        returns (bool acted)
    {
        address follower = e.follower;
        bytes32 sourceId = f.sourceId;
        acted = !_allowLegs(b, follower, sourceId, legs);
        address[] storage pools = b.synced[follower];
        Policy memory p = f.policy;
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            int256 cur = _size(e.bank, follower, pool);
            if (cur == 0) continue;
            (bool ok, Market memory m) = _market(follower, sourceId, pool, false);
            if (!ok) {
                acted = true;
                continue;
            }
            (int256 target, bool capped) = _legTarget(p, _weight(legs, pool), m);
            if (_settled(cur, target, m)) continue;
            (uint256 reduceQty, bool reduceIsBid,,) = PolicyLib.split(cur, target);
            if (reduceQty == 0) continue;
            (uint256 price, int256 mid) = _reduce(e, f, pool, m, cur, reduceQty, reduceIsBid);
            if (price != 0) acted = true;
            if (mid != cur) emit Copied(follower, sourceId, pool, cur, mid, price, capped);
        }
    }

    /// @dev Phase B: every increase the basket needs, as one set behind the theme-level gates, filled
    /// all-or-nothing by applyIncreases. A leg left out by the MAX_JOIN_POOLS bound, whose market cannot be
    /// read, whose flip did not close (beyond dust its increase crosses), or that is too small to open holds
    /// the whole set back. When every leg ends at target, `version` is recorded as synced. Reports an equity
    /// stop, never acts on it.
    function _themeEntry(Books storage b, Env memory e, Follow storage f, Leg[] memory legs, uint32 version)
        internal
        returns (bool acted, bool stopped, int256 equity)
    {
        address follower = e.follower;
        bytes32 sourceId = f.sourceId;
        bool complete = _legsAllowed(b, follower, legs);
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
            s.weight = _weight(legs, s.pool);
            if (s.cur != 0) open = true;
        }
        if (!open) {
            // nothing held: a gate that already fails is reported without reading any market
            Reason early = _earlyGate(e, f);
            if (early != Reason.None) {
                emit Refused(follower, sourceId, address(0), early, "");
                f.lastSyncComplete = false;
                return (true, false, 0);
            }
        }

        Policy memory p = f.policy;
        for (uint256 i; i < n; ++i) {
            ThemePool memory s = ps[i];
            if (s.weight == 0 && s.cur == 0) continue; // a dropped leg already closed
            (s.ok, s.m) = _market(follower, sourceId, s.pool, true);
            if (!s.ok) {
                acted = true;
                if (s.weight != 0) complete = false;
                continue;
            }
            (s.target, s.capped) = _legTarget(p, s.weight, s.m);
        }

        (LegOrder[] memory orders, uint256 total, bool setOk) = _increaseSet(follower, sourceId, ps, p.bandBps);
        if (!setOk || orders.length != 0) acted = true;
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
    }

    /// @dev A leg's target: flat when it is not a current leg, else sized from the allocation and clamped.
    function _legTarget(Policy memory p, int32 weight, Market memory m) internal pure returns (int256, bool) {
        if (weight == 0) return (0, false);
        int256 raw = PolicyLib.themeTarget(p.allocation, weight, m.mark, m.oneBase);
        return PolicyLib.clampNotional(raw, m.mark, m.oneBase, p.maxNotional);
    }

    function _weight(Leg[] memory legs, address pool) internal pure returns (int32 w) {
        for (uint256 j; j < legs.length; ++j) {
            if (legs[j].pool == pool) w = legs[j].weightBps;
        }
    }

    /// @dev True when a theme sync leaves `size` alone against `target`: equal; on the same side within
    /// THEME_DRIFT_BPS of it; or, on the same side or against a flat target, a move below one lot or the
    /// venue minimum (dust the venue cannot take).
    function _settled(int256 size, int256 target, Market memory m) internal pure returns (bool) {
        if (size == target) return true;
        bool sameSide = size != 0 && target != 0 && (size > 0) == (target > 0);
        if (!sameSide && target != 0) return false;
        uint256 have = _abs(size);
        uint256 want = _abs(target);
        uint256 gap = have > want ? have - want : want - have;
        if (sameSide && gap * 1e4 < THEME_DRIFT_BPS * want) return true;
        return _tradable(gap, m) == 0;
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

    /// @dev Whether every leg is in the follow's markets (phase A added all the bound let in).
    function _legsAllowed(Books storage b, address follower, Leg[] memory legs) internal view returns (bool) {
        mapping(address => bool) storage allowed = b.allowed[follower][b.epoch[follower]];
        for (uint256 i; i < legs.length; ++i) {
            if (!allowed[legs[i].pool]) return false;
        }
        return true;
    }

    /// @dev The increases the basket needs from where phase A left it, and the notional of the whole book
    /// once they fill (an unreadable market holding a position makes it unbounded, failing a total cap
    /// closed). A flip whose close left only dust on the old side (below one lot or the venue minimum)
    /// counts as closed: its increase crosses the dust in the same order. `ok` is false when a leg cannot
    /// take its part: its flip did not close (LegFailed), or its target rounds to zero, or it is not open and
    /// its size rounds below one lot or the venue minimum (BelowMinimum). Such a leg is reported and holds
    /// the set back; a top-up of an open leg that small is skipped.
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
            if (s.weight != 0 && (s.mid == 0 || s.target == 0 || !_settled(s.mid, s.target, s.m))) {
                uint256 want = _abs(s.target);
                uint256 have = _abs(s.mid);
                bool cross = have != 0 && (s.mid > 0) != (s.target > 0);
                Reason why;
                if (want == 0) {
                    why = Reason.BelowMinimum;
                } else if (cross && _tradable(have, s.m) != 0) {
                    why = Reason.LegFailed;
                } else if (cross || want > have) {
                    // outside the band a top-up is never this small, so only an opening leg fails here
                    uint256 qty = _tradable(cross ? want + have : want - have, s.m);
                    if (qty == 0) {
                        why = Reason.BelowMinimum;
                    } else {
                        bool isBid = s.target > 0;
                        end = isBid ? s.mid + int256(qty) : s.mid - int256(qty);
                        s.incPrice = PolicyLib.bandPriceInward(s.m.mark, bandBps, isBid, s.m.tick);
                        orders[k++] = LegOrder(s.pool, isBid, s.incPrice, qty, end, s.m.lot);
                    }
                }
                if (why != Reason.None) {
                    emit Refused(follower, sourceId, s.pool, why, "");
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

    /// @dev Increase gates in order (the allowlist is enforced earlier). EquityFloor also returns the equity
    /// read for the stop; an unreadable account health refuses the increase without stopping.
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
        if (gate != address(0) && !_gateAllows(gate, f.sourceId, e.follower, e.riskGateGas)) {
            return (Reason.RiskGate, equity);
        }
        return (Reason.None, equity);
    }

    /// @dev Asks the risk gate about this source and follower on a fixed budget, reading at most one word
    /// back. Anything but a clean `true` (a revert, an answer that is not a bool, no code, a burnt budget)
    /// refuses the increase. Only when the caller cannot fund the budget does the sync abort as out of gas.
    function _gateAllows(address gate, bytes32 sourceId, address follower, uint256 budget)
        internal
        view
        returns (bool allowed)
    {
        if (gasleft() < budget * 64 / 63 + 10_000) revert OutOfGasInSync();
        bytes4 sel = IRiskGate.allowIncrease.selector;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, sel)
            mstore(add(p, 4), sourceId)
            mstore(add(p, 36), and(follower, 0xffffffffffffffffffffffffffffffffffffffff))
            let ok := staticcall(budget, gate, p, 68, p, 32)
            allowed := and(and(ok, gt(returndatasize(), 31)), eq(mload(p), 1))
        }
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

    /// @dev Pauses first, so the stop stands even if a close cannot complete, then closes every synced position.
    /// Stopped marks the transition into paused, so a repeated poke does not announce the stop again.
    function _stop(Books storage b, Env memory e, Follow storage f, int256 equity) internal returns (bool closed) {
        if (!f.paused) {
            f.paused = true;
            emit Stopped(e.follower, equity);
        }
        f.lastSyncComplete = false;
        return _flatten(b, e, f);
    }

    /// @return closed whether every synced position is zero afterwards
    function _flatten(Books storage b, Env memory e, Follow storage f) internal returns (bool closed) {
        address[] storage pools = b.synced[e.follower];
        closed = true;
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            _exitTrader(b, e, f, pool, 0);
            if (_size(e.bank, e.follower, pool) != 0) closed = false;
        }
    }

    // ---------------------------------------------------------------- venue

    /// @dev Reads mark and book parameters. A reverting or zero read skips the pool, and is reported (with
    /// the revert data) when `report` is set.
    function _market(address follower, bytes32 sourceId, address pool, bool report)
        internal
        returns (bool, Market memory m)
    {
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
            if (report) emit Refused(follower, sourceId, pool, Reason.VenueRejected, err);
            return (false, m);
        }
        return (true, m);
    }

    /// @dev Places one order. Any answer but a clean (true, id) is reported, including one that does not
    /// decode, so an order never reverts the sync it belongs to (only running out of gas does).
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
        (bool ok, bytes memory ret) = pool.call(
            abi.encodeCall(
                IPerpPool.placeOrderFor, (follower, isBid, 0, price, qty, expiry, orderType, 0, address(0), 0)
            )
        );
        Reason r = Reason.VenueRejected;
        if (!ok) {
            _revertIfStarved(ret, before);
            bytes4 sel = bytes4(ret);
            if (sel == IOC_NO_FILL || sel == FOK_NO_FILL) r = Reason.BandUnfilled;
        } else if (ret.length >= 64) {
            uint256 success = abi.decode(ret, (uint256));
            if (success == 1) return true;
            if (success == 0) (r, ret) = (Reason.BandUnfilled, "");
        }
        emit Refused(follower, sourceId, pool, r, ret);
        return false;
    }

    /// @dev Out of gas is not a venue's answer: the sync aborts. In the reactive handler the member is
    /// deferred; any other caller's transaction reverts, so its gas estimate always covers the venue calls.
    function _revertIfStarved(bytes memory err, uint256 before) internal view {
        if (starved(err, before, type(uint256).max)) revert OutOfGasInSync();
    }

    /// @dev `qty` in whole lots, or 0 when that is below the venue minimum: what one order can trade of it.
    function _tradable(uint256 qty, Market memory m) internal pure returns (uint256) {
        qty = PolicyLib.toLots(qty, m.lot);
        return qty < m.minQty ? 0 : qty;
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

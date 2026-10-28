// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {MockMarginBank} from "../mocks/MockMarginBank.sol";
import {MockPerpPool} from "../mocks/MockPerpPool.sol";
import {MockReactivity} from "../mocks/MockReactivity.sol";
import {CopybookHub} from "../../src/CopybookHub.sol";
import {ThemeRegistry} from "../../src/ThemeRegistry.sol";
import {Leg, Policy, Reason, SourceKind} from "../../src/Types.sol";
import {IMarginBank, IRiskGate} from "../../src/interfaces/IDreamPerps.sol";

/// A risk gate that allows, denies, burns its whole budget, or answers something that is not a bool.
contract SwitchableGate is IRiskGate {
    uint8 public mode; // 0 allow, 1 deny, 2 burn, 3 garbage

    function set(uint8 mode_) external {
        mode = mode_;
    }

    function allowIncrease(bytes32, address) external view returns (bool) {
        uint8 m = mode;
        if (m == 2) {
            uint256 x;
            while (true) {
                x = uint256(keccak256(abi.encode(x)));
            }
        }
        if (m == 3) {
            assembly {
                mstore(0, 7)
                return(0, 32)
            }
        }
        return m == 0;
    }
}

/// Drives the hub the way followers, sources, keepers, the venue and the owner can, and checks every log of
/// every hub-driven step against what the follow allows: increases inside the band, nothing for a stopped
/// follower, nothing outside the allowlist. Manual trades by followers themselves are not hub actions and
/// are not scanned.
contract HubHandler is Test {
    bytes32 internal constant POSITION_UPDATED = 0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de;
    bytes32 internal constant THEME_REBALANCED = keccak256("ThemeRebalanced(uint256,uint32)");
    MockReactivity internal constant REACTIVITY = MockReactivity(address(0x0100));

    CopybookHub public immutable hub;
    ThemeRegistry public immutable themes;
    MockMarginBank public immutable bank;
    SwitchableGate public immutable gate;
    address public immutable owner;
    address public immutable creator;
    address internal constant STRANGER = address(0x5EE);

    MockPerpPool[] internal _pools;
    address[] internal _traders;
    uint256[] internal _themeIds;
    address[] internal _actors;
    bytes32[] internal _sources;
    mapping(address => bool) internal _isActor;
    mapping(address => bool) internal _isPool;
    mapping(address => uint256) internal _initMark;

    // what the current follow of each actor allows (themes: every pool that has been a leg since it began)
    mapping(address => bool) public ghostAllowAll;
    mapping(address => mapping(address => bool)) public ghostAllowed;
    mapping(address => uint16) public ghostBand;
    mapping(address => uint256) public ghostTheme;

    // per scan
    mapping(address => bool) internal _pausedNow;
    mapping(address => bool) internal _latchedNow;
    bool internal _reactive;
    mapping(address => mapping(address => bool)) internal _bombed;
    mapping(address => uint256) internal _bombs;
    mapping(address => mapping(address => int256)) internal _lastSize;

    uint256 public bandViolations;
    uint256 public pausedIncreases;
    uint256 public outsideTouches;
    uint256 public unexpectedReverts;
    bytes public lastUnexpected;

    uint256 public increasesChecked;
    uint256 public reductionsSeen;
    uint256 public stops;
    uint256 public follows;
    uint256 public fires;
    uint256 public refusals;
    uint256 public latchedOrders;
    uint256 public latchSkips;

    constructor(
        CopybookHub hub_,
        ThemeRegistry themes_,
        MockMarginBank bank_,
        SwitchableGate gate_,
        address owner_,
        address creator_,
        MockPerpPool[] memory pools_,
        address[] memory traders_,
        uint256[] memory themeIds_,
        address[] memory actors_
    ) {
        hub = hub_;
        themes = themes_;
        bank = bank_;
        gate = gate_;
        owner = owner_;
        creator = creator_;
        for (uint256 i; i < pools_.length; ++i) {
            _pools.push(pools_[i]);
            _isPool[address(pools_[i])] = true;
            _initMark[address(pools_[i])] = pools_[i].mark();
        }
        for (uint256 i; i < traders_.length; ++i) {
            _traders.push(traders_[i]);
            _sources.push(hub_.sourceIdOf(SourceKind.Trader, uint256(uint160(traders_[i]))));
        }
        for (uint256 i; i < themeIds_.length; ++i) {
            _themeIds.push(themeIds_[i]);
            _sources.push(hub_.sourceIdOf(SourceKind.Theme, themeIds_[i]));
        }
        for (uint256 i; i < actors_.length; ++i) {
            _actors.push(actors_[i]);
            _isActor[actors_[i]] = true;
        }
    }

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    function sources() external view returns (bytes32[] memory) {
        return _sources;
    }

    // ---------------------------------------------------------------- followers

    function follow(uint256 fSeed, uint256 srcSeed, uint256 mask, uint256 bandSeed, uint256 sizeSeed, uint256 riskSeed)
        external
    {
        // the first actor from the seed on that does not follow yet
        address f;
        for (uint256 i; i < _actors.length; ++i) {
            address a = _actor(fSeed % _actors.length + i);
            if (!_following(a)) {
                f = a;
                break;
            }
        }
        if (f == address(0)) return;
        Policy memory p;
        p.bandBps = uint16(bound(bandSeed, 1, 500));
        p.maxNotional = uint128(bound(sizeSeed, 10e18, 200_000e18));
        if (riskSeed % 3 == 0) p.maxTotalNotional = uint128(bound(riskSeed >> 8, 10e18, 400_000e18));
        if (riskSeed % 3 == 1) {
            p.equityFloor = uint128(bound(riskSeed >> 72, 1e18, 1_000e18));
            bank.setEquity(f, int256(bound(riskSeed >> 136, 0, 3_000e18)));
        }
        uint256 tank = bound(riskSeed >> 200, hub.MIN_TANK(), 1 ether);

        SourceKind kind;
        uint256 ref;
        address[] memory join;
        uint256 src = srcSeed % (_traders.length + _themeIds.length);
        if (src < _traders.length) {
            kind = SourceKind.Trader;
            ref = uint256(uint160(_traders[src]));
            p.scaleBps = uint32(bound(sizeSeed >> 128, 100, 30_000));
            join = _subset(mask);
        } else {
            kind = SourceKind.Theme;
            ref = _themeIds[src - _traders.length];
            p.allocation = uint128(bound(sizeSeed >> 128, 10e18, 50_000e18));
        }

        // the follow syncs inside the call, so its allowlist is in place first
        _setGhost(f, kind, ref, join, p.bandBps);
        vm.deal(f, f.balance + tank);
        _begin();
        vm.prank(f);
        try hub.follow{value: tank}(kind, ref, p, join) {
            ++follows;
            _scan();
        } catch (bytes memory err) {
            _discard();
            _expectOr(f, err, CopybookHub.FollowsPaused.selector);
            _clearGhost(f);
        }
    }

    function unfollow(uint256 fSeed, bool flatten) external {
        address f = _actor(fSeed);
        if (!_following(f)) return;
        _begin();
        vm.prank(f);
        bool left;
        try hub.unfollow(flatten) {
            left = true;
            _scan();
        } catch (bytes memory err) {
            _discard();
            _expectOr(f, err, 0);
        }
        if (left) _clearGhost(f);
    }

    function updateBand(uint256 fSeed, uint256 bandSeed) external {
        address f = _actor(fSeed);
        if (!_following(f)) return;
        (,,, Policy memory p,,) = hub.followOf(f);
        p.bandBps = uint16(bound(bandSeed, 1, 500));
        vm.prank(f);
        hub.updatePolicy(p);
        ghostBand[f] = p.bandBps;
    }

    function fundTank(uint256 fSeed, uint256 amount) external {
        address f = _actor(fSeed);
        amount = bound(amount, 0, 1 ether);
        vm.deal(f, f.balance + amount);
        vm.prank(f);
        hub.fundTank{value: amount}();
    }

    function withdrawTank(uint256 fSeed, uint256 amount) external {
        address f = _actor(fSeed);
        uint256 tank = hub.tankOf(f);
        uint256 max = tank;
        if (_following(f)) {
            if (tank < hub.MIN_TANK()) return;
            max = tank - hub.MIN_TANK();
        }
        vm.prank(f);
        hub.withdrawTank(bound(amount, 0, max));
    }

    function resume(uint256 fSeed) external {
        address f = _actor(fSeed);
        if (!_following(f)) return;
        vm.prank(f);
        try hub.resume() {}
        catch (bytes memory err) {
            if (_sel(err) != CopybookHub.FlattenPending.selector) _expect(err, CopybookHub.StillBelowFloor.selector);
        }
    }

    /// Equity drops below a follower's floor, a keeper stops it, then equity recovers while the follow
    /// stays paused: nothing may increase it until it resumes.
    function crash(uint256 fSeed) external {
        address f = _actor(fSeed);
        (bytes32 sid,,, Policy memory p,,) = hub.followOf(f);
        if (sid == 0 || p.equityFloor == 0) return;
        bank.setEquity(f, int256(uint256(p.equityFloor)) - 1);
        _begin();
        vm.prank(STRANGER);
        try hub.poke(f) {
            _scan();
        } catch (bytes memory err) {
            _discard();
            _expectOr(f, err, 0);
        }
        bank.setEquity(f, int256(uint256(p.equityFloor)) * 2);
    }

    function setEquity(uint256 fSeed, uint256 equity) external {
        bank.setEquity(_actor(fSeed), int256(bound(equity, 0, 3_000e18)));
    }

    /// The follower trades by hand (an approved operator of its own): not a hub action, not scanned.
    function manualTrade(uint256 fSeed, uint256 pSeed, uint256 sizeSeed) external {
        MockPerpPool pool = _pool(pSeed);
        address f = _actor(fSeed);
        if (_bombed[f][address(pool)]) return;
        _force(pool, f, _size(pool, sizeSeed));
    }

    /// Makes every order for a follower on one market burn all the gas it gets (a venue order heavier than any
    /// budget), or stops it. The handler latches what it cannot finish; non-reactive calls revert out of gas.
    function bomb(uint256 fSeed, uint256 pSeed, bool on) external {
        MockPerpPool pool = _pool(pSeed);
        address f = _actor(fSeed);
        if (_bombed[f][address(pool)] == on) return;
        _bombed[f][address(pool)] = on;
        if (on) ++_bombs[f];
        else --_bombs[f];
        pool.setBombFor(f, on);
    }

    // ---------------------------------------------------------------- keepers

    function catchUp(uint256 fSeed, uint256 mask) external {
        address f = _actor(fSeed);
        if (!_following(f)) return;
        address[] memory pools = _subset(mask);
        _begin();
        vm.prank(STRANGER);
        try hub.catchUp(f, pools) {
            _scan();
        } catch (bytes memory err) {
            _discard();
            _expectOr(f, err, 0);
        }
    }

    function poke(uint256 fSeed) external {
        address f = _actor(fSeed);
        if (!_following(f)) return;
        _begin();
        vm.prank(STRANGER);
        try hub.poke(f) {
            _scan();
        } catch (bytes memory err) {
            _discard();
            _expectOr(f, err, 0);
        }
    }

    // ---------------------------------------------------------------- sources and venue

    /// A trader moves; every subscribed group of its source gets the venue's event.
    function traderMove(uint256 tSeed, uint256 pSeed, uint256 sizeSeed, uint256 gasSeed) public {
        address t = _traders[tSeed % _traders.length];
        MockPerpPool pool = _pool(pSeed);
        _force(pool, t, _size(pool, sizeSeed));
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = POSITION_UPDATED;
        topics[1] = bytes32(uint256(uint160(t)));
        topics[2] = bytes32(uint256(uint160(address(pool))));
        _reactive = true;
        _begin();
        _fireAll(hub.sourceIdOf(SourceKind.Trader, uint256(uint160(t))), address(bank), topics, gasSeed);
        _scan();
        _reactive = false;
    }

    /// The creator rebalances a theme; every subscribed group of it gets the registry's event.
    function rebalance(uint256 thSeed, uint256 legSeed, uint256 gasSeed) public {
        uint256 id = _themeIds[thSeed % _themeIds.length];
        Leg[] memory legs = _legs(legSeed);
        vm.warp(block.timestamp + themes.MIN_REBALANCE_INTERVAL());
        vm.prank(creator);
        try themes.rebalance(id, legs) {}
        catch (bytes memory err) {
            _expect(err, ThemeRegistry.NoChange.selector);
            return;
        }
        for (uint256 i; i < _actors.length; ++i) {
            address a = _actors[i];
            if (ghostTheme[a] != id) continue;
            for (uint256 j; j < legs.length; ++j) {
                ghostAllowed[a][legs[j].pool] = true;
            }
        }
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = THEME_REBALANCED;
        topics[1] = bytes32(id);
        _reactive = true;
        _begin();
        _fireAll(hub.sourceIdOf(SourceKind.Theme, id), address(themes), topics, gasSeed);
        _scan();
        _reactive = false;
    }

    /// Orders on one market get heavier than any budget while a trader moves or a theme rebalances, then
    /// recover: members with exits there latch, and must get nothing from the handler until a caller
    /// finishes their work.
    function heavyEvent(uint256 pSeed, uint256 srcSeed, uint256 sizeSeed, uint256 gasSeed) external {
        MockPerpPool pool = _pool(pSeed);
        _heavy(pool, true);
        if (srcSeed % 2 == 0) traderMove(srcSeed >> 1, pSeed, sizeSeed, gasSeed);
        else rebalance(srcSeed >> 1, sizeSeed, gasSeed);
        _heavy(pool, false);
    }

    function _heavy(MockPerpPool pool, bool on) internal {
        for (uint256 i; i < _actors.length; ++i) {
            address a = _actors[i];
            if (!_bombed[a][address(pool)]) pool.setBombFor(a, on);
        }
    }

    function setMark(uint256 pSeed, uint256 moveSeed) external {
        MockPerpPool pool = _pool(pSeed);
        uint256 m = pool.mark() * bound(moveSeed, 9_000, 11_000) / 10_000;
        uint256 base = _initMark[address(pool)];
        pool.setMark(bound(m, base / 2, base * 2));
    }

    /// Depth in either direction (whole lots, as a venue fills) and the level it fills at, up to 7% from
    /// mark: beyond every band.
    function setLiquidity(uint256 pSeed, uint256 bidSeed, uint256 askSeed, uint256 edgeSeed) external {
        MockPerpPool pool = _pool(pSeed);
        uint256 max = 20 * pool.oneBase();
        uint256 lot = pool.lot();
        pool.setLiquidity(
            bound(bidSeed, 0, max) / lot * lot, bound(askSeed, 0, max) / lot * lot, bound(edgeSeed, 0, 700)
        );
    }

    // ---------------------------------------------------------------- owner

    /// The gate off, allowing, denying, burning its budget, answering garbage, or losing its code (as an
    /// account without code would answer): increases may be refused, nothing else changes.
    function ownerRiskGate(uint256 mode) external {
        mode %= 6;
        address g = address(gate);
        if (mode == 5) g = address(new SwitchableGate());
        else if (mode != 0) gate.set(uint8(mode - 1));
        vm.prank(owner);
        hub.setRiskGate(mode == 0 ? address(0) : g);
        if (mode == 5) vm.etch(g, "");
    }

    function ownerPause(bool paused) external {
        vm.prank(owner);
        hub.pauseNewFollows(paused);
    }

    /// Any amount up to everything above the subscription reserve: the tanks must stay covered.
    function ownerWithdraw(uint256 amount) external {
        uint256 balance = address(hub).balance;
        uint256 reserve = hub.MIN_SUBSCRIPTION_BALANCE();
        if (balance <= reserve) return;
        vm.prank(owner);
        try hub.withdrawSurplus(owner, bound(amount, 0, balance - reserve)) {}
        catch (bytes memory err) {
            _expect(err, CopybookHub.InsufficientSurplus.selector);
        }
    }

    function ownerGasParams(uint256 seed) external {
        uint64 floor = uint64(bound(seed, 1_000_000, 8_000_000));
        uint64 cap = uint64(bound(seed >> 64, floor, 40_000_000));
        uint64 themeCap = uint64(bound(seed >> 128, floor, 150_000_000));
        uint64 overhead = uint64(bound(seed >> 192, 20_000, 2_000_000));
        uint64 gateGas = uint64(bound(uint256(keccak256(abi.encode(seed))), 200_000, 5_000_000));
        vm.prank(owner);
        hub.setGasParams(floor, cap, themeCap, 1_200_000, 30_000, overhead, gateGas);
    }

    function ownerResubscribe(uint256 sSeed, uint256 gSeed) external {
        bytes32 sid = _sources[sSeed % _sources.length];
        uint32 n = hub.groupCount(sid);
        if (n == 0) return;
        uint32 g = uint32(gSeed % n);
        if (hub.membersOf(sid, g).length == 0) return;
        vm.prank(owner);
        hub.forceResubscribe(sid, g);
    }

    // ---------------------------------------------------------------- scanning

    function _begin() internal {
        for (uint256 i; i < _actors.length; ++i) {
            address a = _actors[i];
            (,,,, bool paused,) = hub.followOf(a);
            _pausedNow[a] = paused;
            (bool exitPending, bool flattenPending) = hub.pendingOf(a);
            _latchedNow[a] = exitPending || flattenPending;
            if (_reactive && _latchedNow[a]) ++latchSkips;
        }
        vm.recordLogs();
    }

    function _scan() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 k; k < logs.length; ++k) {
            Vm.Log memory l = logs[k];
            if (l.topics.length == 0) continue;
            bytes32 t0 = l.topics[0];
            if (l.emitter == address(bank) && t0 == POSITION_UPDATED) {
                (int128 next,,,) = abi.decode(l.data, (int128, uint128, int256, int256));
                _lastSize[_addr(l.topics[1])][_addr(l.topics[2])] = next;
            } else if (_isPool[l.emitter] && t0 == MockPerpPool.MockFill.selector) {
                (address o, bool isBid, uint256 qty, uint256 level) =
                    abi.decode(l.data, (address, bool, uint256, uint256));
                if (_isActor[o]) {
                    _checkLatch(o);
                    _checkFill(o, MockPerpPool(l.emitter), isBid, qty, level);
                }
            } else if (l.emitter == address(hub)) {
                if (t0 == CopybookHub.Stopped.selector) {
                    _pausedNow[_addr(l.topics[1])] = true;
                    ++stops;
                } else if (t0 == CopybookHub.Copied.selector) {
                    _checkLatch(_addr(l.topics[1]));
                    _checkAllowed(_addr(l.topics[1]), _addr(l.topics[3]));
                } else if (t0 == CopybookHub.Refused.selector) {
                    ++refusals;
                    (Reason r,) = abi.decode(l.data, (Reason, bytes));
                    address pool = _addr(l.topics[3]);
                    if (pool != address(0) && r != Reason.MarketNotAllowed) _checkAllowed(_addr(l.topics[1]), pool);
                }
            }
        }
    }

    function _checkFill(address o, MockPerpPool pool, bool isBid, uint256 qty, uint256 level) internal {
        _checkAllowed(o, address(pool));
        int256 next = _lastSize[o][address(pool)];
        int256 prev = isBid ? next - int256(qty) : next + int256(qty);
        bool increase = next != 0 && (prev == 0 || (prev > 0) != (next > 0) || _abs(next) > _abs(prev));
        if (!increase) {
            ++reductionsSeen;
            return;
        }
        ++increasesChecked;
        if (_pausedNow[o]) ++pausedIncreases;
        // exactly inside mark * (1e4 +- band) / 1e4, compared without rounding
        uint256 mark = pool.mark();
        uint256 band = ghostBand[o];
        if (isBid ? level * 1e4 > mark * (1e4 + band) : level * 1e4 < mark * (1e4 - band)) ++bandViolations;
    }

    /// A follow latched when the event came in gets nothing from the handler.
    function _checkLatch(address f) internal {
        if (_reactive && _latchedNow[f]) ++latchedOrders;
    }

    function _checkAllowed(address f, address pool) internal {
        if (!ghostAllowAll[f] && !ghostAllowed[f][pool]) ++outsideTouches;
    }

    // ---------------------------------------------------------------- helpers

    /// Delivers the event to every subscribed group, each with a handler gas limit between 5M and 200M, through
    /// the hub's own subscription (the hub is the transaction origin).
    function _fireAll(bytes32 sid, address emitter, bytes32[] memory topics, uint256 gasSeed) internal {
        uint32 n = hub.groupCount(sid);
        for (uint32 g; g < n; ++g) {
            if (!hub.subscribed(sid, g)) continue;
            ++fires;
            uint256 id = hub.subscriptionOf(sid, g);
            uint256 gas = bound(uint256(keccak256(abi.encode(gasSeed, g))), 5_000_000, 200_000_000);
            vm.prank(address(this), address(hub));
            try REACTIVITY.fire{gas: gas}(id, emitter, topics, "") {}
            catch (bytes memory err) {
                _unexpected(err);
            }
        }
    }

    function _setGhost(address f, SourceKind kind, uint256 ref, address[] memory join, uint16 band) internal {
        _clearGhost(f);
        ghostBand[f] = band;
        if (kind == SourceKind.Theme) {
            ghostTheme[f] = ref;
            Leg[] memory legs = themes.legsOf(ref);
            for (uint256 j; j < legs.length; ++j) {
                ghostAllowed[f][legs[j].pool] = true;
            }
        } else if (join.length == 0) {
            ghostAllowAll[f] = true;
        } else {
            for (uint256 j; j < join.length; ++j) {
                ghostAllowed[f][join[j]] = true;
            }
        }
    }

    function _clearGhost(address f) internal {
        ghostAllowAll[f] = false;
        ghostTheme[f] = 0;
        ghostBand[f] = 0;
        for (uint256 i; i < _pools.length; ++i) {
            ghostAllowed[f][address(_pools[i])] = false;
        }
    }

    /// Moves `account` to `target` with deep liquidity at mark, then puts the book back as it was.
    function _force(MockPerpPool pool, address account, int256 target) internal {
        int256 d = target - bank.getPosition(account, address(pool)).size;
        if (d == 0 || _abs(d) < pool.minQty()) return;
        (uint256 bid, uint256 ask, uint256 edge) = (pool.bidDepth(), pool.askDepth(), pool.edgeBps());
        pool.setLiquidity(type(uint128).max, type(uint128).max, 0);
        bool isBid = d > 0;
        uint256 price = isBid ? pool.mark() * 2 / pool.tick() * pool.tick() : pool.tick();
        pool.placeOrderFor(account, isBid, 0, price, _abs(d), type(uint64).max, 2, 0, address(0), 0);
        pool.setLiquidity(bid, ask, edge);
    }

    /// A size of up to 2 whole units either way, in hundredths of a unit (a multiple of every pool's lot).
    function _size(MockPerpPool pool, uint256 seed) internal view returns (int256) {
        return (int256(bound(seed, 0, 400)) - 200) * int256(pool.oneBase() / 100);
    }

    /// One to three distinct legs, each at least the registry's minimum weight either way.
    function _legs(uint256 seed) internal view returns (Leg[] memory legs) {
        uint256 n = 1 + seed % 3;
        legs = new Leg[](n);
        uint256 first = (seed >> 8) % 3;
        for (uint256 i; i < n; ++i) {
            uint256 w = bound(seed >> (16 + 24 * i), 500, 10_000);
            bool short = (seed >> (100 + i)) & 1 == 1;
            legs[i] = Leg(address(_pools[(first + i) % 3]), short ? -int32(int256(w)) : int32(int256(w)));
        }
    }

    function _subset(uint256 mask) internal view returns (address[] memory out) {
        uint256 n;
        for (uint256 i; i < _pools.length; ++i) {
            if ((mask >> i) & 1 == 1) ++n;
        }
        out = new address[](n);
        n = 0;
        for (uint256 i; i < _pools.length; ++i) {
            if ((mask >> i) & 1 == 1) out[n++] = address(_pools[i]);
        }
    }

    function _following(address f) internal view returns (bool) {
        (bytes32 s,,,,,) = hub.followOf(f);
        return s != 0;
    }

    function _expect(bytes memory err, bytes4 sel) internal {
        if (_sel(err) != sel) _unexpected(err);
    }

    /// `sel` (when set), or out of gas for a follower with a bombed market: a non-reactive call reverts then.
    function _expectOr(address f, bytes memory err, bytes4 sel) internal {
        bytes4 got = _sel(err);
        if (_bombs[f] != 0 && got == CopybookHub.OutOfGasInSync.selector) return;
        if (sel != 0 && got == sel) return;
        _unexpected(err);
    }

    /// Logs of a hub call that reverted (recordLogs keeps them) describe nothing that happened.
    function _discard() internal {
        vm.getRecordedLogs();
    }

    function _sel(bytes memory err) internal pure returns (bytes4) {
        return err.length < 4 ? bytes4(0) : bytes4(err);
    }

    function _unexpected(bytes memory err) internal {
        ++unexpectedReverts;
        lastUnexpected = err;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    function _pool(uint256 seed) internal view returns (MockPerpPool) {
        return _pools[seed % _pools.length];
    }

    function _addr(bytes32 t) internal pure returns (address) {
        return address(uint160(uint256(t)));
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }
}

contract HubInvariantTest is Test {
    MockMarginBank internal bank;
    CopybookHub internal hub;
    ThemeRegistry internal themes;
    HubHandler internal handler;

    address internal constant OWNER = address(0x0A11);
    address internal constant CREATOR = address(0xC4EA);

    function setUp() public {
        vm.etch(address(0x0100), address(new MockReactivity()).code);
        bank = new MockMarginBank();
        MockPerpPool[] memory pools = new MockPerpPool[](3);
        pools[0] = new MockPerpPool(bank, 80_000e18, 1e17, 13_000, 1_000, 1e8);
        pools[1] = new MockPerpPool(bank, 2_300e18, 1e16, 4e15, 1e14, 1e18);
        pools[2] = new MockPerpPool(bank, 150e18, 1e15, 1e17, 1e16, 1e18);
        for (uint256 i; i < 3; ++i) {
            bank.registerPool(address(pools[i]));
            pools[i].setLiquidity(10 * pools[i].oneBase(), 10 * pools[i].oneBase(), 10);
        }
        themes = new ThemeRegistry(address(bank));
        // trader groups of 2, so sources spread over several groups and subscriptions
        hub = new CopybookHub(IMarginBank(address(bank)), themes, 2, OWNER);
        vm.deal(address(hub), 100 ether);
        SwitchableGate gate = new SwitchableGate();

        uint256[] memory themeIds = new uint256[](2);
        Leg[] memory legs = new Leg[](2);
        legs[0] = Leg(address(pools[0]), 5_000);
        legs[1] = Leg(address(pools[1]), -5_000);
        vm.prank(CREATOR);
        themeIds[0] = themes.createTheme("pair", "", legs);
        legs[0] = Leg(address(pools[2]), 4_000);
        legs[1] = Leg(address(pools[0]), 3_000);
        vm.prank(CREATOR);
        themeIds[1] = themes.createTheme("long", "", legs);

        address[] memory traders = new address[](2);
        traders[0] = address(0x7AD1);
        traders[1] = address(0x7AD2);
        address[] memory actors = new address[](6);
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = address(uint160(0xF001 + i));
        }

        handler = new HubHandler(hub, themes, bank, gate, OWNER, CREATOR, pools, traders, themeIds, actors);
        for (uint256 p; p < 3; ++p) {
            for (uint256 i; i < actors.length; ++i) {
                pools[p].approve(actors[i], address(hub));
                pools[p].approve(actors[i], address(handler));
            }
            for (uint256 i; i < traders.length; ++i) {
                pools[p].approve(traders[i], address(handler));
            }
        }
        // every run starts with live follows: trader on all markets, trader on BTC+ETH, and both themes
        handler.follow(0, 0, 0, 50, (10_000 << 128) | 50_000e18, 2);
        handler.follow(1, 1, 3, 100, (15_000 << 128) | 50_000e18, 2);
        handler.follow(2, 2, 0, 200, (1_000e18 << 128) | 50_000e18, 2);
        handler.follow(3, 3, 0, 300, (2_000e18 << 128) | 50_000e18, 2);
        targetContract(address(handler));
    }

    /// Every increase fill is within mark * (1e4 +- band) / 1e4 of the follower's band, exactly.
    function invariant_increaseWithinBand() public view {
        assertEq(handler.bandViolations(), 0);
    }

    /// The hub always holds every tank (and the subscription reserve on top), and totalTanks is their sum.
    function invariant_tanksSolvent() public view {
        address[] memory a = handler.actors();
        uint256 sum;
        for (uint256 i; i < a.length; ++i) {
            sum += hub.tankOf(a[i]);
        }
        assertEq(hub.totalTanks(), sum);
        assertGe(address(hub).balance, hub.totalTanks());
        assertGe(address(hub).balance, hub.MIN_SUBSCRIPTION_BALANCE() + hub.totalTanks());
    }

    /// A stopped follower gets no increase, until it resumes.
    function invariant_noIncreaseWhenPaused() public view {
        assertEq(handler.pausedIncreases(), 0);
    }

    /// Group membership is a partition of the active follows: each active follower sits exactly at its seat,
    /// every member follows that source, and a group is subscribed exactly while it has members.
    function invariant_followerCountMatchesGroups() public view {
        bytes32[] memory sids = handler.sources();
        uint256 seated;
        for (uint256 s; s < sids.length; ++s) {
            uint32 n = hub.groupCount(sids[s]);
            for (uint32 g; g < n; ++g) {
                address[] memory m = hub.membersOf(sids[s], g);
                seated += m.length;
                assertEq(hub.subscribed(sids[s], g), m.length != 0, "subscribed iff members");
                for (uint256 j; j < m.length; ++j) {
                    (bytes32 sid,,,,,) = hub.followOf(m[j]);
                    assertEq(sid, sids[s], "member follows the source");
                    (uint32 gg, uint32 ii) = hub.seatOf(m[j]);
                    assertEq(gg, g);
                    assertEq(ii, j);
                }
            }
        }
        address[] memory a = handler.actors();
        uint256 active;
        for (uint256 i; i < a.length; ++i) {
            (bytes32 sid,,,,,) = hub.followOf(a[i]);
            if (sid == 0) continue;
            ++active;
            (uint32 g, uint32 idx) = hub.seatOf(a[i]);
            assertEq(hub.membersOf(sid, g)[idx], a[i]);
        }
        assertEq(seated, active);
    }

    /// The hub never orders, copies or refuses on a pool outside the follow's allowlist (R10/R14).
    function invariant_noTouchOutsideAllowlist() public view {
        assertEq(handler.outsideTouches(), 0);
    }

    /// A follow whose exits or stop closes are latched gets no order or copy from the handler (R35).
    function invariant_latchedNeverTradedReactively() public view {
        assertEq(handler.latchedOrders(), 0);
    }

    /// Hub calls that must not fail (catchUp, poke, unfollow, the handler under fire) never revert, and the
    /// ones that may fail do so only with their documented error.
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0, string(handler.lastUnexpected()));
    }

    /// Totals over every run so far (kept in the test process's environment), so a run with -vv shows
    /// how much the invariants actually checked.
    function afterInvariant() external {
        uint256 runs = _add("HUB_INV_RUNS", 1);
        uint256 f = _add("HUB_INV_FOLLOWS", handler.follows());
        uint256 fi = _add("HUB_INV_FIRES", handler.fires());
        uint256 inc = _add("HUB_INV_INCREASES", handler.increasesChecked());
        uint256 red = _add("HUB_INV_REDUCTIONS", handler.reductionsSeen());
        uint256 st = _add("HUB_INV_STOPS", handler.stops());
        uint256 rf = _add("HUB_INV_REFUSALS", handler.refusals());
        console.log("runs %d follows %d fires %d", runs, f, fi);
        console.log("increase fills checked %d reduction fills %d", inc, red);
        console.log("stops %d refusals %d", st, rf);
        console.log("latched follows at a delivery %d", _add("HUB_INV_LATCHED", handler.latchSkips()));
    }

    function _add(string memory key, uint256 v) internal returns (uint256 total) {
        total = vm.envOr(key, uint256(0)) + v;
        vm.setEnv(key, vm.toString(total));
    }
}

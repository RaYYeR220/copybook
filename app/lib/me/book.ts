import type { Address } from "viem";
import { MIN_TANK_FOR_INCREASE, THEME_DRIFT_BPS, notionalOf, scaledSize, simulateLeg, tradableQty, type Leg, type Market, type Policy, type ReasonName } from "@copybook/sdk";

/**
 * Your book against the source's, market by market, from the chain: the margin bank's positions, each pool's mark
 * and order parameters, and the follow's policy. "In step" is the hub's own rule: a market is in step when the
 * next sync would send no order there (what is left is below one lot or the venue minimum, or, for a thesis leg,
 * within the drift the hub leaves alone).
 */

export interface PositionRead {
  size: bigint;
  avgEntryPrice: bigint;
}

export interface PoolRead {
  pool: Address;
  /** null when the pool's mark or order parameters could not be read (or read zero). */
  market: Market | null;
  /** null when the margin bank did not answer for this pool. */
  yours: PositionRead | null;
  /** Trader follows: the trader's position. */
  theirs?: PositionRead | null;
}

export type RowState = "in-step" | "out" | "flat" | "unknown";

export interface BookRow {
  pool: Address;
  /** Trader follows: the trader's size. */
  theirs?: bigint;
  theirsEntry?: bigint;
  /** Thesis follows: the leg's weight (0 for a market that is no longer a leg). */
  weightBps?: number;
  /** The size the hub aims for now: theirs × scale (trader) or the leg's target (thesis), clamped by the cap. */
  target: bigint | null;
  /** The cap per position clamps the target. */
  capped: boolean;
  yours: bigint | null;
  yoursEntry?: bigint;
  state: RowState;
  /** Why a market is out of step, when the chain says why. */
  why?: { kind: "refused"; reason: ReasonName; block: bigint } | { kind: "drift"; bps: number } | { kind: "not-copied" };
  /** Your unrealized PnL at the mark (18-decimal USD), before funding and fees. */
  pnl?: bigint;
  /** Trader follows: the trader's unrealized PnL at the mark, times your scale. */
  theirsPnlScaled?: bigint;
  /** Trader follows: what the next sync of this market would send, half by half, and the market's numbers it needs. */
  moves?: { reduce: boolean; increase: boolean; yoursNotional: bigint; afterIncreaseNotional: bigint };
  /** Trader follows, set by `gateIncreases`: the gate that would refuse this market's increase right now. */
  gate?: ReasonName;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
const sameSide = (a: bigint, b: bigint) => a !== 0n && b !== 0n && a > 0n === b > 0n;

/** Size × (mark − entry) / oneBase: what closing at the mark would realize, before funding and fees. */
export function unrealized(p: PositionRead, m: Pick<Market, "mark" | "oneBase">): bigint {
  if (p.size === 0n || p.avgEntryPrice === 0n) return 0n;
  return (p.size * (m.mark - p.avgEntryPrice)) / m.oneBase;
}

/** `PolicyLib.split`: what reducing toward `target` and what increasing toward it would trade from `current`. */
export function split(current: bigint, target: bigint): { reduce: bigint; increase: bigint } {
  if (current >= 0n) {
    if (target >= current) return { reduce: 0n, increase: target - current };
    if (target >= 0n) return { reduce: current - target, increase: 0n };
    return { reduce: current, increase: -target };
  }
  if (target <= current) return { reduce: 0n, increase: current - target };
  if (target <= 0n) return { reduce: target - current, increase: 0n };
  return { reduce: -current, increase: target };
}

/** The cap per position on a target, like `PolicyLib.clampNotional`. */
export function clampToCap(target: bigint, m: Pick<Market, "mark" | "oneBase">, maxNotional: bigint): { size: bigint; capped: boolean } {
  if ((abs(target) * m.mark) / m.oneBase <= maxNotional) return { size: target, capped: false };
  const q = (maxNotional * m.oneBase) / m.mark;
  return { size: target < 0n ? -q : q, capped: true };
}

/**
 * A trader follow's market is in step when neither half of a sync would send an order: the exit half reduces
 * toward theirs × scale, the increase half grows toward that clamped by the cap, and neither leaves a tradable
 * quantity (whole lots at or above the venue minimum).
 */
export function traderInStep(yours: bigint, scaled: bigint, clamped: bigint, m: Pick<Market, "lot" | "minQty">): boolean {
  const exit = split(yours, scaled).reduce;
  const entry = split(yours, clamped).increase;
  return tradableQty(exit, m) === 0n && tradableQty(entry, m) === 0n;
}

/**
 * What a sync of one trader market would send: the exit half reduces toward theirs × scale (never gated), the
 * increase half grows toward the clamped target in whole orders (gated). Mirrors CopyEngine's increase sizing, so
 * the notional after the increase is the one the total-cap gate checks.
 */
export function traderMoves(yours: bigint, scaled: bigint, clamped: bigint, m: Pick<Market, "lot" | "minQty" | "mark" | "oneBase">) {
  const reduce = tradableQty(split(yours, scaled).reduce, m) > 0n;
  const have = abs(yours);
  const want = abs(clamped);
  const cross = yours !== 0n && clamped !== 0n && yours > 0n !== clamped > 0n;
  const qty = cross ? tradableQty(want + have, m) : want > have ? tradableQty(want - have, m) : 0n;
  const after = cross ? (qty > have ? qty - have : 0n) : have + qty;
  return { reduce, increase: qty > 0n, yoursNotional: notionalOf(yours, m), afterIncreaseNotional: notionalOf(after, m) };
}

/** `CopyEngine._settled`: a thesis leg the hub leaves alone. */
export function legSettled(size: bigint, target: bigint, m: Pick<Market, "lot" | "minQty">): boolean {
  if (size === target) return true;
  const same = sameSide(size, target);
  if (!same && target !== 0n) return false;
  const have = abs(size);
  const want = abs(target);
  const gap = have > want ? have - want : want - have;
  if (same && gap * 10_000n < BigInt(THEME_DRIFT_BPS) * want) return true;
  return tradableQty(gap, m) === 0n;
}

export type LastRefusals = Record<string, { reason: ReasonName; block: bigint }>;

const outWhy = (pool: Address, refusals: LastRefusals): BookRow["why"] => {
  const r = refusals[pool.toLowerCase()];
  return r ? { kind: "refused", reason: r.reason, block: r.block } : { kind: "not-copied" };
};

export function traderBook(policy: Pick<Policy, "scaleBps" | "maxNotional">, pools: readonly PoolRead[], refusals: LastRefusals = {}): BookRow[] {
  return pools.map((p) => {
    const theirs = p.theirs?.size;
    const base: BookRow = {
      pool: p.pool,
      ...(theirs !== undefined ? { theirs, theirsEntry: p.theirs!.avgEntryPrice } : {}),
      target: null,
      capped: false,
      yours: p.yours?.size ?? null,
      ...(p.yours ? { yoursEntry: p.yours.avgEntryPrice } : {}),
      state: "unknown",
    };
    if (!p.market || theirs === undefined || !p.yours) return base;
    const m = p.market;
    const scaled = scaledSize(theirs, policy.scaleBps);
    const { size: clamped, capped } = clampToCap(scaled, m, policy.maxNotional);
    const yours = p.yours.size;
    const pnl = unrealized(p.yours, m);
    const theirsPnlScaled = (unrealized(p.theirs!, m) * BigInt(policy.scaleBps)) / 10_000n;
    const row: BookRow = { ...base, target: clamped, capped, pnl, theirsPnlScaled, moves: traderMoves(yours, scaled, clamped, m) };
    if (scaled === 0n && yours === 0n) return { ...row, state: "flat" };
    if (traderInStep(yours, scaled, clamped, m)) return { ...row, state: "in-step" };
    return { ...row, state: "out", why: outWhy(p.pool, refusals) };
  });
}

/**
 * A thesis follow's legs, plus any market the hub still manages that is no longer a leg (its target is flat).
 * Targets are sized from the allocation at today's mark and clamped by the cap, as the hub sizes them.
 */
export function themeBook(policy: Pick<Policy, "allocation" | "maxNotional">, legs: readonly Leg[], pools: readonly PoolRead[], refusals: LastRefusals = {}): BookRow[] {
  const weight = new Map(legs.map((l) => [l.pool.toLowerCase(), l.weightBps]));
  return pools.map((p) => {
    const w = weight.get(p.pool.toLowerCase()) ?? 0;
    const base: BookRow = { pool: p.pool, weightBps: w, target: null, capped: false, yours: p.yours?.size ?? null, ...(p.yours ? { yoursEntry: p.yours.avgEntryPrice } : {}), state: "unknown" };
    if (!p.market || !p.yours) return base;
    const m = p.market;
    const sim = w === 0 ? { target: 0n, capped: false } : simulateLeg(policy.allocation, { pool: p.pool, weightBps: w }, policy.maxNotional, m);
    const yours = p.yours.size;
    const row: BookRow = { ...base, target: sim.target, capped: sim.capped, pnl: unrealized(p.yours, m) };
    if (sim.target === 0n && yours === 0n) return { ...row, state: "flat" };
    if (legSettled(yours, sim.target, m)) return { ...row, state: "in-step" };
    const r = refusals[p.pool.toLowerCase()];
    if (r) return { ...row, state: "out", why: { kind: "refused", reason: r.reason, block: r.block } };
    const want = abs(sim.target);
    const bps = want === 0n ? 10_000 : Number((abs(yours - sim.target) * 10_000n) / want);
    return { ...row, state: "out", why: { kind: "drift", bps } };
  });
}

export interface BookSummary {
  /** Rows whose state is known. */
  known: number;
  /** In step or both flat. */
  inStep: number;
  /** Sum of your unrealized PnL over rows that have one; undefined when no row could be priced. */
  pnl?: bigint;
  theirsPnlScaled?: bigint;
  /** Some rows could not be priced, so the sums leave them out. */
  partial: boolean;
}

export function bookSummary(rows: readonly BookRow[]): BookSummary {
  let pnl: bigint | undefined;
  let theirs: bigint | undefined;
  let known = 0;
  let inStep = 0;
  for (const r of rows) {
    if (r.state !== "unknown") known++;
    if (r.state === "in-step" || r.state === "flat") inStep++;
    if (r.pnl !== undefined) pnl = (pnl ?? 0n) + r.pnl;
    if (r.theirsPnlScaled !== undefined) theirs = (theirs ?? 0n) + r.theirsPnlScaled;
  }
  return { known, inStep, pnl, theirsPnlScaled: theirs, partial: known < rows.length };
}

/** What the increase gates read, as the chain holds them now (CopyEngine._gate, in its order). */
export interface GateState {
  paused: boolean;
  equityFloor: bigint;
  /** null when the margin bank did not answer: the gate then refuses. */
  equity: bigint | null;
  maxTotalNotional: bigint;
  tank: bigint;
  /** The trader's verdict is a BLOCK inside its TTL and this wallet's guard is on (RiskGate.allowIncrease). */
  blocked: boolean;
  /** The hub's synced markets for this follower: the total-cap gate sums those. */
  synced: readonly Address[];
}

/**
 * Marks each trader row whose increase a gate would refuse now, in CopyEngine._gate's order: paused, equity
 * floor, total cap (the other synced positions at mark plus this market after the increase), tank, AI guard.
 */
export function gateIncreases(rows: readonly BookRow[], g: GateState): BookRow[] {
  const synced = new Set(g.synced.map((a) => a.toLowerCase()));
  return rows.map((r) => {
    if (!r.moves?.increase) return r;
    let gate: ReasonName | undefined;
    if (g.paused) gate = "Paused";
    else if (g.equityFloor > 0n && (g.equity === null || g.equity < g.equityFloor)) gate = g.equity === null ? "VenueRejected" : "EquityFloor";
    else if (g.maxTotalNotional > 0n) {
      const others = rows.reduce((s, o) => (o.pool !== r.pool && synced.has(o.pool.toLowerCase()) && o.moves ? s + o.moves.yoursNotional : s), 0n);
      if (others + r.moves.afterIncreaseNotional > g.maxTotalNotional) gate = "TotalCap";
    }
    if (!gate && g.tank < MIN_TANK_FOR_INCREASE) gate = "TankEmpty";
    if (!gate && g.blocked) gate = "RiskGate";
    return gate ? { ...r, gate } : r;
  });
}

export interface CatchUpOffer {
  pools: Address[];
  /** Markets where catchUp only reduces (exits are never gated). */
  reducing: Address[];
  /** Markets where catchUp would grow the position, and no gate refuses it now. */
  growing: Address[];
}

/**
 * Markets a catchUp would actually move now: out of step, never tried or refused for a passing reason (band,
 * venue), and either reducing (never gated) or growing with every gate open. A market whose only move is an
 * increase a gate refuses is left out, so the dashboard never offers a call the chain would refuse.
 */
export function catchUpOffer(rows: readonly BookRow[]): CatchUpOffer {
  const passing = new Set<ReasonName>(["BandUnfilled", "VenueRejected"]);
  const out: CatchUpOffer = { pools: [], reducing: [], growing: [] };
  for (const r of rows) {
    if (r.state !== "out" || !r.moves) continue;
    if (!(r.why?.kind === "not-copied" || (r.why?.kind === "refused" && passing.has(r.why.reason)))) continue;
    const grows = r.moves.increase && !r.gate;
    if (!grows && !r.moves.reduce) continue;
    out.pools.push(r.pool);
    (grows ? out.growing : out.reducing).push(r.pool);
  }
  return out;
}

/**
 * The pools a trader follow's book covers: the hub's synced markets, plus the follow's market list, or for a
 * whole-book follow the trader's open markets. When the follow's terms are unknown (`joinPools` null), only the
 * synced markets: a held market might be outside a list, and would show out of step when it is not.
 */
export function traderPools(synced: readonly Address[], joinPools: readonly Address[] | null, held: readonly Address[]): Address[] {
  const out = new Map<string, Address>();
  const add = (a: Address) => out.has(a.toLowerCase()) || out.set(a.toLowerCase(), a);
  synced.forEach(add);
  if (joinPools === null) return [...out.values()];
  (joinPools.length > 0 ? joinPools : held).forEach(add);
  return [...out.values()];
}

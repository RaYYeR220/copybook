import { parseAbi, type Address, type PublicClient } from "viem";
import { BPS } from "./constants.ts";
import type { Leg, Market } from "./types.ts";

/** The slice of a dreamDEX perp pool the engine reads before it places an order. */
export const poolAbi = parseAbi([
  "function getMarkPrice() view returns (uint256)",
  "function getOneBase() view returns (uint256)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
]);

/** Reads a market's mark and order parameters the way the hub does (the same three pool calls). */
export async function readMarket(client: Pick<PublicClient, "readContract">, pool: Address): Promise<Market> {
  const [mark, ob, oneBase] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "getMarkPrice" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "getOneBase" }),
  ]);
  return { pool, mark, tick: ob.tickSize, minQty: ob.minQuantity, lot: ob.lotSize, oneBase };
}

/** True when the hub could trade this market: it skips a pool whose mark, tick, lot or base unit reads zero. */
export const isTradeable = (m: Market) => m.mark > 0n && m.tick > 0n && m.lot > 0n && m.oneBase > 0n;

const abs = (x: bigint) => (x < 0n ? -x : x);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Notional of a size at the mark: |size| * mark / oneBase, rounded down like the engine. */
export function notionalOf(size: bigint, m: Pick<Market, "mark" | "oneBase">): bigint {
  return (abs(size) * m.mark) / m.oneBase;
}

/** The part of `qty` an order can carry: whole lots, and none at all below the venue minimum. */
export function tradableQty(qty: bigint, m: Pick<Market, "lot" | "minQty">): bigint {
  const lots = (qty / m.lot) * m.lot;
  return lots < m.minQty ? 0n : lots;
}

/** Smallest quantity one order can carry: the venue minimum rounded up to a whole lot (at least one lot). */
export function minOrderQty(m: Pick<Market, "lot" | "minQty">): bigint {
  const floor = m.minQty > m.lot ? m.minQty : m.lot;
  return ceilDiv(floor, m.lot) * m.lot;
}

/** Signed target size of a theme leg for an allocation, magnitude rounded down. Mirrors PolicyLib.themeTarget. */
export function themeTarget(allocation: bigint, weightBps: number, m: Pick<Market, "mark" | "oneBase">): bigint {
  if (weightBps === 0) return 0n;
  const w = BigInt(Math.abs(weightBps));
  const qty = (allocation * w * m.oneBase) / (BPS * m.mark);
  return weightBps < 0 ? -qty : qty;
}

export interface LegSimulation {
  pool: Address;
  weightBps: number;
  /** Signed size the leg would target after the maxNotional clamp, before rounding to lots. */
  target: bigint;
  /** Whether the maxNotional clamp bit. */
  capped: boolean;
  /** Signed size an opening order can actually carry (0 when it rounds below one lot or the minimum). */
  tradable: bigint;
  /** False when the leg cannot open: the hub then holds the whole basket back with Refused(BelowMinimum). */
  opens: boolean;
}

/**
 * What the hub would do with one theme leg of an allocation under a maxNotional cap, from a flat book:
 * target, clamp, then whole lots above the venue minimum. Mirrors CopyEngine's opening path.
 */
export function simulateLeg(allocation: bigint, leg: Leg, maxNotional: bigint, m: Market): LegSimulation {
  const raw = themeTarget(allocation, leg.weightBps, m);
  let target = raw;
  let capped = false;
  if (notionalOf(raw, m) > maxNotional) {
    const q = (maxNotional * m.oneBase) / m.mark;
    target = raw < 0n ? -q : q;
    capped = true;
  }
  const qty = tradableQty(abs(target), m);
  return { pool: leg.pool, weightBps: leg.weightBps, target, capped, tradable: target < 0n ? -qty : qty, opens: qty > 0n };
}

export interface ThemeMinimum {
  /** Smallest allocation (18-decimal USD) at which every leg opens at today's marks, ignoring maxNotional. */
  allocation: bigint;
  /** The leg that sets it. */
  bindingPool: Address;
  /** Smallest maxNotional at which no leg is clamped below one order; any larger cap keeps every leg openable. */
  maxNotional: bigint;
  perLeg: { pool: Address; weightBps: number; minAllocation: bigint; minMaxNotional: bigint }[];
}

/**
 * The smallest allocation that opens every leg of a theme at the given markets, and the smallest per-position
 * cap that does not clamp a leg below one order. Marks move: the answer holds at these marks, so show it with
 * headroom (see `withHeadroom`).
 */
export function minThemeAllocation(legs: readonly Leg[], markets: ReadonlyMap<string, Market> | Record<string, Market>): ThemeMinimum {
  const get = (pool: Address): Market => {
    const m = markets instanceof Map ? markets.get(pool.toLowerCase()) ?? markets.get(pool) : (markets as Record<string, Market>)[pool.toLowerCase()] ?? (markets as Record<string, Market>)[pool];
    if (!m) throw new Error(`no market data for ${pool}`);
    if (!isTradeable(m)) throw new Error(`market ${pool} reports no usable mark or order parameters`);
    return m;
  };
  let allocation = 0n;
  let maxNotional = 0n;
  let bindingPool = legs[0]?.pool as Address;
  const perLeg: ThemeMinimum["perLeg"] = [];
  for (const leg of legs) {
    const m = get(leg.pool);
    const q = minOrderQty(m);
    const w = BigInt(Math.abs(leg.weightBps));
    const minAllocation = ceilDiv(q * BPS * m.mark, w * m.oneBase);
    const minMaxNotional = ceilDiv(q * m.mark, m.oneBase);
    perLeg.push({ pool: leg.pool, weightBps: leg.weightBps, minAllocation, minMaxNotional });
    if (minAllocation > allocation) {
      allocation = minAllocation;
      bindingPool = leg.pool;
    }
    if (minMaxNotional > maxNotional) maxNotional = minMaxNotional;
  }
  return { allocation, bindingPool, maxNotional, perLeg };
}

/** Adds a safety margin (bps) to an amount, rounded up: marks move between the quote and the open. */
export const withHeadroom = (amount: bigint, headroomBps = 1_000): bigint => ceilDiv(amount * (BPS + BigInt(headroomBps)), BPS);

/** A source's size times the follower's scale (bps), rounded toward zero like the engine. */
export function scaledSize(sourceSize: bigint, scaleBps: number): bigint {
  return (sourceSize * BigInt(scaleBps)) / BPS;
}

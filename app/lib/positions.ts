import { getAddress, type Address } from "viem";
import type { MarketMeta } from "./tape";

/** A `PerpPosition` row from the dreamDEX indexer, as queried. Sizes are unsigned; `isLong` carries the side. */
export interface PositionRow {
  pool: string;
  size: string;
  isLong: boolean;
  entryPriceX18: string | null;
  updatedAt: string;
  updatedAtBlock: number | null;
  market: { baseSymbol: string; baseDecimals: number; markPrice: string | null } | null;
}

export interface MarketRow {
  poolAddress: string;
  baseSymbol: string;
  baseDecimals: number;
}

export interface Position {
  pool: Address;
  /** `BTC-PERP`, or null when the indexer has no market row for the pool. */
  market: string | null;
  side: "long" | "short";
  /** Base units, unsigned. */
  size: bigint;
  decimals: number | null;
  entryPrice: bigint | null;
  markPrice: bigint | null;
  /** size × mark in quote units (18 decimals), when both are known. */
  notional: bigint | null;
  updatedAt: number;
  updatedAtBlock: number | null;
}

const big = (s: string | null | undefined): bigint | null => {
  if (s == null || s === "") return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
};

/** Open positions only, largest notional first (unknown notional last), as the indexer reported them. */
export function toPositions(rows: readonly PositionRow[]): Position[] {
  const out: Position[] = [];
  for (const r of rows) {
    const size = big(r.size);
    if (size === null || size === 0n) continue;
    const decimals = r.market ? r.market.baseDecimals : null;
    const mark = big(r.market?.markPrice);
    const entry = big(r.entryPriceX18);
    out.push({
      pool: getAddress(r.pool),
      market: r.market ? `${r.market.baseSymbol}-PERP` : null,
      side: r.isLong ? "long" : "short",
      size,
      decimals,
      entryPrice: entry && entry > 0n ? entry : null,
      markPrice: mark && mark > 0n ? mark : null,
      notional: mark && mark > 0n && decimals !== null ? (size * mark) / 10n ** BigInt(decimals) : null,
      updatedAt: Number(r.updatedAt),
      updatedAtBlock: r.updatedAtBlock,
    });
  }
  return out.sort((a, b) => (a.notional === null ? 1 : b.notional === null ? -1 : a.notional > b.notional ? -1 : a.notional < b.notional ? 1 : 0));
}

/** pool (lower-case) → symbol and decimals, for naming markets in the tape. */
export function toMarketMeta(rows: readonly MarketRow[]): Record<string, MarketMeta> {
  const out: Record<string, MarketMeta> = {};
  for (const r of rows) out[r.poolAddress.toLowerCase()] = { symbol: r.baseSymbol, decimals: r.baseDecimals };
  return out;
}

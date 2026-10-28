import { Indexer, type Address, type IndexerOptions, type LeverageRow, type LiquidationRow, type MarketRow, type PositionChangeRow } from "./indexer.ts";

export interface TraderStats {
  trader: Address;
  /** Length of the look-back window. The `30d` in field names is the default window. */
  windowDays: number;
  /** Voluntary position changes in the window (rows inside liquidation transactions excluded). */
  trades30d: number;
  /** Distinct UTC days with at least one voluntary position change. */
  activeDays30d: number;
  /** Distinct perp markets with at least one voluntary position change. */
  marketsTraded: number;
  /** Sum of realized PnL in the window, in quote units (USDso), liquidation losses included. */
  realizedPnl30d: number;
  /** Distinct liquidation transactions touching the account in the window. */
  liquidations30d: number;
  /** Largest peak-to-trough fall of cumulative realized PnL in the window, in quote units. */
  maxDrawdownAbs30d: number | null;
  /**
   * maxDrawdownAbs30d as a percentage of the peak estimated margin deployed. Null unless the trader's explicit
   * leverage settings cover at least half of the window's notional (see README).
   */
  maxDrawdownPct30d: number | null;
  /** Trade-weighted average of the trader's explicit leverage settings; null when settings cover under half of the trades. */
  avgLeverage: number | null;
  /** ISO timestamp of the account's most recent position update (all time, not just the window). */
  lastActiveAt: string | null;
  /** False when the trader has no position changes in the window (all counts are then zero, not measured). */
  hasHistory: boolean;
  /** True when the row cap cut the history short: figures cover only the most recent rows. */
  truncated: boolean;
}

export interface StatsOptions extends IndexerOptions {
  /** Look-back window in days. Default 30. */
  windowDays?: number;
  /** Clock override, unix seconds (tests, reproducible reports). */
  now?: number;
  /** Reuse one indexer client (and its market cache) across calls. */
  indexer?: Indexer;
}

export const MIN_LEVERAGE_COVERAGE = 0.5;

const DAY = 86400;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const big = (s: string | null | undefined): bigint => {
  if (s == null || s === "") return 0n;
  try {
    return BigInt(s);
  } catch {
    return BigInt(Math.trunc(Number(s)));
  }
};
const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r; // normalise -0
};
const quote = (wei: bigint) => Number(wei) / 1e18;

export interface StatsInput {
  trader: Address;
  windowDays: number;
  changes: PositionChangeRow[];
  liquidations: LiquidationRow[];
  leverage: LeverageRow[];
  markets: MarketRow[];
  lastActiveTs: number | null;
  truncated: boolean;
}

/** Pure computation over indexer rows. */
export function computeStats(input: StatsInput): TraderStats {
  const { trader, windowDays, leverage, markets } = input;
  const liqTxs = new Set(input.liquidations.map((l) => l.txHash));
  const changes = [...input.changes].sort(
    (a, b) =>
      Number(a.timestamp) - Number(b.timestamp) ||
      Number(a.blockNumber) - Number(b.blockNumber) ||
      a.logIndex - b.logIndex,
  );
  const trades = changes.filter((c) => !liqTxs.has(c.txHash));

  const tradesPerPool = new Map<string, number>();
  for (const t of trades) tradesPerPool.set(t.pool, (tradesPerPool.get(t.pool) ?? 0) + 1);

  let pnl = 0n;
  for (const c of changes) pnl += big(c.realizedPnl);

  const lastFromRows = changes.length ? Number(changes[changes.length - 1].timestamp) : null;
  const lastTs = input.lastActiveTs ?? lastFromRows;

  const dd = drawdown(changes, markets, leverage);

  return {
    trader,
    windowDays,
    trades30d: trades.length,
    activeDays30d: new Set(trades.map((t) => Math.floor(Number(t.timestamp) / DAY))).size,
    marketsTraded: tradesPerPool.size,
    realizedPnl30d: round(quote(pnl), 2),
    liquidations30d: liqTxs.size,
    maxDrawdownAbs30d: dd ? round(dd.abs, 2) : null,
    maxDrawdownPct30d: dd?.pct == null ? null : round(Math.min(100, dd.pct), 1),
    avgLeverage: avgLeverage(tradesPerPool, leverage),
    lastActiveAt: lastTs == null ? null : new Date(lastTs * 1000).toISOString(),
    hasHistory: changes.length > 0,
    truncated: input.truncated,
  };
}

function avgLeverage(tradesPerPool: Map<string, number>, leverage: LeverageRow[]): number | null {
  const lev = new Map(leverage.filter((l) => l.leverageX > 0).map((l) => [l.pool.toLowerCase(), l.leverageX]));
  let total = 0;
  let covered = 0;
  let weighted = 0;
  for (const [pool, n] of tradesPerPool) {
    total += n;
    const x = lev.get(pool.toLowerCase());
    if (x !== undefined) {
      covered += n;
      weighted += n * x;
    }
  }
  if (total === 0 || covered / total < MIN_LEVERAGE_COVERAGE) return null;
  return round(weighted / covered, 1);
}

/**
 * Drawdown of the cumulative realized-PnL path (start of window = 0), and that fall
 * as a share of the peak margin the trader is estimated to have deployed.
 * Margin per market = open notional x (1 / explicit leverage, else the market's initial margin ratio).
 */
function drawdown(
  changes: PositionChangeRow[],
  markets: MarketRow[],
  leverage: LeverageRow[],
): { abs: number; pct: number | null } | null {
  if (changes.length === 0) return null;

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const c of changes) {
    cum += quote(big(c.realizedPnl));
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }

  const mkt = new Map(markets.map((m) => [m.poolAddress.toLowerCase(), m]));
  const lev = new Map(leverage.filter((l) => l.leverageX > 0).map((l) => [l.pool.toLowerCase(), l.leverageX]));
  const marginRatio = (pool: string): number | null => {
    const x = lev.get(pool);
    if (x !== undefined) return 1 / x;
    const m = mkt.get(pool);
    return m && m.initialMarginBps > 0 ? m.initialMarginBps / 10_000 : null;
  };
  const notional = (pool: string, size: string, price: string | null): number | null => {
    const m = mkt.get(pool);
    if (!m) return null;
    const s = Math.abs(Number(big(size)));
    if (s === 0) return 0;
    if (price == null) return null;
    return (s / 10 ** m.baseDecimals) * (Number(big(price)) / 1e18);
  };

  // Margin per pool, seeded with positions already open when the window starts.
  const margin = new Map<string, number>();
  let unknown = false;
  const setMargin = (pool: string, size: string, price: string | null) => {
    const n = notional(pool, size, price);
    const r = marginRatio(pool);
    if (n === null || r === null) {
      unknown = true;
      return;
    }
    margin.set(pool, n * r);
  };
  const seen = new Set<string>();
  for (const c of changes) {
    const pool = c.pool.toLowerCase();
    if (seen.has(pool)) continue;
    seen.add(pool);
    setMargin(pool, c.sizeBefore, c.entryPriceBefore);
  }
  let covered = 0;
  let allNotional = 0;
  const total = () => [...margin.values()].reduce((a, b) => a + b, 0);
  let peakMargin = total();
  for (const c of changes) {
    const pool = c.pool.toLowerCase();
    setMargin(pool, c.sizeAfter, c.entryPriceAfter);
    const n = notional(pool, c.sizeAfter, c.entryPriceAfter) ?? 0;
    allNotional += n;
    if (lev.has(pool)) covered += n;
    peakMargin = Math.max(peakMargin, total());
  }

  const explicitShare = allNotional > 0 ? covered / allNotional : 0;
  const pct = unknown || peakMargin <= 0 || explicitShare < MIN_LEVERAGE_COVERAGE ? null : (maxDd / peakMargin) * 100;
  return { abs: maxDd, pct };
}

export async function getTraderStats(trader: Address, opts: StatsOptions = {}): Promise<TraderStats> {
  if (!ADDRESS_RE.test(trader)) throw new TypeError(`invalid trader address: ${String(trader)}`);
  const ix = opts.indexer ?? new Indexer(opts);
  const windowDays = opts.windowDays ?? 30;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const since = now - windowDays * DAY;

  const changes = await ix.positionChanges(trader, since);
  const liquidations = await ix.liquidations(trader, since);
  const leverage = changes.rows.length ? await ix.leverage(trader) : [];
  const markets = changes.rows.length ? await ix.markets() : [];
  const lastActiveTs = await ix.lastActiveTs(trader);

  return computeStats({
    trader: trader.toLowerCase() as Address,
    windowDays,
    changes: changes.rows,
    liquidations: liquidations.rows,
    leverage,
    markets,
    lastActiveTs,
    truncated: changes.truncated || liquidations.truncated,
  });
}

import { Indexer, type Address } from "./indexer.ts";
import { getTraderStats, type StatsOptions, type TraderStats } from "./stats.ts";

export interface RankedTrader {
  rank: number;
  trader: Address;
  realizedPnl30d: number;
  /** realizedPnl / max(maxDrawdownAbs30d, 1): PnL per unit of realized drawdown. Informational; ranking is by PnL. */
  riskAdjusted: number;
  stats: TraderStats;
}

export interface RankOptions extends StatsOptions {
  /** Wallets never listed (our own hub, test and demo wallets). Case-insensitive. */
  exclude?: Address[];
  /** Minimum voluntary trades in the window. Default 20. */
  minTrades?: number;
  /** Minimum active days in the window. Default 5. */
  minActiveDays?: number;
  /** Most liquidation transactions tolerated in the window. Default 1. */
  maxLiquidations?: number;
  /** How many candidate accounts to evaluate. Default 25. */
  candidateLimit?: number;
  /** Candidate rows per request. Default 150. */
  candidatePageSize?: number;
  /** Most candidate pages to read. Default 5. */
  candidatePages?: number;
}

/**
 * The options Copybook ranks with, in the app and the MCP server alike. The indexer is read one request at a time;
 * this budget keeps a cold ranking well inside a 60 s function (about 40 s measured against the live indexer). Rows
 * past 2000 per trader mark it truncated, and truncated histories are dropped from the ranking.
 */
export const RANK_OPTIONS = {
  candidateLimit: 20,
  delayMs: 40,
  maxRows: 2_000,
  minTrades: 20,
  minActiveDays: 5,
  maxLiquidations: 1,
} as const satisfies RankOptions;

export interface SkippedTrader {
  account: Address;
  reason: string;
}

export interface TopTradersResult {
  traders: RankedTrader[];
  /** Candidates whose history could not be fetched. */
  skipped: SkippedTrader[];
  /** True when fewer than `candidateLimit` candidates were found within the page budget. */
  candidateShortfall: boolean;
}

/**
 * Top traders by realized PnL over the last `windowDays` days.
 *
 * Candidates are the accounts behind the largest single realized gains in the window;
 * each is then measured over the whole window and ranked on its total. The list can be
 * shorter than `n`: candidates are limited by the page budget, by the activity and
 * liquidation filters, and by fetch failures (reported in `skipped`).
 * Accounts whose history exceeds the row cap are dropped, since their window PnL would be partial.
 */
export async function topTraders(n: number, windowDays = 30, opts: RankOptions = {}): Promise<TopTradersResult> {
  const exclude = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  const minTrades = opts.minTrades ?? 20;
  const minActiveDays = opts.minActiveDays ?? 5;
  const maxLiquidations = opts.maxLiquidations ?? 1;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ix = opts.indexer ?? new Indexer(opts);

  const since = now - windowDays * 86400;
  const want = opts.candidateLimit ?? 25;
  const candidates = await ix.candidateAccounts(since, want, {
    exclude,
    pageSize: opts.candidatePageSize,
    maxPages: opts.candidatePages,
  });

  const ranked: Omit<RankedTrader, "rank">[] = [];
  const skipped: SkippedTrader[] = [];
  for (const trader of candidates) {
    let stats: TraderStats;
    try {
      stats = await getTraderStats(trader, { ...opts, windowDays, now, indexer: ix });
    } catch (e) {
      skipped.push({ account: trader, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (
      stats.truncated ||
      stats.trades30d < minTrades ||
      stats.activeDays30d < minActiveDays ||
      stats.liquidations30d > maxLiquidations
    )
      continue;
    const riskAdjusted = Math.round((stats.realizedPnl30d / Math.max(stats.maxDrawdownAbs30d ?? 0, 1)) * 100) / 100;
    ranked.push({ trader, realizedPnl30d: stats.realizedPnl30d, riskAdjusted, stats });
  }

  ranked.sort((a, b) => b.realizedPnl30d - a.realizedPnl30d || a.trader.localeCompare(b.trader));
  return {
    traders: ranked.slice(0, n).map((r, i) => ({ rank: i + 1, ...r })),
    skipped,
    candidateShortfall: candidates.length < want,
  };
}

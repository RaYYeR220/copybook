import { Indexer, type Address } from "./indexer.ts";
import { getTraderStats, type StatsOptions, type TraderStats } from "./stats.ts";

export interface RankedTrader {
  rank: number;
  trader: Address;
  realizedPnl30d: number;
  stats: TraderStats;
}

export interface RankOptions extends StatsOptions {
  /** Wallets never listed (our own hub, test and demo wallets). Case-insensitive. */
  exclude?: Address[];
  /** Minimum voluntary trades in the window. Default 5. */
  minTrades?: number;
  /** Minimum active days in the window. Default 2. */
  minActiveDays?: number;
  /** How many candidate accounts to evaluate. Default 25. */
  candidateLimit?: number;
}

/**
 * Top traders by realized PnL over the last `windowDays` days.
 *
 * Candidates are the accounts behind the largest single realized gains in the window;
 * each is then measured over the whole window and ranked on its total.
 * Accounts whose history exceeds the row cap are skipped, since their window PnL would be partial.
 */
export async function topTraders(n: number, windowDays = 30, opts: RankOptions = {}): Promise<RankedTrader[]> {
  const exclude = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  const minTrades = opts.minTrades ?? 5;
  const minActiveDays = opts.minActiveDays ?? 2;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ix = opts.indexer ?? new Indexer(opts);

  const since = now - windowDays * 86400;
  const want = opts.candidateLimit ?? 25;
  const found = await ix.candidateAccounts(since, (want + exclude.size) * 3);
  const candidates = found.filter((a) => !exclude.has(a)).slice(0, want);

  const ranked: Omit<RankedTrader, "rank">[] = [];
  for (const trader of candidates) {
    const stats = await getTraderStats(trader, { ...opts, windowDays, now, indexer: ix });
    if (stats.truncated || stats.trades30d < minTrades || stats.activeDays30d < minActiveDays) continue;
    ranked.push({ trader, realizedPnl30d: stats.realizedPnl30d, stats });
  }

  ranked.sort((a, b) => b.realizedPnl30d - a.realizedPnl30d || a.trader.localeCompare(b.trader));
  return ranked.slice(0, n).map((r, i) => ({ rank: i + 1, ...r }));
}

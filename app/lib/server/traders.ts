import type { Address } from "viem";
import type { RankOptions, RankedTrader, SkippedTrader, TopTradersResult, TraderStats } from "@copybook/stats";

export const WINDOW_DAYS = 30;
export const TOP_N = 10;
/** Extra places asked for, so dropping copy wallets after the ranking still leaves TOP_N when it can. */
const SLACK = 3;
/**
 * The indexer is read one request at a time; this budget keeps a cold ranking well inside a 60 s function
 * (about 40 s measured against the live indexer). Rows past 2000 per trader mark it truncated, and truncated
 * histories are dropped from the ranking, as `topTraders` documents.
 */
export const RANK_OPTIONS: RankOptions = { candidateLimit: 20, delayMs: 40, maxRows: 2_000 };

export interface TradersPayload {
  windowDays: number;
  asOf: string;
  traders: RankedTrader[];
  skipped: SkippedTrader[];
  candidateShortfall: boolean;
  /** Copy wallets found in the hub's Followed events and removed from the ranking. */
  removedFollowers: Address[];
  /** Copybook's own demo leader: listed apart, never ranked. `stats` is null when the indexer did not answer. */
  demo: { trader: Address; stats: TraderStats | null };
}

export interface RankDeps {
  topTraders(n: number, windowDays: number, opts: RankOptions): Promise<TopTradersResult>;
  getTraderStats(trader: Address, opts: { windowDays: number; maxRows: number }): Promise<TraderStats>;
  /** Wallets that ever followed through the hub (best effort: an empty list when the log is unavailable). */
  followerWallets(): Promise<Address[]>;
  ownWallets: readonly Address[];
  demoLeader: Address;
  now(): Date;
}

/** Top traders by realized PnL over the window, without our wallets and copy wallets, plus the labelled demo leader. */
export async function rankTraders(d: RankDeps): Promise<TradersPayload> {
  const [ranked, followers] = await Promise.all([
    d.topTraders(TOP_N + SLACK, WINDOW_DAYS, { ...RANK_OPTIONS, exclude: [...d.ownWallets] }),
    d.followerWallets().catch(() => [] as Address[]),
  ]);
  const drop = new Set(followers.map((a) => a.toLowerCase()));
  const removed = ranked.traders.filter((t) => drop.has(t.trader.toLowerCase())).map((t) => t.trader as Address);
  const traders = ranked.traders
    .filter((t) => !drop.has(t.trader.toLowerCase()))
    .slice(0, TOP_N)
    .map((t, i) => ({ ...t, rank: i + 1 }));

  // after the ranking, not beside it: the indexer is read one request at a time
  const demoStats = await d.getTraderStats(d.demoLeader, { windowDays: WINDOW_DAYS, maxRows: RANK_OPTIONS.maxRows! }).catch(() => null);

  return {
    windowDays: WINDOW_DAYS,
    asOf: d.now().toISOString(),
    traders,
    skipped: ranked.skipped,
    candidateShortfall: ranked.candidateShortfall,
    removedFollowers: removed,
    demo: { trader: d.demoLeader, stats: demoStats },
  };
}

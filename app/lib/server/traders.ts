import type { Address } from "viem";
import { RANK_OPTIONS, type RankOptions, type RankedTrader, type SkippedTrader, type TopTradersResult, type TraderStats } from "@copybook/stats";

export const WINDOW_DAYS = 30;
export const TOP_N = 10;
/** Extra places asked for, so dropping copy wallets after the ranking still leaves TOP_N when it can. */
const SLACK = 3;
/** The ranking's options, shared with the MCP server (see RANK_OPTIONS in @copybook/stats). */
export { RANK_OPTIONS };

/** The filters a ranked trader passed, as the page states them. */
export const RANK_RULES = {
  minTrades: RANK_OPTIONS.minTrades,
  minActiveDays: RANK_OPTIONS.minActiveDays,
  maxLiquidations: RANK_OPTIONS.maxLiquidations,
  candidates: RANK_OPTIONS.candidateLimit,
  maxRows: RANK_OPTIONS.maxRows,
};

export interface TradersPayload {
  windowDays: number;
  rules: typeof RANK_RULES;
  asOf: string;
  traders: RankedTrader[];
  skipped: SkippedTrader[];
  candidateShortfall: boolean;
  /** Copy wallets found in the hub's Followed events and removed from the ranking. */
  removedFollowers: Address[];
  /** Whether that list came from the whole hub log, part of it (still being read), or none (it could not be read). */
  followerExclusion: "complete" | "partial" | "unavailable";
  /** Copybook's own demo leader: listed apart, never ranked. `stats` is null when the indexer did not answer. */
  demo: { trader: Address; stats: TraderStats | null };
}

export interface RankDeps {
  topTraders(n: number, windowDays: number, opts: RankOptions): Promise<TopTradersResult>;
  getTraderStats(trader: Address, opts: { windowDays: number; maxRows: number }): Promise<TraderStats>;
  /** Wallets that ever followed through the hub, and whether the log they come from was read in full. Throws when unreadable. */
  followerWallets(): Promise<{ wallets: Address[]; complete: boolean }>;
  ownWallets: readonly Address[];
  demoLeader: Address;
  now(): Date;
}

/** Top traders by realized PnL over the window, without our wallets and copy wallets, plus the labelled demo leader. */
export async function rankTraders(d: RankDeps): Promise<TradersPayload> {
  const [ranked, followers] = await Promise.all([
    d.topTraders(TOP_N + SLACK, WINDOW_DAYS, { ...RANK_OPTIONS, exclude: [...d.ownWallets] }),
    d.followerWallets().catch(() => null),
  ]);
  const drop = new Set((followers?.wallets ?? []).map((a) => a.toLowerCase()));
  const removed = ranked.traders.filter((t) => drop.has(t.trader.toLowerCase())).map((t) => t.trader as Address);
  const traders = ranked.traders
    .filter((t) => !drop.has(t.trader.toLowerCase()))
    .slice(0, TOP_N)
    .map((t, i) => ({ ...t, rank: i + 1 }));

  // after the ranking, not beside it: the indexer is read one request at a time
  const demoStats = await d.getTraderStats(d.demoLeader, { windowDays: WINDOW_DAYS, maxRows: RANK_OPTIONS.maxRows }).catch(() => null);

  return {
    windowDays: WINDOW_DAYS,
    rules: RANK_RULES,
    asOf: d.now().toISOString(),
    traders,
    skipped: ranked.skipped,
    candidateShortfall: ranked.candidateShortfall,
    removedFollowers: removed,
    followerExclusion: followers === null ? "unavailable" : followers.complete ? "complete" : "partial",
    demo: { trader: d.demoLeader, stats: demoStats },
  };
}

import type { Address } from "viem";
import type { Leg, TierName } from "@copybook/sdk";
import type { TraderStats } from "@copybook/stats";
import type { CopyView } from "../copy";
import { fmtInt, shortHex } from "../format";
import type { MarketMeta } from "../tape";
import { grossBps, legSide, netBps, pctOfBps } from "../thesis";
import { fmtPnl, fmtPrice18, fmtUnits, fmtUsd18, fmtUtc } from "../units";

/** How the cards name things: market symbols (indexer), thesis names (registry), our own wallets. */
export interface CardNames {
  markets: Record<string, MarketMeta>;
  theses: Record<string, string>;
  demoLeader: Address;
  /** lower-case addresses of the wallets Copybook runs (hideki.json's demoWallets) */
  ours: readonly string[];
}

const lc = (a: string) => a.toLowerCase();
const market = (names: CardNames, pool: string) => {
  const m = names.markets[lc(pool)];
  return m ? `${m.symbol}-PERP` : shortHex(pool);
};

export interface CopyCardModel {
  sameBlock: boolean;
  block: string;
  time: string;
  market: string;
  /** e.g. `0 → 0.0005 BTC` */
  move: string;
  /** long / short / flat after the copy */
  side: string;
  limit: string;
  leader: { index: number; hash: string } | null;
  copy: { index: number; hash: string };
  /** How it was sent, in words, when not by the handler in the move's block. */
  sentBy: string | null;
  source: string;
  sourceOurs: boolean;
  follower: string;
  /** Every name on the card came from a read that answered: the market, the source, a thesis's name. Only then is the card kept for good. */
  resolved: boolean;
  /** The view itself is final (see CopyView.complete). */
  complete: boolean;
}

const sideOf = (size: bigint) => (size > 0n ? "long" : size < 0n ? "short" : "flat");

export function copyCardModel(v: CopyView, names: CardNames): CopyCardModel {
  const meta = names.markets[lc(v.pool)];
  const size = (x: bigint) => (meta ? fmtUnits(x < 0n ? -x : x, meta.decimals) : `${(x < 0n ? -x : x).toString()} units`);
  let source = v.complete ? `source ${shortHex(v.sourceId, 6, 4)}, which the hub's log does not name` : "a source not named yet: the hub's log is still being read";
  let ours = false;
  let named = false;
  if (v.source?.kind === "Trader") {
    ours = lc(v.source.trader) === lc(names.demoLeader);
    source = `trader ${shortHex(v.source.trader)}${ours ? " · demo leader, ours" : ""}`;
    named = true;
  } else if (v.source?.kind === "Theme") {
    const id = v.source.themeId.toString();
    named = id in names.theses;
    source = `thesis #${v.source.themeId}${named ? ` · ${names.theses[id]}` : ""}`;
  }
  return {
    sameBlock: v.sameBlock,
    block: fmtInt(v.block),
    time: fmtUtc(v.time),
    market: market(names, v.pool),
    move: `${v.fromSize === 0n ? "0" : `${sideOf(v.fromSize)} ${size(v.fromSize)}`} → ${v.toSize === 0n ? "flat" : `${sideOf(v.toSize)} ${size(v.toSize)}`}${meta ? ` ${meta.symbol}` : ""}`,
    side: sideOf(v.toSize),
    limit: v.limitPrice > 0n ? fmtPrice18(v.limitPrice) : "—",
    leader: v.leader ? { index: v.leader.txIndex, hash: shortHex(v.leader.hash, 6, 4) } : null,
    copy: { index: v.txIndex, hash: shortHex(v.hash, 6, 4) },
    sentBy:
      v.via === "call"
        ? `sent by a ${v.call ?? "direct"} call to the hub`
        : v.leader
          ? null
          : "sent by the hub's handler; the move it answers is not in this block",
    source,
    sourceOurs: ours,
    follower: shortHex(v.follower),
    resolved: v.complete && named && !!meta,
    complete: v.complete,
  };
}

/** Followers from the hub's log: a floor while the log is still being read. */
export interface FollowerFigure {
  n: number;
  complete: boolean;
}

const followersText = (f: FollowerFigure | null) => (f ? `${f.complete ? "" : "at least "}${fmtInt(f.n)} following through Copybook` : null);

export interface TraderCardModel {
  name: string;
  address: string;
  demo: boolean;
  /** Null when the indexer did not answer: the card then shows no record at all. */
  stats: { label: string; value: string; note?: string }[] | null;
  noTrades: boolean;
  verdict: string | null;
  followers: string | null;
  asOf: string;
}

const TIER: Record<TierName, string> = { None: "not reviewed", Ok: "OK", Caution: "CAUTION", Block: "BLOCK" };

export function traderCardModel(x: {
  trader: Address;
  demoLeader: Address;
  stats: TraderStats | null;
  verdict: { tier: TierName; blocking: boolean } | null;
  followers: FollowerFigure | null;
  now: number;
}): TraderCardModel {
  const s = x.stats;
  return {
    name: shortHex(x.trader),
    address: x.trader,
    demo: lc(x.trader) === lc(x.demoLeader),
    stats:
      s && s.hasHistory
        ? [
            { label: `Realized PnL · ${s.windowDays} d`, value: fmtPnl(s.realizedPnl30d), note: "USDso" },
            { label: "Trades", value: fmtInt(s.trades30d) },
            { label: "Active days", value: `${s.activeDays30d} of ${s.windowDays}` },
          ]
        : null,
    noTrades: !!s && !s.hasHistory,
    verdict: x.verdict ? (x.verdict.tier === "Block" && !x.verdict.blocking ? "BLOCK, lapsed" : TIER[x.verdict.tier]) : null,
    followers: followersText(x.followers),
    asOf: fmtUtc(x.now),
  };
}

export interface ThesisCardModel {
  id: string;
  name: string;
  version: number;
  creator: string;
  ours: boolean;
  legs: { market: string; side: "long" | "short"; pct: string; share: number }[];
  /** Legs past the ones drawn. */
  more: number;
  gross: string;
  net: string;
  opensFrom: string | null;
  followers: string | null;
  asOf: string;
}

const MAX_DRAWN = 5;

export function thesisCardModel(x: {
  id: bigint;
  name: string;
  version: number;
  creator: Address;
  legs: Leg[];
  minimum: bigint | null;
  names: CardNames;
  followers: FollowerFigure | null;
  now: number;
}): ThesisCardModel {
  const top = Math.max(1, ...x.legs.map((l) => Math.abs(l.weightBps)));
  const net = netBps(x.legs);
  return {
    id: x.id.toString(),
    name: x.name,
    version: x.version,
    creator: shortHex(x.creator),
    ours: x.names.ours.includes(lc(x.creator)),
    legs: x.legs.slice(0, MAX_DRAWN).map((l) => ({ market: market(x.names, l.pool), ...legSide(l.weightBps), share: Math.abs(l.weightBps) / top })),
    more: Math.max(0, x.legs.length - MAX_DRAWN),
    gross: pctOfBps(grossBps(x.legs)),
    net: net === 0 ? "flat" : `${pctOfBps(Math.abs(net))} ${net > 0 ? "long" : "short"}`,
    opensFrom: x.minimum === null ? null : fmtUsd18(x.minimum, "up"),
    followers: followersText(x.followers),
    asOf: fmtUtc(x.now),
  };
}

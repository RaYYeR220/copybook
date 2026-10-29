import type { Hex } from "viem";
import type { CopybookEvent, ReasonName, SourceKindName } from "@copybook/sdk";
import { fmtInt } from "./format";

/** Below this many increase decisions (copied + refused) a source's fidelity is shown, flagged, and not ranked. */
export const FEW_EVENTS = 10;

/** A copy that grew the position: opened it, added to it, or put it on the other side (a flip's new half). */
export const isIncrease = (from: bigint, to: bigint): boolean => {
  const a = from < 0n ? -from : from;
  const b = to < 0n ? -to : to;
  return b > a || (from !== 0n && to !== 0n && from < 0n !== to < 0n);
};

/** One followed source, counted from the hub's events over the log read. */
export interface BoardRow {
  sourceId: Hex;
  kind: SourceKindName;
  /** The trader's address as an integer, or the thesis id. */
  ref: bigint;
  /** Wallets whose latest follow names this source and was not undone. */
  followersNow: number;
  /** Distinct wallets that ever followed it. */
  followersEver: number;
  /** `Copied` events that grew a position. */
  copied: number;
  /** `Refused` events, every reason. */
  refused: number;
  /** `Copied` events that shrank or closed a position. */
  exits: number;
  /** copied + refused: the n of the fidelity. */
  decisions: number;
  /** floor(copied / decisions) in bps; null with no decision. */
  fidelityBps: number | null;
  /** 0 < decisions < FEW_EVENTS. */
  few: boolean;
  refusedBy: Partial<Record<ReasonName, number>>;
  /** Block of this source's newest event. */
  lastBlock?: bigint;
}

/**
 * Every source the log names (and `extra`, e.g. theses nobody followed yet), with followers replayed from Followed and
 * Unfollowed in chain order, and the hub's answers to its moves: increases copied, refusals, exits. `events` must be in
 * chain order.
 */
export function boardRows(events: readonly CopybookEvent[], extra: readonly { sourceId: Hex; kind: SourceKindName; ref: bigint }[]): BoardRow[] {
  const rows = new Map<string, BoardRow>();
  const row = (sourceId: Hex, kind: SourceKindName, ref: bigint) => {
    const k = sourceId.toLowerCase();
    let r = rows.get(k);
    if (!r) {
      r = { sourceId, kind, ref, followersNow: 0, followersEver: 0, copied: 0, refused: 0, exits: 0, decisions: 0, fidelityBps: null, few: false, refusedBy: {} };
      rows.set(k, r);
    }
    return r;
  };
  for (const e of events) if (e.name === "Followed") row(e.sourceId, e.kind, e.ref);
  for (const x of extra) row(x.sourceId, x.kind, x.ref);

  const following = new Map<string, string>(); // follower → source it follows now
  const ever = new Map<string, Set<string>>();
  for (const e of events) {
    if (!("sourceId" in e)) continue;
    const k = e.sourceId.toLowerCase();
    const r = rows.get(k);
    if (e.name === "Followed") {
      following.set(e.follower.toLowerCase(), k);
      if (!ever.has(k)) ever.set(k, new Set());
      ever.get(k)!.add(e.follower.toLowerCase());
    } else if (e.name === "Unfollowed") {
      if (following.get(e.follower.toLowerCase()) === k) following.delete(e.follower.toLowerCase());
    }
    if (!r) continue; // a copy for a source whose follow the log did not reach
    if (e.name === "Copied") {
      if (isIncrease(e.fromSize, e.toSize)) r.copied++;
      else r.exits++;
    } else if (e.name === "Refused") {
      r.refused++;
      r.refusedBy[e.reason] = (r.refusedBy[e.reason] ?? 0) + 1;
    }
    if (e.name === "Followed" || e.name === "Unfollowed" || e.name === "Copied" || e.name === "Refused") r.lastBlock = e.log.blockNumber ?? r.lastBlock;
  }
  for (const [k, r] of rows) {
    r.followersEver = ever.get(k)?.size ?? 0;
    r.followersNow = [...following.values()].filter((s) => s === k).length;
    r.decisions = r.copied + r.refused;
    r.fidelityBps = r.decisions ? Math.floor((r.copied * 10_000) / r.decisions) : null;
    r.few = r.decisions > 0 && r.decisions < FEW_EVENTS;
  }
  return [...rows.values()];
}

/** `60% · 3 of 5`: the share floored to a tenth of a percent (it never reads 100% while anything was refused), always with n. */
export function fidelityText(r: Pick<BoardRow, "copied" | "decisions" | "fidelityBps">): string {
  if (r.fidelityBps === null) return "no increases yet";
  const tenths = Math.floor(r.fidelityBps / 10);
  const pct = tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
  return `${pct}% · ${fmtInt(r.copied)} of ${fmtInt(r.decisions)}`;
}

export type RankBy = "followers" | "fidelity";

/** copied/decisions compared exactly (cross-multiplied), larger n first on a tie. */
const byFidelity = (a: BoardRow, b: BoardRow) => {
  const x = BigInt(b.copied) * BigInt(a.decisions) - BigInt(a.copied) * BigInt(b.decisions);
  return x > 0n ? 1 : x < 0n ? -1 : b.decisions - a.decisions;
};
const byFollowers = (a: BoardRow, b: BoardRow) =>
  b.followersNow - a.followersNow || b.followersEver - a.followersEver || b.decisions - a.decisions || Number((b.lastBlock ?? 0n) - (a.lastBlock ?? 0n));

/**
 * Rows in order with their rank. By followers every source is ranked. By fidelity only sources with at least
 * FEW_EVENTS decisions get a rank; few-event sources follow, then sources with none, unranked.
 */
export function rankRows(rows: readonly BoardRow[], by: RankBy): { row: BoardRow; rank: number | null }[] {
  if (by === "followers") return [...rows].sort(byFollowers).map((row, i) => ({ row, rank: i + 1 }));
  const rated = rows.filter((r) => r.decisions >= FEW_EVENTS).sort(byFidelity);
  const few = rows.filter((r) => r.few).sort(byFidelity);
  const none = rows.filter((r) => r.decisions === 0).sort(byFollowers);
  return [...rated.map((row, i) => ({ row, rank: i + 1 as number | null })), ...[...few, ...none].map((row) => ({ row, rank: null }))];
}

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
  /**
   * Increases copied. A trader: `Copied` events that grew a position. A thesis: syncs (one per follower per
   * transaction) whose increases went through with nothing refused.
   */
  copied: number;
  /** A trader: `Refused` events, every reason. A thesis: syncs with any refusal in them. */
  refused: number;
  /** `Copied` events that shrank or closed a position (events, for both kinds). */
  exits: number;
  /** copied + refused: the n of the fidelity. */
  decisions: number;
  /** floor(copied / decisions) in bps; null with no decision. */
  fidelityBps: number | null;
  /** 0 < decisions < FEW_EVENTS. */
  few: boolean;
  /** Refusals by reason: events for a trader; for a thesis, the syncs each reason appeared in. */
  refusedBy: Partial<Record<ReasonName, number>>;
  /** Block of this source's newest event. */
  lastBlock?: bigint;
}

/**
 * Every source the log names (and `extra`, e.g. theses nobody followed yet), with followers replayed from Followed and
 * Unfollowed in chain order, and the hub's answers to its moves: increases copied, refusals, exits. `events` must be in
 * chain order.
 *
 * A trader's decisions are events: each Copied increase and each Refused. A thesis decides per follower per
 * transaction, its increases opening as one set: a sync whose increases were copied with nothing refused is one copied
 * decision, and a sync with any refusal in it (a gate on the set, a leg below the minimum, a leg the venue failed,
 * or an exit the venue left unfilled) is one refused decision, even when some leg moved in it.
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

  // a thesis sync, keyed by source, transaction and follower
  const syncs = new Map<string, { row: BoardRow; increased: boolean; reasons: Set<ReasonName> }>();
  const sync = (r: BoardRow, e: CopybookEvent & { follower: string }) => {
    const k = `${r.sourceId.toLowerCase()}|${e.log.transactionHash ?? `${e.log.blockNumber}:${e.log.logIndex}`}|${e.follower.toLowerCase()}`;
    let s = syncs.get(k);
    if (!s) syncs.set(k, (s = { row: r, increased: false, reasons: new Set() }));
    return s;
  };
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
      const up = isIncrease(e.fromSize, e.toSize);
      if (!up) r.exits++;
      else if (r.kind === "Theme") sync(r, e).increased = true;
      else r.copied++;
    } else if (e.name === "Refused") {
      if (r.kind === "Theme") sync(r, e).reasons.add(e.reason);
      else {
        r.refused++;
        r.refusedBy[e.reason] = (r.refusedBy[e.reason] ?? 0) + 1;
      }
    }
    if (e.name === "Followed" || e.name === "Unfollowed" || e.name === "Copied" || e.name === "Refused") r.lastBlock = e.log.blockNumber ?? r.lastBlock;
  }
  for (const s of syncs.values()) {
    if (s.reasons.size > 0) {
      s.row.refused++;
      for (const reason of s.reasons) s.row.refusedBy[reason] = (s.row.refusedBy[reason] ?? 0) + 1;
    } else if (s.increased) s.row.copied++;
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

/** The share floored to a tenth of a percent (it never reads 100% while anything was refused) and its counts; null with none. */
export function fidelityParts(r: Pick<BoardRow, "copied" | "decisions" | "fidelityBps">): { pct: string; counts: string } | null {
  if (r.fidelityBps === null) return null;
  const tenths = Math.floor(r.fidelityBps / 10);
  return { pct: `${tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)}%`, counts: `${fmtInt(r.copied)} of ${fmtInt(r.decisions)}` };
}

/** `60% · 3 of 5`: never the share without n. */
export function fidelityText(r: Pick<BoardRow, "copied" | "decisions" | "fidelityBps">): string {
  const p = fidelityParts(r);
  return p ? `${p.pct} · ${p.counts}` : "no increases yet";
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

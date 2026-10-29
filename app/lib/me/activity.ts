import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { hubAbi, type CopybookEvent, type ReasonName } from "@copybook/sdk";
import type { LoggedEvent, Via } from "../events";
import type { LastRefusals } from "./book";

/**
 * What the dashboard reads out of a follower's own events (the history route plus the live watcher, newest first
 * as the feed keeps them): when the current follow began, its refusals by reason, the last refusal per market,
 * deferrals since, and what the tank has been charged per run.
 */

type Ev = CopybookEvent & { log: { blockNumber?: bigint; transactionHash?: Hex } };

const lc = (a: string) => a.toLowerCase();
const chain = (events: readonly Ev[]) => [...events].filter((e) => e.log.blockNumber !== undefined).sort((a, b) => Number(a.log.blockNumber! - b.log.blockNumber!));

/** The Followed event of the follow the wallet holds now (the latest one not undone), if the feed has it. */
export function currentFollowEvent(events: readonly Ev[], follower: Address, sourceId: Hex): Extract<Ev, { name: "Followed" }> | undefined {
  let cur: Extract<Ev, { name: "Followed" }> | undefined;
  for (const e of chain(events)) {
    if (e.name === "Followed" && lc(e.follower) === lc(follower)) cur = e;
    if (e.name === "Unfollowed" && lc(e.follower) === lc(follower)) cur = undefined;
  }
  return cur && lc(cur.sourceId) === lc(sourceId) ? cur : undefined;
}

export const MAIN_REASONS: ReasonName[] = ["BandUnfilled", "TotalCap", "EquityFloor", "TankEmpty", "RiskGate", "BelowMinimum", "AtCap"];

/** Refusals by reason since a block: the seven the hub gives most, always listed, then any other that occurred. */
export function refusalCounts(events: readonly Ev[], since: bigint): { reason: ReasonName; n: number }[] {
  const n = new Map<ReasonName, number>(MAIN_REASONS.map((r) => [r, 0]));
  for (const e of events) {
    if (e.name !== "Refused" || (e.log.blockNumber ?? 0n) < since) continue;
    const r = e.reason === "None" ? "VenueRejected" : e.reason;
    n.set(r, (n.get(r) ?? 0) + 1);
  }
  return [...n.entries()].map(([reason, count]) => ({ reason, n: count }));
}

/** The newest refusal per market since a block. */
export function lastRefusals(events: readonly Ev[], since: bigint): LastRefusals {
  const out: LastRefusals = {};
  for (const e of chain(events)) {
    if (e.name === "Refused" && (e.log.blockNumber ?? 0n) >= since) out[lc(e.pool)] = { reason: e.reason === "None" ? "VenueRejected" : e.reason, block: e.log.blockNumber! };
    // a later copy in that market supersedes the refusal
    if (e.name === "Copied" && (e.log.blockNumber ?? 0n) >= since) delete out[lc(e.pool)];
  }
  return out;
}

/** The newest Deferred since a block that no later copy or refusal of this follower answered. */
export function openDeferral(events: readonly Ev[], since: bigint): bigint | undefined {
  let at: bigint | undefined;
  for (const e of chain(events)) {
    const b = e.log.blockNumber!;
    if (b < since) continue;
    if (e.name === "Deferred") at = b;
    else if ((e.name === "Copied" || e.name === "Refused") && at !== undefined && b > at) at = undefined;
  }
  return at;
}

/** A GroupDeferred that reached this wallet's seat. */
export interface GroupDeferral {
  block: bigint;
  group: number;
  /** The first seat the handler did not reach. */
  fromIndex: number;
}

/**
 * The newest GroupDeferred of this wallet's group since a block that may have skipped it and that no later copy or
 * refusal of this wallet answered. The hub emits it when a delivery's gas runs short: seats `fromIndex` onward, as
 * the group stood then, were not synced. The node keeps no past state, so the seat is today's (an unfollow moves the
 * group's last member into the leaver's seat): a seat at or past `fromIndex` counts.
 */
export function openGroupDeferral(
  sourceEvents: readonly Ev[],
  ownEvents: readonly Ev[],
  sourceId: Hex,
  seat: { group: number; index: number },
  since: bigint,
): GroupDeferral | undefined {
  let at: GroupDeferral | undefined;
  for (const e of chain(sourceEvents)) {
    const b = e.log.blockNumber!;
    if (b < since || e.name !== "GroupDeferred" || lc(e.sourceId) !== lc(sourceId) || e.group !== seat.group) continue;
    if (Number(e.fromIndex) <= seat.index) at = { block: b, group: e.group, fromIndex: Number(e.fromIndex) };
  }
  if (!at) return undefined;
  const found = at;
  const answered = ownEvents.some((e) => (e.name === "Copied" || e.name === "Refused") && (e.log.blockNumber ?? 0n) > found.block);
  return answered ? undefined : found;
}

export interface TankStats {
  /** TankCharged events of the current follow (since its Followed block). */
  runs: number;
  total: bigint;
  /** Mean charge per run; undefined without any run. */
  average?: bigint;
  /** Runs the tank covers at that mean, rounded down; undefined without any run. */
  left?: bigint;
}

/**
 * What the handler has charged this wallet's tank for the current follow, per run that copied or refused (those
 * log TankCharged; a run that finds nothing to do is billed without one), and how many such runs the tank covers
 * at that mean. Without the follow's block (`since` undefined) nothing is estimated: older follows' charges are
 * other sources and other gas.
 */
export function tankStats(events: readonly Ev[], tank: bigint, since: bigint | undefined): TankStats {
  let runs = 0;
  let total = 0n;
  if (since === undefined) return { runs, total };
  for (const e of events)
    if (e.name === "TankCharged" && (e.log.blockNumber ?? 0n) >= since) {
      runs++;
      total += e.amount;
    }
  if (runs === 0 || total === 0n) return { runs, total };
  const average = total / BigInt(runs);
  return { runs, total, average, left: average > 0n ? tank / average : undefined };
}

/**
 * The market list a trader follow was opened with, from its transaction's calldata: an empty list is a
 * whole-book follow. Null when the transaction is not a plain `follow` call (sent through a contract).
 */
export function followTerms(input: Hex | undefined): { joinPools: Address[] } | null {
  if (!input) return null;
  try {
    const d = decodeFunctionData({ abi: hubAbi, data: input });
    if (d.functionName !== "follow") return null;
    const pools = (d.args?.[3] ?? []) as readonly Address[];
    return { joinPools: pools.map((p) => getAddress(p)) };
  } catch {
    return null;
  }
}

/** A copy into this wallet's book, as the feed logged it, with the address of its own page. */
export interface LatestCopy {
  path: string;
  block: bigint;
  pool: Address;
  sourceId: Hex;
  /** How it was sent, when the feed knows (see LoggedEvent). */
  via?: Via;
}

/** The newest copy into this wallet's book among the events read, by block then log position. */
export function latestCopy(events: readonly LoggedEvent[], follower: Address): LatestCopy | undefined {
  let best: Extract<LoggedEvent, { name: "Copied" }> | undefined;
  for (const e of events) {
    if (e.name !== "Copied" || lc(e.follower) !== lc(follower)) continue;
    const { blockNumber: b, logIndex: i, transactionHash: h } = e.log;
    if (b === undefined || i === undefined || !h) continue;
    if (!best || b > best.log.blockNumber! || (b === best.log.blockNumber && i > best.log.logIndex!)) best = e;
  }
  if (!best) return undefined;
  return {
    path: `/copy/${best.log.transactionHash}?log=${best.log.logIndex}`,
    block: best.log.blockNumber!,
    pool: getAddress(best.pool),
    sourceId: best.sourceId,
    ...(best.via ? { via: best.via } : {}),
  };
}

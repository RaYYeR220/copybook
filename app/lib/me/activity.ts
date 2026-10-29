import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { hubAbi, type CopybookEvent, type ReasonName } from "@copybook/sdk";
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

export interface TankStats {
  /** TankCharged events the feed holds for this wallet. */
  runs: number;
  total: bigint;
  /** Mean charge per run; undefined without any run. */
  average?: bigint;
  /** Runs the tank covers at that mean, rounded down; undefined without any run. */
  left?: bigint;
}

/** What the handler has charged this wallet's tank, per run, and how many more runs the tank covers at that mean. */
export function tankStats(events: readonly Ev[], tank: bigint): TankStats {
  let runs = 0;
  let total = 0n;
  for (const e of events)
    if (e.name === "TankCharged") {
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

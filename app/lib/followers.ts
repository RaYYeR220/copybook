import { getAddress, type Address, type Hex } from "viem";
import type { CopybookEvent, SourceKindName } from "@copybook/sdk";

/** Every wallet that ever followed anything through the hub: copy wallets, never traders to rank. */
export function followerWallets(events: readonly CopybookEvent[]): Address[] {
  const out = new Map<string, Address>();
  for (const e of events) if (e.name === "Followed") out.set(e.follower.toLowerCase(), getAddress(e.follower));
  return [...out.values()];
}

export interface FollowerCount {
  /** Wallets whose latest follow event names this source and was not undone. */
  current: Address[];
  /** Distinct wallets that ever followed it. */
  ever: number;
  /** Block of the newest follow or unfollow of this source, if any. */
  lastBlock?: bigint;
}

/**
 * Followers of one source, replayed from the hub's Followed and Unfollowed events in chain order. A wallet follows
 * one source at a time, so its latest Followed (not undone by a later Unfollowed) says what it follows now.
 */
export function followersOf(events: readonly CopybookEvent[], sourceId: Hex): FollowerCount {
  const sid = sourceId.toLowerCase();
  const now = new Map<string, { source: string; who: Address }>();
  const ever = new Set<string>();
  let lastBlock: bigint | undefined;
  for (const e of events) {
    if (e.name !== "Followed" && e.name !== "Unfollowed") continue;
    const who = e.follower.toLowerCase();
    if (e.name === "Followed") now.set(who, { source: e.sourceId.toLowerCase(), who: getAddress(e.follower) });
    else if (now.get(who)?.source === e.sourceId.toLowerCase()) now.delete(who);
    if (e.sourceId.toLowerCase() === sid) {
      if (e.name === "Followed") ever.add(who);
      lastBlock = e.log.blockNumber ?? lastBlock;
    }
  }
  return { current: [...now.values()].filter((v) => v.source === sid).map((v) => v.who), ever: ever.size, lastBlock };
}

/** A source someone followed, as its Followed event names it. */
export interface FollowedSource {
  sourceId: Hex;
  kind: SourceKindName;
  /** The trader's address as an integer, or the thesis id. */
  ref: bigint;
}

/** Every source that was ever followed, once each, in the order first followed. */
export function followedSources(events: readonly CopybookEvent[]): FollowedSource[] {
  const out = new Map<string, FollowedSource>();
  for (const e of events)
    if (e.name === "Followed" && !out.has(e.sourceId.toLowerCase())) out.set(e.sourceId.toLowerCase(), { sourceId: e.sourceId, kind: e.kind, ref: e.ref });
  return [...out.values()];
}

/** The traders among them, checksummed. */
export const followedTraders = (sources: readonly FollowedSource[]): Address[] =>
  sources.filter((s) => s.kind === "Trader").map((s) => getAddress(`0x${s.ref.toString(16).padStart(40, "0")}`));

/** Followers of one source as wallets: who follows now, and everyone who ever did. */
export interface FollowerSets {
  current: Address[];
  ever: Address[];
}

export function followerSets(events: readonly CopybookEvent[], sourceId: Hex): FollowerSets {
  const sid = sourceId.toLowerCase();
  const ever = new Map<string, Address>();
  for (const e of events) if (e.name === "Followed" && e.sourceId.toLowerCase() === sid) ever.set(e.follower.toLowerCase(), getAddress(e.follower));
  return { current: followersOf(events, sourceId).current, ever: [...ever.values()] };
}

/**
 * A server count brought up to date with events the page saw after it (live or backfilled): follows of this source
 * add a wallet, unfollows remove it, and a wallet that follows something else no longer follows this one.
 */
export function applyFollowDeltas(base: FollowerSets, events: readonly CopybookEvent[], sourceId: Hex, afterBlock: bigint): FollowerSets {
  const sid = sourceId.toLowerCase();
  const current = new Map(base.current.map((a) => [a.toLowerCase(), a]));
  const ever = new Map(base.ever.map((a) => [a.toLowerCase(), a]));
  for (const e of events) {
    if ((e.log.blockNumber ?? 0n) <= afterBlock) continue;
    if (e.name !== "Followed" && e.name !== "Unfollowed") continue;
    const who = e.follower.toLowerCase();
    const mine = e.sourceId.toLowerCase() === sid;
    if (e.name === "Followed") {
      if (mine) {
        current.set(who, getAddress(e.follower));
        ever.set(who, getAddress(e.follower));
      } else current.delete(who);
    } else if (mine) current.delete(who);
  }
  return { current: [...current.values()], ever: [...ever.values()] };
}

/** What the history route computes over the whole log, whatever window of events it returns. */
export interface HistorySummary {
  /** Every source ever followed. */
  sources: FollowedSource[];
  /** The traders among them. */
  followedTraders: Address[];
  /** With a `source` query: who follows it now, and everyone who ever did. */
  followers?: FollowerSets;
}

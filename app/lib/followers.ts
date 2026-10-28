import { getAddress, type Address, type Hex } from "viem";
import type { CopybookEvent } from "@copybook/sdk";

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

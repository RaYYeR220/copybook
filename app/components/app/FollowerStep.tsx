"use client";

import { useMemo } from "react";
import type { Hex } from "viem";
import { applyFollowDeltas, followerSets } from "@/lib/followers";
import { useHubFeed } from "./HubFeed";
import styles from "./SourceHead.module.css";

/**
 * How many wallets follow this source now. The history route counts them over the whole log; follows and unfollows
 * the page sees after that read are applied on top. While the log is partial the count is a floor.
 */
export function FollowerStep({ sourceId }: { sourceId: Hex }) {
  const feed = useHubFeed();
  const sets = useMemo(() => {
    const chain = [...feed.events].reverse();
    const base = feed.summary?.followers;
    // without the route's count (it did not answer), only what this page has seen can be counted
    return base && feed.summaryAt !== undefined ? applyFollowDeltas(base, chain, sourceId, feed.summaryAt) : followerSets(chain, sourceId);
  }, [feed.events, feed.summary, feed.summaryAt, sourceId]);
  const n = sets.current.length;
  const floor = !feed.complete || !feed.summary?.followers;
  let text: string;
  if (!feed.loaded) text = "counting followers";
  else if (feed.error && feed.events.length === 0) text = "followers unknown";
  else text = `${floor ? "at least " : ""}${n} following${sets.ever.length > n ? ` · ${sets.ever.length} ever` : ""}`;
  return (
    <span className={`${styles.step} ${n > 0 ? "" : styles.quiet}`} role="status" title="From the hub's Followed and Unfollowed events">
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

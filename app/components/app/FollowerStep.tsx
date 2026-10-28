"use client";

import { useMemo } from "react";
import type { Hex } from "viem";
import { followersOf } from "@/lib/followers";
import { useHubFeed } from "./HubFeed";
import styles from "./SourceHead.module.css";

/** How many wallets follow this source now, replayed from the hub's Followed and Unfollowed events. */
export function FollowerStep({ sourceId }: { sourceId: Hex }) {
  const feed = useHubFeed();
  const count = useMemo(() => followersOf([...feed.events].reverse(), sourceId), [feed.events, sourceId]);
  const n = count.current.length;
  let text: string;
  if (!feed.loaded) text = "counting followers";
  else if (feed.error && feed.events.length === 0) text = "followers unknown";
  else text = `${feed.complete ? "" : "at least "}${n} following${count.ever > n ? ` · ${count.ever} ever` : ""}`;
  return (
    <span className={`${styles.step} ${n > 0 ? "" : styles.quiet}`} role="status" title="From the hub's Followed and Unfollowed events">
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

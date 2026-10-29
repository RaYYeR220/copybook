"use client";

import Link from "next/link";
import { useMemo } from "react";
import { getAddress, type Address, type Hex } from "viem";
import { useHubFeed } from "@/components/app/HubFeed";
import { ShareOnX } from "@/components/share/ShareOnX";
import { fmtInt } from "@/lib/format";
import { followedSources } from "@/lib/followers";
import { latestCopy } from "@/lib/me/activity";
import { copyShareText, pageUrl, type ShareSource } from "@/lib/share";
import type { MarketMeta } from "@/lib/tape";
import styles from "./Me.module.css";

interface Props {
  who: Address;
  /** The site's base, for the link the post carries. */
  site: string;
  demoLeader: Address;
  markets: Record<string, MarketMeta>;
  theses: { id: string; name: string }[];
  /** The source this wallet follows now, read from the chain: names its copies before the feed reaches the Followed event. */
  following?: { sourceId: Hex; source: ShareSource };
}

const lc = (a: string) => a.toLowerCase();

/** This wallet's newest copy, linked to its page, with the post for X. Nothing when the feed holds no copy. */
export function LatestCopy({ who, site, demoLeader, markets, theses, following }: Props) {
  const feed = useHubFeed();
  const copy = useMemo(() => latestCopy(feed.events, who), [feed.events, who]);
  const source = useMemo((): ShareSource => {
    if (!copy) return null;
    if (following && lc(following.sourceId) === lc(copy.sourceId)) return following.source;
    const s = followedSources(feed.events).find((x) => lc(x.sourceId) === lc(copy.sourceId));
    if (!s) return null;
    if (s.kind === "Theme") return { kind: "Theme", themeId: s.ref, name: theses.find((t) => t.id === s.ref.toString())?.name ?? null };
    const trader = getAddress(`0x${s.ref.toString(16).padStart(40, "0")}`);
    return { kind: "Trader", trader, demo: lc(trader) === lc(demoLeader) };
  }, [copy, feed.events, theses, demoLeader, following]);
  if (!copy) return null;

  const sameBlock = copy.via === undefined ? undefined : copy.via === "handler";
  const meta = markets[lc(copy.pool)];
  const how = sameBlock === true ? "same block" : sameBlock === false ? "direct call · block" : "block";
  return (
    <div className={styles.latest}>
      <p className={styles.latestLine}>
        <span>Your latest copy</span>{" "}
        <Link href={copy.path} prefetch={false}>
          {meta ? `${meta.symbol}-PERP` : "copy"} · {how} #{fmtInt(copy.block)}
        </Link>
      </p>
      <ShareOnX text={copyShareText({ source, block: copy.block, sameBlock, mine: true })} url={pageUrl(site, copy.path)} subject="your latest copy" />
    </div>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/Badge";
import { Feed, FeedAside, FeedFigure, FeedReason, FeedRow } from "@/components/FeedRow";
import { SameBlockMark } from "@/components/SameBlockBadge";
import { fmtInt } from "@/lib/format";
import { followedSources, followedTraders } from "@/lib/followers";
import { followedOnly, sourceNames, tapeRow, type MarketMeta, type Segment, type TapeRow } from "@/lib/tape";
import { useHubFeed, type FeedStatus } from "./HubFeed";
import { Meta, PanelNote, Wide } from "./Panel";
import { DataState } from "./State";
import styles from "./LiveTape.module.css";

export interface TapeNames {
  markets: Record<string, MarketMeta>;
  /** Thesis ids as decimal strings. */
  theses: { id: string; name: string }[];
  /** lower-case trader address → label */
  traders: Record<string, string>;
  /** lower-case wallet address → label (the owner wallet) */
  wallets?: Record<string, string>;
}

function Seg({ s }: { s: Segment }) {
  if (s.t === "fig") return <FeedFigure>{s.v}</FeedFigure>;
  if (s.t === "aside") return <FeedAside>{s.v}</FeedAside>;
  if (s.t === "who")
    return s.href ? (
      <Link className={styles.who} href={s.href} title={s.title} prefetch={false}>
        {s.v}
      </Link>
    ) : (
      <span className={styles.who} title={s.title}>
        {s.v}
      </span>
    );
  return <>{s.v}</>;
}

function Row({ r }: { r: TapeRow }) {
  const mark = r.badge.sameBlock ? <SameBlockMark block={r.block} /> : <Badge tone={r.badge.tone}>{r.badge.text}</Badge>;
  // a copy's badge opens its own page, where its share card is
  const badge = r.share ? (
    <Link className={styles.share} href={r.share} prefetch={false} aria-label={`${r.badge.text}: open this copy's page and share card`}>
      {mark}
    </Link>
  ) : (
    mark
  );
  return (
    <FeedRow block={r.block} kind={r.kind} market={r.market} badge={badge} href={r.href} linkLabel={r.linkLabel}>
      {r.text.map((s, i) => (
        <Seg key={i} s={s} />
      ))}
      {r.reason && <FeedReason state={r.reason.state} reason={r.reason.reason} detail={r.reason.detail} />}
    </FeedRow>
  );
}

const STATUS: Record<FeedStatus, string> = {
  loading: "reading history",
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  stopped: "history only",
  paused: "paused while this tab is hidden",
};

/** The watcher's state and the block the feed has read to. */
export function FeedStatusLine({ extra }: { extra?: ReactNode }) {
  const feed = useHubFeed();
  return (
    <Meta>
      {extra && <Wide>{extra}</Wide>}
      <span className={`${styles.live} ${feed.status === "live" ? styles.on : ""}`} role="status">
        <i aria-hidden="true" />
        {STATUS[feed.status]}
        {feed.readTo !== undefined && feed.status !== "loading" && <> · read to blk #{fmtInt(feed.readTo)}</>}
      </span>
    </Meta>
  );
}

/** Rows of the page's hub feed, newest first: copies with their same-block badge, refusals by reason, verdicts. */
export function TapeRows({
  names,
  label,
  empty,
  first = 30,
  followed = false,
}: {
  names: TapeNames;
  label: string;
  empty: ReactNode;
  first?: number;
  /** Only followed sources: hub events, and reviews of traders someone follows. */
  followed?: boolean;
}) {
  const feed = useHubFeed();
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    // names and the followed set come from the whole log (the route's summary), plus follows seen since
    const seen = followedSources([...feed.events].reverse());
    const sources = [...(feed.summary?.sources ?? []), ...seen];
    const ctx = {
      markets: names.markets,
      traders: names.traders,
      wallets: names.wallets,
      sources: sourceNames(
        sources,
        names.theses.map((t) => ({ id: BigInt(t.id), name: t.name })),
        names.traders,
      ),
    };
    const keep = followed ? followedOnly(followedTraders(sources)) : () => true;
    return feed.events.filter(keep).map((e) => tapeRow(e, ctx)).filter((r): r is TapeRow => r !== null);
  }, [feed.events, feed.summary, names, followed]);

  if (!feed.loaded)
    return <DataState kind="loading" title="Reading Copybook's history from the chain…">The hub's and the risk gate's logs since deployment, read in 10,000-block segments.</DataState>;
  if (feed.error && rows.length === 0)
    return (
      <DataState kind="unavailable" title="The history route did not answer.">
        {feed.error}. New events still appear here as they land on chain.
      </DataState>
    );

  const shown = all ? rows : rows.slice(0, first);
  return (
    <>
      {rows.length === 0 ? (
        <DataState kind="empty" title={empty} />
      ) : (
        <Feed label={label}>
          {shown.map((r) => (
            <Row key={r.key} r={r} />
          ))}
        </Feed>
      )}
      {rows.length > shown.length && (
        <div className={styles.more}>
          <button type="button" className={styles.moreBtn} onClick={() => setAll(true)}>
            Show {rows.length - shown.length} older rows
          </button>
        </div>
      )}
      {!feed.complete && (
        <PanelNote>
          History is still being read: {feed.missing.length} block range{feed.missing.length === 1 ? "" : "s"} from #{fmtInt(feed.missing[0]?.from ?? 0n)} not covered yet. They fill in on the next load.
        </PanelNote>
      )}
      {feed.error && rows.length > 0 && <PanelNote>The last history read failed ({feed.error}); rows above are from earlier reads and the live watcher.</PanelNote>}
    </>
  );
}

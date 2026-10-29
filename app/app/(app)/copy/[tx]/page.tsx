import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { SameBlockBadge } from "@/components/SameBlockBadge";
import { NotFoundSource } from "@/components/app/NotFoundSource";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { SourceLedger, SourceLine, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { ShareLink } from "@/components/copy/ShareLink";
import styles from "@/components/copy/Copy.module.css";
import { TX_RE, parseLogIndex, type CopyView } from "@/lib/copy";
import { addressUrl, txUrl } from "@/lib/explorer";
import { fmtInt, shortHex } from "@/lib/format";
import { copyCardModel, type CardNames } from "@/lib/og/model";
import { config } from "@/lib/server/config";
import { copyOf } from "@/lib/server/copy";
import { cardNames } from "@/lib/server/og";
import { copyShareOf, copyShareText, pageUrl } from "@/lib/share";
import { currentSiteUrl } from "@/lib/siteUrl";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ tx: string }>; searchParams: Promise<{ log?: string | string[] }> };

type Read = { kind: "ok"; v: CopyView; names: CardNames } | { kind: "none" } | { kind: "error" };

async function read({ params, searchParams }: Props): Promise<Read> {
  const tx = (await params).tx;
  const log = parseLogIndex((await searchParams).log);
  if (!TX_RE.test(tx) || log === "invalid") return { kind: "none" };
  try {
    const [v, names] = await Promise.all([copyOf(tx, log), cardNames()]);
    return v ? { kind: "ok", v, names } : { kind: "none" };
  } catch {
    return { kind: "error" };
  }
}

const sharePath = (v: CopyView) => `/copy/${v.hash}?log=${v.logIndex}`;

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await read(props);
  if (r.kind !== "ok") return { title: "A copy", robots: { index: false } };
  const m = copyCardModel(r.v, r.names);
  const title = `${m.market} copy in block #${m.block}`;
  const description = m.sameBlock
    ? m.leader
      ? `Copied in the same block as the move it answers: the move is tx #${m.leader.index}, the copy tx #${m.copy.index}, in block #${m.block} on Somnia.`
      : `Copied by the hub's handler in the same block as the move it answers, block #${m.block} on Somnia.`
    : `A Copybook copy in block #${m.block} on Somnia, ${m.sentBy ?? "sent by the hub"}.`;
  const image = { url: `/og/copy/${r.v.hash}?log=${r.v.logIndex}`, width: 1200, height: 630, alt: `${title}: ${m.move}` };
  return {
    title,
    description,
    alternates: { canonical: sharePath(r.v) },
    openGraph: { title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function CopyPage(props: Props) {
  const r = await read(props);
  if (r.kind === "none") notFound();
  if (r.kind === "error")
    return (
      <NotFoundSource kick="A copy" title="Chain unreadable">
        The transaction could not be read from Somnia just now, so this copy is unknown, not missing. Reload in a moment.
      </NotFoundSource>
    );
  const { v, names } = r;
  const m = copyCardModel(v, names);
  const sourceHref = v.source?.kind === "Trader" ? `/t/${v.source.trader}` : v.source?.kind === "Theme" ? `/thesis/${v.source.themeId}` : null;
  const trigger = v.source?.kind === "Theme" ? "the registry's ThemeRebalanced event" : "the margin bank's PositionUpdated event";

  const rows: LedgerRow[] = [
    {
      label: "The move",
      value: v.leader ? (
        <a href={txUrl(v.leader.hash)} target="_blank" rel="noopener noreferrer" className="lnk">
          <b>tx #{v.leader.txIndex}</b> · {shortHex(v.leader.hash, 6, 4)} ↗
        </a>
      ) : (
        "—"
      ),
      note: v.leader
        ? `${trigger}, matched by its topics and data in this block`
        : v.via === "call"
          ? "a direct call answers no move"
          : "the handler ran in its block; the event it carried was not matched among this block's logs",
    },
    {
      label: "The copy",
      value: (
        <a href={txUrl(v.hash)} target="_blank" rel="noopener noreferrer" className="lnk">
          <b>tx #{v.txIndex}</b> · {shortHex(v.hash, 6, 4)} ↗
        </a>
      ),
      note: v.via === "handler" ? "sent by the hub's reactive handler, which Somnia validators run" : (m.sentBy ?? undefined),
    },
    {
      label: "Following",
      value: sourceHref ? (
        <Link href={sourceHref} className="lnk" prefetch={false}>
          {m.source}
        </Link>
      ) : (
        m.source
      ),
    },
    {
      label: "Follower",
      value: (
        <a href={addressUrl(v.follower)} target="_blank" rel="noopener noreferrer" className="lnk" title={v.follower}>
          {m.follower} ↗
        </a>
      ),
    },
    { label: "Limit price", value: m.limit, note: "the limit price of the order that moved the position, not the fill" },
  ];
  if (v.capped) rows.push({ label: "Capped", value: "yes", note: "the follower's cap per position clamped the size" });

  return (
    <AppMain label={`Copy in block ${m.block}`}>
      <Col>
        <Panel id="copy-h" order={1}>
          <SourceTop kick="A copy" step={m.sameBlock ? "same block" : "copied"} quiet={!m.sameBlock} />
          <SourceTitle id="copy-h">{m.market}</SourceTitle>
          <SourceLine>
            <span>{m.move}</span>
            <span> · {m.time}</span>
          </SourceLine>
          <div className={styles.badge}>
            {m.sameBlock ? (
              <SameBlockBadge block={v.block} href={txUrl(v.hash)} />
            ) : (
              <span className="mono">block #{m.block}</span>
            )}
          </div>
          <SourceLedger>
            <Ledger size="md" rows={rows} />
          </SourceLedger>
          <PanelNote>
            {m.sameBlock
              ? v.leader
                ? `Both transactions are in block #${m.block}: the move at position ${v.leader.txIndex}, the copy at ${v.txIndex}. The hub subscribes to the source through Somnia's reactivity, so validators run its handler inside the block the move lands in.`
                : `The hub's handler sent this copy, and Somnia's validators run a subscription's handler inside the block of the event that triggered it, so the move is in block #${m.block} too; its event was not matched among this block's logs.`
              : `This copy came from a ${v.call ?? "direct"} call to the hub, not from a move: a follow opens its book in its own transaction, and catchUp or resync bring a book back to the source.`}
          </PanelNote>
        </Panel>
      </Col>

      <Col>
        <Panel id="share-h" title="Share" aside={<Kick>card read from the chain</Kick>} order={2} d={0.05}>
          <div className={styles.figure}>
            {/* the card is a PNG drawn on the server from the same reads as this page */}
            <img className={styles.preview} src={`/og/copy/${v.hash}?log=${v.logIndex}`} width={1200} height={630} alt={`Share card: ${m.market} ${m.move}, block #${m.block}`} />
          </div>
          <ShareLink
            path={sharePath(v)}
            url={pageUrl(currentSiteUrl(), sharePath(v))}
            text={copyShareText({ ...copyShareOf(v, names), mine: false })}
            ownText={copyShareText({ ...copyShareOf(v, names), mine: true })}
            follower={v.follower}
          />
          <PanelNote>Paste the link anywhere that shows previews; the card above comes with it. Every figure on it is read from this transaction and its block.</PanelNote>
        </Panel>

        {v.siblings.length > 0 && (
          <Panel id="sib-h" title="In the same transaction" aside={<Kick>{`${v.siblings.length + 1} copies`}</Kick>} order={3} d={0.08}>
            <ul className={styles.siblings}>
              {v.siblings.map((s) => (
                <li key={s.logIndex}>
                  <Link href={`/copy/${v.hash}?log=${s.logIndex}`} prefetch={false}>
                    {names.markets[s.pool.toLowerCase()] ? `${names.markets[s.pool.toLowerCase()].symbol}-PERP` : shortHex(s.pool)} · log #{fmtInt(s.logIndex)}
                  </Link>
                </li>
              ))}
            </ul>
            <PanelNote>A thesis resizes every leg in one transaction; each leg is its own copy and its own card.</PanelNote>
          </Panel>
        )}

        <Colophon>
          Hub <b>{shortHex(config.deployments.hub)}</b> · log #{fmtInt(v.logIndex)} · Somnia Hideki testnet (Tokyo)
        </Colophon>
      </Col>
    </AppMain>
  );
}

import type { ReactNode } from "react";
import { fmtInt } from "@/lib/format";
import { ExplorerLink } from "./Badge";
import { GlyphExit, GlyphFollow, GlyphPaused, GlyphRefused, GlyphSame, GlyphUnfollow, GlyphVerdict } from "./glyphs";
import styles from "./FeedRow.module.css";

const GLYPHS = {
  same: GlyphSame,
  exit: GlyphExit,
  refused: GlyphRefused,
  paused: GlyphPaused,
  verdict: GlyphVerdict,
  follow: GlyphFollow,
  unfollow: GlyphUnfollow,
} as const;

export type FeedKind = keyof typeof GLYPHS;

interface FeedRowProps {
  /** The block the row's transaction landed in. The feed shows blocks, never wall-clock time. */
  block: number | bigint;
  kind: FeedKind;
  /** `BTC-PERP`, or `AI guard` for verdict rows. */
  market: string;
  /** The sentence: what the source did and what happened to your copy. */
  children: ReactNode;
  /** A `SameBlockMark` or a refused/verdict `Badge`. */
  badge: ReactNode;
  href: string;
  /** Names what the ↗ link opens. */
  linkLabel: string;
}

/** One transaction in the copy feed: block · glyph · market · sentence · badge · ↗. Renders an `<li>`. */
export function FeedRow({ block, kind, market, children, badge, href, linkLabel }: FeedRowProps) {
  const Glyph = GLYPHS[kind];
  return (
    <li className={`${styles.row} ${kind === "verdict" ? styles.verdict : ""}`}>
      <span className={styles.block} data-market={market}>
        #{fmtInt(block)}
      </span>
      <Glyph className={styles.glyph} />
      <span className={styles.market}>{market}</span>
      <span className={styles.text}>{children}</span>
      <span className={styles.badge}>{badge}</span>
      <span className={styles.ext}>
        <ExplorerLink href={href} label={linkLabel} />
      </span>
    </li>
  );
}

/** The list a run of `FeedRow`s sits in. */
export function Feed({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ol className={styles.feed} aria-label={label}>
      {children}
    </ol>
  );
}

/** A refused or stopped row's body: `REFUSED`, the reason in italic, then the mono detail. */
export function FeedReason({ state = "Refused", reason, detail }: { state?: "Refused" | "Paused"; reason: string; detail?: string }) {
  return (
    <>
      <span className={styles.state}>{state}</span>
      <span className={styles.why}>
        {reason}
        {detail && <span> · {detail}</span>}
      </span>
    </>
  );
}

/** Size or amount inside a feed sentence. */
export const FeedFigure = ({ children }: { children: ReactNode }) => <b className={styles.fig}>{children}</b>;

/** The italic aside, e.g. "exit, copied under BLOCK". */
export const FeedAside = ({ children }: { children: ReactNode }) => <i className={styles.aside}>{children}</i>;

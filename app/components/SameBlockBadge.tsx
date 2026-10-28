import { fmtInt } from "@/lib/format";
import { Badge, ExplorerLink } from "./Badge";
import { Meridian } from "./glyphs";
import styles from "./SameBlockBadge.module.css";

interface Props {
  /** The block both the source's move and the copy landed in. Required: the badge never shows without one. */
  block: number | bigint;
}

/** `same block #N` with the meridian glyph. Pair it with an explorer link (see `SameBlockBadge`). */
export function SameBlockMark({ block }: Props) {
  return <Badge icon={<Meridian />}>same block #{fmtInt(block)}</Badge>;
}

/** The same-block badge with its explorer link, for places that are not a feed row. */
export function SameBlockBadge({ block, href, label }: Props & { href: string; label?: string }) {
  return (
    <span className={styles.pair}>
      <SameBlockMark block={block} />
      <ExplorerLink href={href} label={label ?? `View the copy in block ${fmtInt(block)} on the Somnia explorer`} />
    </span>
  );
}

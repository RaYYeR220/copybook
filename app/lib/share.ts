import type { CopyView } from "./copy";
import { fmtInt, shortHex } from "./format";
import type { CardNames } from "./og/model";

/**
 * What a page puts in a post on X: short, plain sentences built from the figures the page itself shows, always
 * tagging the venue. The page's own address goes in the intent's `url`, so its card (the proof) comes with it.
 */

export const VENUE_HANDLE = "@DreamDEXSomnia";
/** X's limit for a post, in weighted characters. */
export const POST_LIMIT = 280;
/** X counts every link as a t.co link of this length, whatever its own length. */
export const LINK_WEIGHT = 23;

/** Code points X counts as one character (twitter-text v3); every other one counts as two. */
const LIGHT: readonly [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

/** A text's length as X counts it. Emoji sequences count per code point here, which is never less than X's count. */
export function weightedLength(text: string): number {
  let n = 0;
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

/** The post X composes from an intent: the text, a space, then the link. */
export const postLength = (text: string, withLink = true) => weightedLength(text) + (withLink ? 1 + LINK_WEIGHT : 0);

/** X's compose screen with the text and the link filled in. */
export const xIntentUrl = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

/** An absolute link to a page of the site. */
export const pageUrl = (site: string, path: string) => new URL(path, site).toString();

/** A name typed by a user, on one line. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The text `build` makes with `name`, the name cut short (with an ellipsis) only as far as the post needs to fit
 * with its link.
 */
function fitName(build: (name: string) => string, name: string): string {
  let chars = [...oneLine(name)];
  let text = build(chars.join(""));
  while (postLength(text) > POST_LIMIT && chars.length > 1) {
    chars = chars.slice(0, -1);
    text = build(`${chars.join("").trimEnd()}…`);
  }
  return text;
}

const legsText = (n: number) => `${fmtInt(n)} ${n === 1 ? "leg" : "legs"}`;

export type ShareSource =
  | { kind: "Trader"; trader: string; demo?: boolean }
  | { kind: "Theme"; themeId: bigint | number | string; name?: string | null }
  | null;

export interface CopyShare {
  /** What the copy follows; null when the hub's log has not named it. */
  source: ShareSource;
  block: bigint | number;
  /**
   * True when the hub's reactive handler sent the copy, inside the block of the move it answers; false for a direct
   * call to the hub; undefined when how it was sent is not known.
   */
  sameBlock: boolean | undefined;
  /** For a direct call: the hub function it ran (follow, catchUp, resync…), when known. */
  call?: string;
  /** The connected wallet is the follower whose copy it is. */
  mine: boolean;
}

/** A copy's facts as its page states them: who was copied, the block, and same block or the call that sent it. */
export function copyShareOf(v: CopyView, names: Pick<CardNames, "theses" | "demoLeader">): Omit<CopyShare, "mine"> {
  const s = v.source;
  const source: ShareSource =
    s?.kind === "Trader"
      ? { kind: "Trader", trader: s.trader, demo: s.trader.toLowerCase() === names.demoLeader.toLowerCase() }
      : s?.kind === "Theme"
        ? { kind: "Theme", themeId: s.themeId, name: names.theses[s.themeId.toString()] ?? null }
        : null;
  return { source, block: v.block, sameBlock: v.sameBlock, ...(v.call ? { call: v.call } : {}) };
}

/** A copy's post, saying only what its page says: same block, or the call that sent it. */
export function copyShareText(c: CopyShare): string {
  const build = (name?: string) => {
    const s = c.source;
    const who =
      s?.kind === "Trader"
        ? s.demo
          ? "the demo leader"
          : shortHex(s.trader)
        : s?.kind === "Theme"
          ? name
            ? `the thesis '${name}'`
            : `thesis #${s.themeId}`
          : null;
    const move = s?.kind === "Trader" ? "their trade" : s?.kind === "Theme" ? "its rebalance" : "the move it answers";
    const subject = `${c.mine ? "My copy" : "A copy"}${who ? ` of ${who}` : ""}`;
    const where = `block #${fmtInt(c.block)} on Somnia's Tokyo testnet`;
    if (c.sameBlock === true) return `${subject} landed in the same block as ${move}: ${where}, via Copybook on ${VENUE_HANDLE} perps.`;
    if (c.sameBlock === false) return `${subject} came from a ${c.call ?? "direct"} call to the Copybook hub, in ${where}, on ${VENUE_HANDLE} perps.`;
    return `${subject} is in ${where}, via Copybook on ${VENUE_HANDLE} perps.`;
  };
  const name = c.source?.kind === "Theme" ? c.source.name : null;
  return name ? fitName(build, name) : build();
}

/** A trader page's post; `own` when the connected wallet is the trader. */
export function traderShareText(x: { trader: string; demo?: boolean; own?: boolean }): string {
  if (x.own) return `Follow my trades on Copybook: copies land in the same block as mine on ${VENUE_HANDLE} perps (Somnia testnet).`;
  const who = x.demo ? `the demo leader ${shortHex(x.trader)}` : shortHex(x.trader);
  return `Follow ${who} on Copybook: copies land in their block on ${VENUE_HANDLE} perps (Somnia testnet).`;
}

/** A thesis page's post; `own` when the connected wallet created the thesis. A blank name falls back to its id. */
export function thesisShareText(x: { id: bigint | number | string; name: string; legs: number; own?: boolean }): string {
  const build = (name: string) =>
    `Follow ${x.own ? "my thesis" : "the thesis"} ${name ? `'${name}'` : `#${x.id}`} on Copybook: ${legsText(x.legs)}, opened in one transaction on ${VENUE_HANDLE} perps.`;
  return fitName(build, x.name);
}

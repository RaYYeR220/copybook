import { decodeErrorResult, getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import { engineErrorsAbi, eventKey, type CopybookEvent, type TierName } from "@copybook/sdk";
import { txUrl } from "./explorer";
import { fmtInt, shortHex } from "./format";
import { REASON_LABEL } from "./reasons";
import type { LoggedEvent } from "./events";
import { fmtPrice18, fmtUnits } from "./units";

export interface MarketMeta {
  /** `BTC` */
  symbol: string;
  decimals: number;
}

/** What the tape knows to name things with. Keys are lower-case. */
export interface TapeContext {
  markets: Record<string, MarketMeta>;
  /** sourceId → how to name the source. */
  sources: Record<string, { label: string; href?: string }>;
  /** trader address → a label (the demo leader). */
  traders: Record<string, string>;
  /** Other known wallets → a label (the owner wallet). */
  wallets?: Record<string, string>;
}

export type Segment =
  | { t: "text"; v: string }
  | { t: "fig"; v: string }
  | { t: "aside"; v: string }
  | { t: "who"; v: string; href?: string; title?: string };

export type RowKind = "same" | "exit" | "refused" | "paused" | "verdict" | "follow" | "unfollow";

export interface TapeRow {
  key: string;
  block: bigint;
  kind: RowKind;
  market: string;
  text: Segment[];
  /** Refused or stopped rows: `REFUSED`, the reason name verbatim, then the mono detail. */
  reason?: { state: "Refused" | "Paused"; reason: string; detail?: string };
  badge: { tone: "gold" | "refused" | "verdict"; text: string; sameBlock?: true };
  href: string;
  linkLabel: string;
}

export const TIER_LABEL: Record<TierName, string> = { None: "NOT REVIEWED", Ok: "OK", Caution: "CAUTION", Block: "BLOCK" };

const lc = (s: string) => s.toLowerCase();

/** `BTC-PERP`, or the pool's short address when the indexer did not name it. */
export const marketName = (ctx: TapeContext, pool: Address) => {
  const m = ctx.markets[lc(pool)];
  return m ? `${m.symbol}-PERP` : shortHex(pool);
};

/** Errors a dreamDEX perp pool answers a copied order with (the engine maps two of them to Band). */
const venueErrorsAbi = [
  ...parseAbi([
    "error FillOrKillNotFillable()",
    "error ImmediateOrCancelNoFill()",
    "error OperatorNotApproved()",
    "error OrderAlreadyExpired()",
    "error InvalidQuantity()",
    "error InvalidPrice()",
  ]),
  ...engineErrorsAbi,
] as Abi;

/** A venue error's name (`FillOrKillNotFillable`) from its revert data, or its selector when unknown. */
export function venueErrorName(data: Hex): string | undefined {
  if (!data || data === "0x") return undefined;
  try {
    return decodeErrorResult({ abi: venueErrorsAbi, data }).errorName;
  } catch {
    return data.slice(0, 10);
  }
}

const sideOf = (x: bigint) => (x > 0n ? "long" : x < 0n ? "short" : "");
function position(x: bigint, m: MarketMeta | undefined): string {
  if (x === 0n) return "0";
  const abs = x < 0n ? -x : x;
  return m ? `${fmtUnits(abs, m.decimals)} ${sideOf(x)}` : `${abs.toString()} units ${sideOf(x)}`;
}

/** Less exposure on the same side (or flat): an exit, which is always copied. */
export const isExit = (from: bigint, to: bigint) => {
  if (isFlip(from, to)) return false;
  const a = from < 0n ? -from : from;
  const b = to < 0n ? -to : to;
  return b < a;
};

/** From long to short or back: an exit and new size on the other side in one order. */
export const isFlip = (from: bigint, to: bigint) => (from > 0n && to < 0n) || (from < 0n && to > 0n);

const who = (ctx: TapeContext, a: Address): Segment => {
  const label = ctx.traders[lc(a)];
  return { t: "who", v: label ? `${label} ${shortHex(a)}` : shortHex(a), href: `/t/${getAddress(a)}`, title: getAddress(a) };
};
/** A wallet that is not a source: a follower, a requester. Named when the context knows it (the owner wallet). */
const follower = (ctx: TapeContext, a: Address): Segment => {
  const label = ctx.wallets?.[lc(a)];
  return { t: "who", v: label ? `${label} ${shortHex(a)}` : shortHex(a), title: getAddress(a) };
};
const source = (ctx: TapeContext, sid: Hex): Segment => {
  const s = ctx.sources[lc(sid)];
  return s ? { t: "who", v: s.label, href: s.href } : { t: "who", v: `source ${shortHex(sid)}` };
};

/** One tape row for an event, or null for bookkeeping the tape does not show (tank charges, relay groups, owner calls). */
export function tapeRow(e: LoggedEvent, ctx: TapeContext): TapeRow | null {
  const block = e.log.blockNumber;
  const hash = e.log.transactionHash;
  if (block === undefined || !hash) return null; // a row always names its block and its transaction
  const n = `#${fmtInt(block)}`;
  const base = { key: eventKey(e), block, href: txUrl(hash) };
  const t = (v: string): Segment => ({ t: "text", v });

  switch (e.name) {
    case "Copied": {
      const m = ctx.markets[lc(e.pool)];
      const exit = isExit(e.fromSize, e.toSize);
      const text: Segment[] = [follower(ctx, e.follower), t(" copied "), source(ctx, e.sourceId), t(" · "), { t: "fig", v: `${position(e.fromSize, m)} → ${position(e.toSize, m)}` }];
      if (e.limitPrice > 0n) text.push(t(` · limit ${fmtPrice18(e.limitPrice)}`));
      if (exit) text.push(t(" · "), { t: "aside", v: "exit, always copied" });
      else if (isFlip(e.fromSize, e.toSize)) text.push(t(" · "), { t: "aside", v: e.capped ? "flipped side, capped" : "flipped side" });
      else if (e.capped) text.push(t(" · "), { t: "aside", v: "capped by the follower's limits" });
      const same = e.via === "handler";
      return {
        ...base,
        kind: exit ? "exit" : "same",
        market: marketName(ctx, e.pool),
        text,
        badge: same ? { tone: "gold", text: `same block ${n}`, sameBlock: true } : { tone: "verdict", text: e.via === "call" ? `direct call · ${n}` : `block ${n}` },
        linkLabel: same ? `View the copy in block ${fmtInt(block)} on the Somnia explorer` : `View the copy transaction in block ${fmtInt(block)}`,
      };
    }
    case "Refused":
      return {
        ...base,
        kind: "refused",
        market: marketName(ctx, e.pool),
        text: [follower(ctx, e.follower), t(" copying "), source(ctx, e.sourceId), t(" → ")],
        reason: { state: "Refused", reason: REASON_LABEL[e.reason === "None" ? "VenueRejected" : e.reason], detail: venueErrorName(e.venueError) },
        badge: { tone: "refused", text: `Refused · ${n}` },
        linkLabel: `View the refusal in block ${fmtInt(block)}`,
      };
    case "Stopped":
      return {
        ...base,
        kind: "paused",
        market: "Stop",
        text: [follower(ctx, e.follower), t(" → ")],
        reason: { state: "Paused", reason: REASON_LABEL.EquityFloor, detail: `equity under the floor · resume lifts it` },
        badge: { tone: "refused", text: `Stopped · ${n}` },
        linkLabel: `View the stop in block ${fmtInt(block)}`,
      };
    case "Deferred":
      return {
        ...base,
        kind: "paused",
        market: "Deferred",
        text: [follower(ctx, e.follower), t(" copying "), source(ctx, e.sourceId), t(" → ")],
        reason: { state: "Paused", reason: "Deferred", detail: "the handler ran out of gas · catchUp finishes it" },
        badge: { tone: "refused", text: `Deferred · ${n}` },
        linkLabel: `View the deferral in block ${fmtInt(block)}`,
      };
    case "FlattenIncomplete":
      return {
        ...base,
        kind: "paused",
        market: marketName(ctx, e.pool),
        text: [follower(ctx, e.follower), t(" → ")],
        reason: { state: "Paused", reason: "Closes unfinished", detail: "poke finishes them" },
        badge: { tone: "refused", text: `Stopped · ${n}` },
        linkLabel: `View the transaction in block ${fmtInt(block)}`,
      };
    case "Followed":
      return {
        ...base,
        kind: "follow",
        market: "Follow",
        text: [follower(ctx, e.follower), t(" followed "), source(ctx, e.sourceId)],
        badge: { tone: "verdict", text: `Followed · ${n}` },
        linkLabel: `View the follow in block ${fmtInt(block)}`,
      };
    case "Unfollowed":
      return {
        ...base,
        kind: "unfollow",
        market: "Unfollow",
        text: [follower(ctx, e.follower), t(" unfollowed "), source(ctx, e.sourceId), t(" · "), { t: "aside", v: e.flattened ? "positions closed" : "positions kept" }],
        badge: { tone: "verdict", text: `Unfollowed · ${n}` },
        linkLabel: `View the unfollow in block ${fmtInt(block)}`,
      };
    case "PolicyUpdated":
    case "Resumed":
      return {
        ...base,
        kind: "follow",
        market: "Policy",
        text: [follower(ctx, e.follower), t(e.name === "Resumed" ? " resumed copying" : " updated the policy")],
        badge: { tone: "verdict", text: n },
        linkLabel: `View the transaction in block ${fmtInt(block)}`,
      };
    case "GuardSet":
      return {
        ...base,
        kind: "verdict",
        market: "AI guard",
        text: [follower(ctx, e.follower), t(" turned the AI guard "), { t: "fig", v: e.on ? "on" : "off" }],
        badge: { tone: "verdict", text: `GuardSet · ${n}` },
        linkLabel: `View the guard change in block ${fmtInt(block)}`,
      };
    case "VerdictReceived":
      return {
        ...base,
        kind: "verdict",
        market: "AI guard",
        text: [t("Committee verdict "), { t: "fig", v: TIER_LABEL[e.tier] }, t(" for "), who(ctx, e.trader), ...(e.tier === "Block" ? [t(" · "), { t: "aside", v: "no new size for guarded followers" } as Segment] : [])],
        badge: { tone: "verdict", text: "RiskVerdict · on-chain" },
        linkLabel: `View the verdict's arrival in block ${fmtInt(block)}`,
      };
    case "BlockHeld":
      return {
        ...base,
        kind: "verdict",
        market: "AI guard",
        text: [t("A milder verdict, "), { t: "fig", v: TIER_LABEL[e.newTier] }, t(", came in during the hold · the BLOCK on "), who(ctx, e.trader), t(" stands")],
        badge: { tone: "verdict", text: "BlockHeld · on-chain" },
        linkLabel: `View the held verdict in block ${fmtInt(block)}`,
      };
    case "ReviewRequested":
      return {
        ...base,
        kind: "verdict",
        market: "AI guard",
        text: [t(`Review #${e.nonce} of `), who(ctx, e.trader), t(" asked by "), follower(ctx, e.requester)],
        badge: { tone: "verdict", text: `Requested · ${n}` },
        linkLabel: `View the review request in block ${fmtInt(block)}`,
      };
    case "ReviewFailed":
      return {
        ...base,
        kind: "verdict",
        market: "AI guard",
        text: [t(`Review #${e.nonce} of `), who(ctx, e.trader), t(" returned no verdict · the stored one stands")],
        badge: { tone: "verdict", text: `ReviewFailed · ${n}` },
        linkLabel: `View the failed review in block ${fmtInt(block)}`,
      };
    default:
      return null;
  }
}

const TRADER_EVENTS = new Set(["ReviewRequested", "VerdictReceived", "ReviewFailed", "StaleVerdict", "BlockHeld"]);

/**
 * The tape of followed sources: every hub event, follower-level guard changes, and reviews only of traders someone
 * follows (or followed). Reviews of traders nobody copies are the trader pages' business, not the tape's.
 */
export function followedOnly(events: readonly CopybookEvent[]): (e: CopybookEvent) => boolean {
  const traders = new Set<string>();
  for (const e of events) if (e.name === "Followed" && e.kind === "Trader") traders.add(`0x${e.ref.toString(16).padStart(40, "0")}`);
  return (e) => !TRADER_EVENTS.has(e.name) || ("trader" in e && traders.has(lc(e.trader)));
}

/** Newest first, one entry per `txHash:logIndex`; a copy that learned how it was sent replaces its bare twin. */
export function mergeFeed(prev: readonly LoggedEvent[], incoming: readonly LoggedEvent[], cap = 200): LoggedEvent[] {
  const byKey = new Map<string, LoggedEvent>();
  for (const e of prev) byKey.set(eventKey(e), e);
  for (const e of incoming) {
    const k = eventKey(e);
    const had = byKey.get(k);
    if (!had || (had.via === undefined && e.via !== undefined)) byKey.set(k, e);
  }
  const out = [...byKey.values()].filter((e) => e.log.blockNumber !== undefined);
  out.sort(
    (a, b) =>
      Number(b.log.blockNumber! - a.log.blockNumber!) ||
      (b.log.transactionIndex ?? 0) - (a.log.transactionIndex ?? 0) ||
      (b.log.logIndex ?? 0) - (a.log.logIndex ?? 0),
  );
  return out.slice(0, cap);
}

/**
 * Names for sources the tape mentions: traders by address (the demo leader labelled as ours), theses by name.
 * Built from the Followed events themselves, so every followed source gets a name.
 */
export function sourceNames(
  events: readonly CopybookEvent[],
  theses: readonly { id: bigint; name: string }[],
  traderLabels: Record<string, string>,
): TapeContext["sources"] {
  const out: TapeContext["sources"] = {};
  const thesis = new Map(theses.map((t) => [t.id.toString(), t.name]));
  for (const e of events) {
    if (e.name !== "Followed") continue;
    const sid = lc(e.sourceId);
    if (out[sid]) continue;
    if (e.kind === "Theme") {
      const name = thesis.get(e.ref.toString());
      out[sid] = { label: name ? `thesis “${name}”` : `thesis #${e.ref}`, href: `/thesis/${e.ref}` };
    } else {
      const a = getAddress(`0x${e.ref.toString(16).padStart(40, "0")}`);
      const label = traderLabels[lc(a)];
      out[sid] = { label: label ? `${label} ${shortHex(a)}` : shortHex(a), href: `/t/${a}` };
    }
  }
  return out;
}

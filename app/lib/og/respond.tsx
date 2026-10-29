import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { sourceIdOf, type Leg, type TierName } from "@copybook/sdk";
import type { TraderStats } from "@copybook/stats";
import type { CopyView } from "../copy";
import { CARD, CopyCard, ThesisCard, TraderCard } from "./cards";
import { ogFonts, type OgFont } from "./fonts";
import { copyCardModel, thesisCardModel, traderCardModel, type CardNames, type FollowerFigure } from "./model";

/** Past copies never change; trader and thesis figures move, so the edge keeps those for five minutes. */
export const CACHE_IMMUTABLE = "public, max-age=86400, s-maxage=31536000, immutable";
export const CACHE_LIVE = "public, max-age=300, s-maxage=300, stale-while-revalidate=3600";
/** A transaction may not have landed yet: "no copy" is kept for a minute only. */
const CACHE_MISSING = "public, max-age=0, s-maxage=60";

/**
 * A copy's card is kept for good only when every name on it resolved (a market or thesis name the indexer or
 * registry did not give this time would otherwise stay missing); a view still waiting on the hub's log is not kept.
 */
export const copyCardCache = (m: { resolved: boolean; complete: boolean }) => (m.resolved ? CACHE_IMMUTABLE : m.complete ? CACHE_LIVE : "no-store");

/**
 * A share card as a PNG response. `load` returns null for nothing to draw (a 404, never a made-up card) and throws
 * when the chain or indexer cannot be read (a 502, not cached).
 */
export async function cardResponse<T>(
  load: () => Promise<T | null>,
  draw: (d: T) => ReactElement,
  opts: { cache: string | ((d: T) => string); fonts?: () => Promise<OgFont[]> },
): Promise<Response> {
  let data: T | null;
  try {
    data = await load();
  } catch (err) {
    console.error("share card read failed", err instanceof Error ? err.message : err);
    return new Response("The chain or the indexer did not answer; no card was drawn.", { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  if (data === null) return new Response("Nothing here to draw a card of.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": CACHE_MISSING } });
  const fonts = await (opts.fonts ?? ogFonts)();
  return new ImageResponse(draw(data), {
    ...CARD,
    fonts,
    headers: { "cache-control": typeof opts.cache === "function" ? opts.cache(data) : opts.cache },
  });
}

/** What the trader and thesis cards read besides their own source. */
export interface CardDeps {
  names(): Promise<CardNames>;
  /** Wallets following a source now, from the hub's log; null when the log could not be read. */
  followers(sourceId: `0x${string}`): Promise<FollowerFigure | null>;
  now(): number;
}

export const copyCard = (hash: string, logIndex: number | undefined, deps: { copy(hash: string, log: number | undefined): Promise<CopyView | null>; names(): Promise<CardNames> }) =>
  cardResponse(
    async () => {
      const v = await deps.copy(hash, logIndex);
      return v ? copyCardModel(v, await deps.names()) : null;
    },
    (m) => <CopyCard m={m} />,
    { cache: copyCardCache },
  );

const parseTrader = (raw: string): Address | null => (raw.length === 42 && isAddress(raw, { strict: false }) ? getAddress(raw) : null);

export const traderCard = (
  raw: string,
  deps: CardDeps & { stats(t: Address): Promise<TraderStats>; verdict(t: Address): Promise<{ tier: TierName; blocking: boolean }> },
) =>
  cardResponse(
    async () => {
      const trader = parseTrader(raw);
      if (!trader) return null;
      const [names, stats, verdict, followers] = await Promise.all([
        deps.names(),
        deps.stats(trader).catch(() => null),
        deps.verdict(trader).catch(() => null),
        deps.followers(sourceIdOf("Trader", trader)).catch(() => null),
      ]);
      return traderCardModel({ trader, demoLeader: names.demoLeader, stats, verdict, followers, now: deps.now() });
    },
    (m) => <TraderCard m={m} />,
    { cache: CACHE_LIVE },
  );

const ID_RE = /^[0-9]{1,9}$/;

export const thesisCard = (
  raw: string,
  deps: CardDeps & { thesis(id: bigint): Promise<{ name: string; version: number; creator: Address; legs: Leg[]; minimum: bigint | null } | null> },
) =>
  cardResponse(
    async () => {
      // one card per thesis: "01" or "001" is not another address for #1
      if (!ID_RE.test(raw) || BigInt(raw) === 0n || BigInt(raw).toString() !== raw) return null;
      const id = BigInt(raw);
      const t = await deps.thesis(id); // throws when the registry cannot be read: a 502, not a 404
      if (!t) return null;
      const [names, followers] = await Promise.all([deps.names(), deps.followers(sourceIdOf("Theme", id)).catch(() => null)]);
      return thesisCardModel({ id, ...t, names, followers, now: deps.now() });
    },
    (m) => <ThesisCard m={m} />,
    { cache: CACHE_LIVE },
  );

import type { Address } from "viem";
import type { Leg } from "@copybook/sdk";

/**
 * Positions the follower already holds that a follow would take over. The hub syncs every market it manages to
 * the source's size (scaled, capped), whoever opened the position there: a listed market or a thesis leg in the
 * follow transaction itself, a whole-book follow's market at the trader's next move there (or a catchUp). A
 * position there is resized, or closed when the source is flat.
 */

export interface HeldPosition {
  pool: Address;
  side: "long" | "short";
  size: bigint;
  decimals: number | null;
  market: string | null;
}

export type TakeoverWhen =
  /** The follow transaction syncs this market. */
  | "now"
  /** A whole-book follow: the trader holds this market now, so their next move there (or a catchUp) syncs it. */
  | "next-move"
  /** A whole-book follow: only if the trader trades this market while followed. */
  | "if-traded";

export interface Takeover {
  position: HeldPosition;
  when: TakeoverWhen;
}

export interface FollowScope {
  kind: "Trader" | "Theme";
  /** Trader follows: whole book, or the listed markets. */
  allowAll?: boolean;
  joinPools?: readonly Address[];
  /** Trader follows: the markets the trader holds now (null when the indexer did not answer). */
  traderHeld?: readonly Address[] | null;
  /** Thesis follows: the legs. */
  legs?: readonly Leg[];
}

const lc = (a: string) => a.toLowerCase();

export function takeovers(scope: FollowScope, mine: readonly HeldPosition[]): Takeover[] {
  const out: Takeover[] = [];
  if (scope.kind === "Theme") {
    const legs = new Set((scope.legs ?? []).map((l) => lc(l.pool)));
    for (const p of mine) if (legs.has(lc(p.pool))) out.push({ position: p, when: "now" });
    return out;
  }
  if (!scope.allowAll) {
    const listed = new Set((scope.joinPools ?? []).map(lc));
    for (const p of mine) if (listed.has(lc(p.pool))) out.push({ position: p, when: "now" });
    return out;
  }
  const held = new Set((scope.traderHeld ?? []).map(lc));
  for (const p of mine) out.push({ position: p, when: held.has(lc(p.pool)) ? "next-move" : "if-traded" });
  // the ones the hub reaches first, first
  return out.sort((a, b) => (a.when === b.when ? 0 : a.when === "next-move" ? -1 : 1));
}

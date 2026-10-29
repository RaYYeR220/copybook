import { encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { minThemeAllocation, isTradeable, withHeadroom, type Leg, type Market, type ThemeMinimum } from "@copybook/sdk";
import type { RegistryRules } from "./basket";

/** The registry's public constants and the margin bank it asks `isPerpPoolRegistered`. */
export const registryAbi = parseAbi([
  "function MAX_LEGS() view returns (uint256)",
  "function MAX_GROSS_BPS() view returns (uint256)",
  "function MIN_LEG_WEIGHT_BPS() view returns (uint256)",
  "function MIN_REBALANCE_INTERVAL() view returns (uint256)",
  "function marginBank() view returns (address)",
]);

export const bankRegistryAbi = parseAbi(["function isPerpPoolRegistered(address perpPool) view returns (bool)"]);

/** The limits the deployed registry enforces, read from its constants. */
export async function readRegistryRules(client: Pick<PublicClient, "readContract">, themes: Address): Promise<RegistryRules> {
  const r = (functionName: "MAX_LEGS" | "MAX_GROSS_BPS" | "MIN_LEG_WEIGHT_BPS" | "MIN_REBALANCE_INTERVAL") =>
    client.readContract({ address: themes, abi: registryAbi, functionName }).then(Number);
  const [maxLegs, maxGrossBps, minLegWeightBps, minRebalanceInterval] = await Promise.all([r("MAX_LEGS"), r("MAX_GROSS_BPS"), r("MIN_LEG_WEIGHT_BPS"), r("MIN_REBALANCE_INTERVAL")]);
  return { maxLegs, maxGrossBps, minLegWeightBps, minRebalanceInterval };
}

/**
 * Storage slot of `_themes[id]`'s first word. ThemeRegistry has no base contract; its constants and the immutable
 * `marginBank` take no slot, so `themeCount` is slot 0 and `_themes` slot 1. The first word of a `Theme` packs
 * `creator` (20 bytes), `version` (4) and `updatedAt` (8), low bytes first.
 */
export const themeSlot = (id: bigint): Hex => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [id, 1n]));

export function decodeThemeWord(word: Hex): { creator: Address; version: number; updatedAt: number } {
  const w = BigInt(word);
  return {
    creator: getAddress(`0x${(w & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`),
    version: Number((w >> 160n) & 0xffff_ffffn),
    updatedAt: Number((w >> 192n) & 0xffff_ffff_ffff_ffffn),
  };
}

/**
 * When a thesis last changed (creation or rebalance), as the registry stored it. No view returns it, so it is read
 * from storage, and trusted only when the same word also holds the creator and version `themeOf` returns: a
 * different layout gives null, never a wrong clock.
 */
export async function readUpdatedAt(
  client: Pick<PublicClient, "getStorageAt">,
  themes: Address,
  id: bigint,
  expect: { creator: Address; version: number },
): Promise<number | null> {
  const word = await client.getStorageAt({ address: themes, slot: themeSlot(id) });
  if (!word) return null;
  const d = decodeThemeWord(word);
  if (d.creator.toLowerCase() !== expect.creator.toLowerCase() || d.version !== expect.version || d.updatedAt === 0) return null;
  return d.updatedAt;
}

/** One leg's market as the builder holds it: read, failed, or not read yet (absent). */
export type MarketRead = { status: "ok"; market: Market } | { status: "error" };

export type BasketMinimum =
  | { status: "empty" }
  | { status: "reading"; pools: Address[] }
  | { status: "unavailable"; pools: Address[]; why: "unreadable" | "untradeable" }
  | { status: "ok"; minimum: ThemeMinimum; recommended: bigint };

/**
 * The least allocation that opens every leg of a basket at the marks read, with 10% headroom: the SDK's
 * `minThemeAllocation`, the same figure `themeMinimum` gives for a published thesis. Legs with no weight are left
 * out (they cannot be published either).
 */
export function basketMinimum(legs: readonly Leg[], reads: Record<string, MarketRead | undefined>): BasketMinimum {
  const weighted = legs.filter((l) => l.weightBps !== 0);
  if (weighted.length === 0) return { status: "empty" };
  const reading = weighted.filter((l) => !reads[l.pool.toLowerCase()]).map((l) => l.pool);
  const failed = weighted.filter((l) => reads[l.pool.toLowerCase()]?.status === "error").map((l) => l.pool);
  if (failed.length) return { status: "unavailable", pools: failed, why: "unreadable" };
  if (reading.length) return { status: "reading", pools: reading };
  const map = new Map<string, Market>();
  for (const l of weighted) map.set(l.pool.toLowerCase(), (reads[l.pool.toLowerCase()] as { market: Market }).market);
  const bad = weighted.filter((l) => !isTradeable(map.get(l.pool.toLowerCase())!)).map((l) => l.pool);
  if (bad.length) return { status: "unavailable", pools: bad, why: "untradeable" };
  // a market twice is refused anyway (DuplicatePool); its figure is the larger weight's
  const minimum = minThemeAllocation(weighted, map);
  return { status: "ok", minimum, recommended: withHeadroom(minimum.allocation) };
}

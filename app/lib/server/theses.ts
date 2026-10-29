import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import type { Address } from "viem";
import type { Market, Theme, ThemeMinimum } from "@copybook/sdk";
import { copybook } from "./chain";

export interface ThesisMinimum extends ThemeMinimum {
  /** The minimum with 10% headroom, for marks that move between the quote and the open. */
  recommended: bigint;
  markets: Market[];
}

export interface Thesis extends Theme {
  /** Null when a leg's market could not be read (or reports no usable mark): no minimum is shown then. */
  minimum: ThesisMinimum | null;
}

async function minimumOf(id: bigint): Promise<ThesisMinimum | null> {
  try {
    const m = await copybook.themeMinimum(id);
    return { allocation: m.allocation, bindingPool: m.bindingPool, maxNotional: m.maxNotional, perLeg: m.perLeg, recommended: m.recommendedAllocation, markets: m.markets };
  } catch {
    return null;
  }
}

/** Every thesis in the ThemeRegistry with its minimum at live marks. Throws when the registry cannot be read. */
export async function loadTheses(): Promise<Thesis[]> {
  const themes = await copybook.themes();
  return Promise.all(themes.map(async (t) => ({ ...t, minimum: await minimumOf(t.id) })));
}

/**
 * One thesis, or null when the registry has no such id. Throws when the registry cannot be read. Read once per
 * request: the page and its metadata share it.
 */
export const loadThesis = cache(async (id: bigint): Promise<Thesis | null> => {
  const count = await copybook.themeCount();
  if (id < 1n || id > count) return null;
  const theme = await copybook.theme(id);
  return { ...theme, minimum: await minimumOf(id) };
});

/** Thesis ids (decimal) and names, for naming sources: no market reads, 15 s cache. */
export const thesisNames: () => Promise<{ id: string; name: string }[]> = unstable_cache(
  async () => (await copybook.themes()).map((t) => ({ id: t.id.toString(), name: t.name })),
  ["thesis-names"],
  { revalidate: 15 },
);

export const isOwner = (a: Address, owner: Address) => a.toLowerCase() === owner.toLowerCase();

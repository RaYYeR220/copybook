import "server-only";
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

/** One thesis, or null when the registry has no such id. Throws when the registry cannot be read. */
export async function loadThesis(id: bigint): Promise<Thesis | null> {
  const count = await copybook.themeCount();
  if (id < 1n || id > count) return null;
  const theme = await copybook.theme(id);
  return { ...theme, minimum: await minimumOf(id) };
}

export const isOwner = (a: Address, owner: Address) => a.toLowerCase() === owner.toLowerCase();

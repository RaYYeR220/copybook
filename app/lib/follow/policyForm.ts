import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { BPS, MAX_JOIN_POOLS, type Policy, type SourceKindName } from "@copybook/sdk";

/**
 * The policy form: what the person types, parsed into the hub's `Policy` with the same ranges `PolicyLib.validate`
 * enforces. Field errors come first and stop the preflight from running; the preflight then checks the venue.
 */

export interface PolicyFormValues {
  /** Trader follows: size multiplier, `1` = 1x. */
  scale: string;
  /** Thesis follows: USD the weights apply to. */
  allocation: string;
  /** USD, the largest position the hub may build in one market. */
  maxNotional: string;
  /** USD, the largest whole book; empty or 0 is no cap. */
  maxTotalNotional: string;
  /** Percent, how far inside the mark an increase may be priced. */
  band: string;
  /** USD, below this equity the follow stops and closes; empty or 0 is off. */
  equityFloor: string;
  /** Trader follows: mirror every market the trader trades. */
  allowAll: boolean;
  /** Trader follows with allowAll off: the markets to manage. */
  pools: Address[];
}

export type FormField = Exclude<keyof PolicyFormValues, "allowAll"> | "markets";

export interface FieldError {
  field: FormField;
  message: string;
}

export interface ParsedPolicy {
  policy?: Policy;
  joinPools: Address[];
  errors: FieldError[];
}

export const MAX_SCALE_BPS = 100_000;
export const MAX_BAND_BPS = 500;

const clean = (s: string) => s.trim().replace(/^\$/, "").replace(/,/g, "").trim();
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** A plain decimal in `decimals` fixed places, or null when it is not one (or has more places than that). */
export function parseFixed(s: string, decimals: number): bigint | null {
  const v = clean(s);
  if (!DECIMAL.test(v)) return null;
  const [, frac = ""] = v.split(".");
  if (frac.length > decimals) return null;
  return parseUnits(v.endsWith(".") ? `${v}0` : v, decimals);
}

/** USD (or STT) as an 18-decimal amount; up to six decimals typed. */
export const parseAmount18 = (s: string): bigint | null => {
  const six = parseFixed(s, 6);
  return six === null ? null : six * 10n ** 12n;
};

/** An empty field means zero for the optional caps. */
const optionalAmount = (s: string): bigint | null => (clean(s) === "" ? 0n : parseAmount18(s));

export function parsePolicyForm(kind: SourceKindName, v: PolicyFormValues): ParsedPolicy {
  const errors: FieldError[] = [];
  const err = (field: FormField, message: string) => errors.push({ field, message });

  let scaleBps = 0;
  let allocation = 0n;
  if (kind === "Trader") {
    const s = parseFixed(v.scale, 4);
    if (s === null) err("scale", "Type the size multiplier as a number, like 1 or 0.5 (up to four decimals).");
    else if (s <= 0n || s > BigInt(MAX_SCALE_BPS)) err("scale", "The multiplier must be between 0.0001x and 10x.");
    else scaleBps = Number(s);
  } else {
    const a = parseAmount18(v.allocation);
    if (a === null) err("allocation", "Type the allocation in dollars, like 80 or 125.50.");
    else if (a <= 0n) err("allocation", "A thesis follow needs an allocation above zero.");
    else allocation = a;
  }

  const maxNotional = parseAmount18(v.maxNotional);
  if (maxNotional === null) err("maxNotional", "Type the cap in dollars, like 100.");
  else if (maxNotional <= 0n) err("maxNotional", "The cap per position must be above zero.");

  const maxTotalNotional = optionalAmount(v.maxTotalNotional);
  if (maxTotalNotional === null) err("maxTotalNotional", "Type the whole-book cap in dollars, or leave it empty for none.");

  const band = parseFixed(v.band, 2);
  let bandBps = 0;
  if (band === null) err("band", "Type the band in percent, like 0.5 (up to two decimals).");
  else if (band <= 0n || band > BigInt(MAX_BAND_BPS)) err("band", "The band must be between 0.01% and 5%.");
  else bandBps = Number(band);

  const equityFloor = optionalAmount(v.equityFloor);
  if (equityFloor === null) err("equityFloor", "Type the equity floor in dollars, or leave it empty to keep it off.");

  const joinPools: Address[] = [];
  if (kind === "Trader" && !v.allowAll) {
    const seen = new Set<string>();
    for (const p of v.pools) {
      if (!isAddress(p, { strict: false })) continue;
      const a = getAddress(p);
      if (!seen.has(a)) joinPools.push(a);
      seen.add(a);
    }
    // the hub reads an empty list as "every market": it is never sent by accident
    if (joinPools.length === 0) err("markets", "Pick at least one market, or mirror the whole book.");
    if (joinPools.length > MAX_JOIN_POOLS) err("markets", `A trader follow may name at most ${MAX_JOIN_POOLS} markets.`);
  }

  if (errors.length) return { joinPools, errors };
  return {
    policy: { scaleBps, allocation, maxNotional: maxNotional!, maxTotalNotional: maxTotalNotional!, bandBps, equityFloor: equityFloor! },
    joinPools,
    errors,
  };
}

const E18 = 10n ** 18n;
/** Whole dollars, rounded up. */
const ceilDollars = (x: bigint) => (x + E18 - 1n) / E18;

/**
 * Starting values. A thesis starts at the minimum with headroom, rounded up to a dollar, and a cap that does not
 * clamp its heaviest leg. A trader follow starts at 1x with a $100 cap per position and a 0.50% band.
 */
export function defaultPolicyForm(kind: SourceKindName, thesis?: { recommendedAllocation?: bigint; maxWeightBps: number; minMaxNotional?: bigint }): PolicyFormValues {
  const base: PolicyFormValues = { scale: "1", allocation: "", maxNotional: "100", maxTotalNotional: "", band: "0.5", equityFloor: "", allowAll: true, pools: [] };
  if (kind === "Trader" || !thesis) return base;
  const alloc = thesis.recommendedAllocation !== undefined ? ceilDollars(thesis.recommendedAllocation) : undefined;
  if (alloc === undefined) return base;
  const heaviest = (alloc * BigInt(Math.abs(thesis.maxWeightBps)) + BPS - 1n) / BPS;
  const floor = thesis.minMaxNotional !== undefined ? ceilDollars(thesis.minMaxNotional) : 0n;
  const cap = heaviest > floor ? heaviest : floor;
  return { ...base, allocation: alloc.toString(), maxNotional: (cap > 0n ? cap : 1n).toString() };
}

/** The form's tank field: STT with up to six decimals, as wei. */
export const parseTank = (s: string): bigint | null => parseAmount18(s);

/** A field's first error, for the input it belongs to. */
export const errorFor = (errors: readonly FieldError[], field: FormField) => errors.find((e) => e.field === field)?.message;

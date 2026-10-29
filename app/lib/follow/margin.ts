import { BPS, type Leg, type Policy, type SourceKindName } from "@copybook/sdk";
import { defaultPolicyForm, parseAmount18, parseFixed } from "./policyForm";

/**
 * Moving spot USDso into the perps account, as plain functions: what the margin step suggests the account holds,
 * the amount the form starts at, and which of the two transactions (approve, then deposit) comes next. The
 * allowance and the balances are read from the chain, so the form resumes on the right transaction after a reload.
 */

const E18 = 10n ** 18n;
const CENT = 10n ** 16n;
const ceilDollars = (x: bigint) => ((x + E18 - 1n) / E18) * E18;

/** The suggested margin for a follow and what it covers. */
export interface MarginTarget {
  amount: bigint;
  /** trader: one position at the default cap; thesis: the basket's notional at the suggested allocation. */
  basis: "trader-cap" | "thesis-basket";
}

export type MarginSource = { kind: "Trader" } | { kind: "Theme"; legs: readonly Leg[]; minimum: { recommended: bigint } | null };

/**
 * Enough margin to hold what the follow opens by default without leverage: for a trader, one position at the default
 * cap per position; for a thesis, every leg at the suggested allocation (the allocation times the gross weight).
 * Undefined when a thesis's minimum could not be read.
 */
export function marginTarget(source: MarginSource): MarginTarget | undefined {
  if (source.kind === "Trader") {
    const cap = parseAmount18(defaultPolicyForm("Trader").maxNotional);
    return cap ? { amount: cap, basis: "trader-cap" } : undefined;
  }
  if (!source.minimum) return undefined;
  const gross = source.legs.reduce((s, l) => s + BigInt(Math.abs(l.weightBps)), 0n);
  if (gross === 0n) return undefined;
  return { amount: ceilDollars((source.minimum.recommended * gross + BPS - 1n) / BPS), basis: "thesis-basket" };
}

/**
 * The same suggestion for a wallet that already follows, from its own policy: one position at its cap per position,
 * or its basket at its allocation. Undefined for a thesis whose legs are not known.
 */
export function followMarginTarget(kind: SourceKindName, policy: Pick<Policy, "allocation" | "maxNotional">, legs?: readonly Leg[]): MarginTarget | undefined {
  if (kind === "Trader") return policy.maxNotional > 0n ? { amount: ceilDollars(policy.maxNotional), basis: "trader-cap" } : undefined;
  if (!legs?.length) return undefined;
  const gross = legs.reduce((s, l) => s + BigInt(Math.abs(l.weightBps)), 0n);
  return { amount: ceilDollars((policy.allocation * gross + BPS - 1n) / BPS), basis: "thesis-basket" };
}

/**
 * The amount the move form starts at: what brings equity up to the target, rounded up to a whole cent and never more
 * than the wallet holds on spot. With no target, an unread equity, or nothing short, it offers the whole spot balance.
 */
export function suggestedDeposit(equity: bigint | null, target: bigint | undefined, spot: bigint): bigint {
  if (spot <= 0n) return 0n;
  if (target === undefined || equity === null) return spot;
  const short = target - equity;
  if (short <= 0n) return spot;
  const up = ((short + CENT - 1n) / CENT) * CENT;
  return up < spot ? up : spot;
}

/**
 * Where the form starts: an approval already waiting for its deposit (above zero, within what spot holds) wins, so a
 * reload after the approval landed resumes on the deposit of that amount; otherwise (none, or an unlimited one) the
 * suggestion.
 */
export function initialMove(equity: bigint | null, target: bigint | undefined, spot: bigint, allowance: bigint | null): bigint {
  if (allowance !== null && allowance > 0n && allowance <= spot) return allowance;
  return suggestedDeposit(equity, target, spot);
}

/**
 * A USDso amount as typed, up to 18 decimals so a whole balance can be typed back. A comma is read only when it can
 * mean one thing: digit groups (`1,500,000`, `1,500.5`) or a decimal comma (`1,5`). `1,500` could be either, so it is
 * refused with a reason rather than guessed.
 */
export function readUsdso(raw: string): { amount: bigint } | { problem: string } {
  let s = raw.trim().replace(/^\$/, "").trim();
  if (s.includes(",")) {
    if (/^\d{1,3}(,\d{3}){2,}(\.\d*)?$/.test(s) || /^\d{1,3}(,\d{3})+\.\d*$/.test(s)) s = s.replace(/,/g, "");
    else if (/^\d+,\d+$/.test(s) && !/^\d{1,3},\d{3}$/.test(s)) s = s.replace(",", ".");
    else return { problem: "Use a dot for decimals, like 1.5: this comma could mean either." };
  }
  const amount = parseFixed(s, 18);
  return amount === null ? { problem: "Type an amount in USDso, like 25." } : { amount };
}

export const parseUsdso = (s: string): bigint | null => {
  const r = readUsdso(s);
  return "amount" in r ? r.amount : null;
};

/** The amount field, and the spot balance and allowance it was last set against. */
export interface MoveField {
  typed: string;
  /** The person typed in it since it was last set. */
  touched: boolean;
  spot: bigint;
  allowance: bigint | null;
}

export const moveField = (initial: bigint, spot: bigint, allowance: bigint | null): MoveField => ({ typed: usdsoInput(initial), touched: false, spot, allowance });

/**
 * A re-read of the chain. The field takes the new starting amount when the person has not typed in it, or when the
 * wallet's spot balance or the bank's allowance moved (a move landed, or another tab sent one). An equity refresh
 * alone never replaces what they typed.
 */
export function refreshMoveField(f: MoveField, initial: bigint, spot: bigint, allowance: bigint | null): MoveField {
  const moved = spot !== f.spot || allowance !== f.allowance;
  if (!moved && f.touched) return f;
  const typed = usdsoInput(initial);
  if (!moved && typed === f.typed) return f;
  return { typed, touched: false, spot, allowance };
}

/** Plain digits for an 18-decimal amount, the way the input holds it (no grouping, no trailing zeros). */
export function usdsoInput(x: bigint): string {
  const int = x / E18;
  const frac = (x % E18).toString().padStart(18, "0").replace(/0+$/, "");
  return `${int}${frac ? `.${frac}` : ""}`;
}

export type MoveCheck =
  | { ok: true; amount: bigint; next: "approve" | "deposit" }
  | { ok: false; problem: string };

/**
 * What the move form can send for the typed amount. The approval comes first whenever the bank's allowance does not
 * cover the amount; an unread allowance counts as none, so the worst case is one approval too many.
 */
export function checkMove(typed: string, spot: bigint, allowance: bigint | null): MoveCheck {
  const r = readUsdso(typed);
  if ("problem" in r) return { ok: false, problem: r.problem };
  const amount = r.amount;
  if (amount === 0n) return { ok: false, problem: "Type an amount in USDso, like 25." };
  if (amount > spot) return { ok: false, problem: "That is more than this wallet holds on spot." };
  return { ok: true, amount, next: allowance !== null && allowance >= amount ? "deposit" : "approve" };
}

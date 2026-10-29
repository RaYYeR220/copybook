import { BPS, type Leg, type Policy, type SourceKindName } from "@copybook/sdk";
import { defaultPolicyForm, parseAmount18, parseFixed } from "./policyForm";

/**
 * Moving spot USDso into the perps account, as plain functions: what the margin step suggests the account holds,
 * the amount the form starts at, and which of the two transactions (approve, then deposit) comes next. The
 * allowance and the balances are read from the chain, so the form resumes on the right transaction after a reload.
 */

const E18 = 10n ** 18n;
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
 * The amount the move form starts at: what brings equity up to the target, never more than the wallet holds on
 * spot. With no target, an unread equity, or nothing short, it offers the whole spot balance.
 */
export function suggestedDeposit(equity: bigint | null, target: bigint | undefined, spot: bigint): bigint {
  if (spot <= 0n) return 0n;
  if (target === undefined || equity === null) return spot;
  const short = target - equity;
  if (short <= 0n) return spot;
  return short < spot ? short : spot;
}

/**
 * Where the form starts: an approval already waiting for its deposit (above zero, below the suggestion) wins, so a
 * reload after the approval landed resumes on the deposit of that amount; otherwise the suggestion.
 */
export function initialMove(equity: bigint | null, target: bigint | undefined, spot: bigint, allowance: bigint | null): bigint {
  const suggested = suggestedDeposit(equity, target, spot);
  return allowance !== null && allowance > 0n && allowance < suggested ? allowance : suggested;
}

/** A USDso amount as typed: up to 18 decimals, so a whole balance can be typed back. */
export const parseUsdso = (s: string): bigint | null => parseFixed(s, 18);

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
  const amount = parseUsdso(typed);
  if (amount === null || amount === 0n) return { ok: false, problem: "Type an amount in USDso, like 25." };
  if (amount > spot) return { ok: false, problem: "That is more than this wallet holds on spot." };
  return { ok: true, amount, next: allowance !== null && allowance >= amount ? "deposit" : "approve" };
}

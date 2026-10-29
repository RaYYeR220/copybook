import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { checkMove, followMarginTarget, initialMove, marginTarget, moveField, parseUsdso, readUsdso, refreshMoveField, suggestedDeposit, usdsoInput } from "@/lib/follow/margin";

const E = 10n ** 18n;
const BTC = "0x00000000000000000000000000000000000000b1" as Address;
const ETH = "0x00000000000000000000000000000000000000e1" as Address;
const legs = [
  { pool: BTC, weightBps: 4_000 },
  { pool: ETH, weightBps: -2_000 },
];

describe("the suggested margin", () => {
  it("a trader follow: one position at the default $100 cap, held without leverage", () => {
    expect(marginTarget({ kind: "Trader" })).toEqual({ amount: 100n * E, basis: "trader-cap" });
  });

  it("a thesis: the basket's gross notional at the suggested allocation, rounded up to a dollar", () => {
    // 60% gross of $57.20, $34.32, rounds up to $35
    expect(marginTarget({ kind: "Theme", legs, minimum: { recommended: 5720n * 10n ** 16n } })).toEqual({ amount: 35n * E, basis: "thesis-basket" });
    expect(marginTarget({ kind: "Theme", legs, minimum: null })).toBeUndefined();
  });

  it("a following wallet: its own cap, or its own basket", () => {
    expect(followMarginTarget("Trader", { allocation: 0n, maxNotional: 250n * E })).toEqual({ amount: 250n * E, basis: "trader-cap" });
    expect(followMarginTarget("Theme", { allocation: 100n * E, maxNotional: 40n * E }, legs)).toEqual({ amount: 60n * E, basis: "thesis-basket" });
    expect(followMarginTarget("Theme", { allocation: 100n * E, maxNotional: 40n * E })).toBeUndefined();
  });
});

describe("the amount the move starts at", () => {
  it("what brings equity up to the suggestion, never more than spot holds", () => {
    expect(suggestedDeposit(30n * E, 100n * E, 500n * E)).toBe(70n * E);
    expect(suggestedDeposit(30n * E, 100n * E, 6n * E)).toBe(6n * E);
    // a negative equity is made up too
    expect(suggestedDeposit(-5n * E, 100n * E, 500n * E)).toBe(105n * E);
  });

  it("rounds the shortfall up to a whole cent, still capped at spot", () => {
    // 100 − 29.876543… = 70.123456… → 70.13
    expect(suggestedDeposit(29_876_543_210_000_000_000n, 100n * E, 500n * E)).toBe(7_013n * 10n ** 16n);
    expect(suggestedDeposit(99_999_999_999_999_999_999n, 100n * E, 500n * E)).toBe(10n ** 16n);
    // the cap wins over the rounding: never more than the wallet holds
    expect(suggestedDeposit(29_876_543_210_000_000_000n, 100n * E, 70_125_000_000_000_000_000n)).toBe(70_125_000_000_000_000_000n);
  });

  it("the whole spot balance with no suggestion, an unread equity, or nothing short; zero with nothing on spot", () => {
    expect(suggestedDeposit(30n * E, undefined, 6n * E)).toBe(6n * E);
    expect(suggestedDeposit(null, 100n * E, 6n * E)).toBe(6n * E);
    expect(suggestedDeposit(200n * E, 100n * E, 6n * E)).toBe(6n * E);
    expect(suggestedDeposit(0n, 100n * E, 0n)).toBe(0n);
  });
});

describe("resuming a move", () => {
  it("an approval waiting for its deposit sets the amount, so a reload lands on the deposit", () => {
    // approved 2 of a suggested 3: the form starts at 2, and 2 is covered
    expect(initialMove(3n * E, undefined, 3n * E, 2n * E)).toBe(2n * E);
    expect(checkMove(usdsoInput(initialMove(3n * E, undefined, 3n * E, 2n * E)), 3n * E, 2n * E)).toMatchObject({ ok: true, next: "deposit" });
    // approved more than the suggestion but within spot (the person typed more): that amount, not the suggestion
    expect(initialMove(97n * E, 100n * E, 6n * E, 6n * E)).toBe(6n * E);
    // an allowance beyond what spot holds (an unlimited one, say) keeps the suggestion, already covered
    expect(initialMove(30n * E, 100n * E, 500n * E, 2n ** 255n)).toBe(70n * E);
    // no allowance, or an unread one: the suggestion
    expect(initialMove(30n * E, 100n * E, 500n * E, 0n)).toBe(70n * E);
    expect(initialMove(30n * E, 100n * E, 500n * E, null)).toBe(70n * E);
  });
});

describe("the amount field across re-reads", () => {
  const f0 = moveField(3n * E, 6n * E, 0n);

  it("an equity refresh never replaces what the person typed", () => {
    const typed = { ...f0, typed: "4.5", touched: true };
    // the suggestion moved (equity re-read), spot and allowance did not
    expect(refreshMoveField(typed, 2n * E, 6n * E, 0n)).toBe(typed);
  });

  it("an untouched field follows the suggestion", () => {
    expect(refreshMoveField(f0, 2n * E, 6n * E, 0n)).toMatchObject({ typed: "2", touched: false });
    expect(refreshMoveField(f0, 3n * E, 6n * E, 0n)).toBe(f0);
  });

  it("a moved spot balance or allowance resets it, typed or not", () => {
    const typed = { ...f0, typed: "4.5", touched: true };
    // the approval of 4.5 landed: the field restarts on the waiting approval
    expect(refreshMoveField(typed, 45n * 10n ** 17n, 6n * E, 45n * 10n ** 17n)).toMatchObject({ typed: "4.5", touched: false, allowance: 45n * 10n ** 17n });
    // the deposit landed: spot fell, the field takes the new suggestion
    expect(refreshMoveField(typed, 15n * 10n ** 17n, 15n * 10n ** 17n, 0n)).toMatchObject({ typed: "1.5", touched: false, spot: 15n * 10n ** 17n });
  });
});

describe("commas in the amount", () => {
  it("reads a decimal comma and digit groups, and refuses the one it cannot tell", () => {
    expect(readUsdso("1,5")).toEqual({ amount: 15n * 10n ** 17n });
    expect(readUsdso("12,34")).toEqual({ amount: 1234n * 10n ** 16n });
    expect(readUsdso("1,500,000")).toEqual({ amount: 1_500_000n * E });
    expect(readUsdso("1,500.5")).toEqual({ amount: 15_005n * 10n ** 17n });
    expect(readUsdso("$25")).toEqual({ amount: 25n * E });
    // "1,500" is 1.5 or 1500: refused, never read as either
    expect(readUsdso("1,500")).toEqual({ problem: "Use a dot for decimals, like 1.5: this comma could mean either." });
    expect("problem" in readUsdso("1,2,3")).toBe(true);
    expect(checkMove("1,500", 6_000n * E, 0n)).toEqual({ ok: false, problem: "Use a dot for decimals, like 1.5: this comma could mean either." });
    // never 15
    expect(parseUsdso("1,5")).not.toBe(15n * E);
  });
});

describe("the move form", () => {
  it("types and shows amounts exactly, to 18 decimals", () => {
    expect(parseUsdso("25")).toBe(25n * E);
    expect(parseUsdso("0.000000000000000001")).toBe(1n);
    expect(parseUsdso("1.2.3")).toBeNull();
    expect(usdsoInput(16_760_000_000_000_000_000n)).toBe("16.76");
    expect(usdsoInput(25n * E)).toBe("25");
    expect(parseUsdso(usdsoInput(123_456_789_012_345_678n))).toBe(123_456_789_012_345_678n);
  });

  it("approves first unless the bank's allowance already covers the amount", () => {
    expect(checkMove("3", 6n * E, 0n)).toEqual({ ok: true, amount: 3n * E, next: "approve" });
    expect(checkMove("3", 6n * E, 2n * E)).toEqual({ ok: true, amount: 3n * E, next: "approve" });
    expect(checkMove("3", 6n * E, 3n * E)).toEqual({ ok: true, amount: 3n * E, next: "deposit" });
    // an unread allowance counts as none: at worst one approval too many
    expect(checkMove("3", 6n * E, null)).toMatchObject({ ok: true, next: "approve" });
  });

  it("refuses an empty, zero or too large amount before any wallet prompt", () => {
    expect(checkMove("", 6n * E, 0n).ok).toBe(false);
    expect(checkMove("0", 6n * E, 0n).ok).toBe(false);
    expect(checkMove("abc", 6n * E, 0n).ok).toBe(false);
    expect(checkMove("7", 6n * E, 10n * E)).toEqual({ ok: false, problem: "That is more than this wallet holds on spot." });
  });
});

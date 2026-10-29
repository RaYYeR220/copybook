import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { checkMove, followMarginTarget, marginTarget, parseUsdso, suggestedDeposit, usdsoInput } from "@/lib/follow/margin";

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

  it("the whole spot balance with no suggestion, an unread equity, or nothing short; zero with nothing on spot", () => {
    expect(suggestedDeposit(30n * E, undefined, 6n * E)).toBe(6n * E);
    expect(suggestedDeposit(null, 100n * E, 6n * E)).toBe(6n * E);
    expect(suggestedDeposit(200n * E, 100n * E, 6n * E)).toBe(6n * E);
    expect(suggestedDeposit(0n, 100n * E, 0n)).toBe(0n);
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

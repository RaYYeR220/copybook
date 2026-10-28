import { describe, expect, it } from "vitest";
import { fmtPnl, fmtPrice18, fmtStt, fmtUnits, fmtUsd18, fmtUtc } from "@/lib/units";

describe("units", () => {
  it("formats base units with the market's decimals, trimming zeros", () => {
    expect(fmtUnits(50000n, 8)).toBe("0.0005");
    expect(fmtUnits(5069640000n, 8)).toBe("50.6964");
    expect(fmtUnits(115765700000000000000n, 18)).toBe("115.7657");
    expect(fmtUnits(-30000n, 8)).toBe("−0.0003");
    expect(fmtUnits(0n, 8)).toBe("0");
    expect(fmtUnits(123456789000000000000000n, 18)).toBe("123,456.789");
    expect(fmtUnits(1n, 18, 6)).toBe("0.000001"); // never rounds a nonzero size to 0
  });

  it("formats 18-decimal prices for people", () => {
    expect(fmtPrice18(81065600000000000000000n)).toBe("81,065.60");
    expect(fmtPrice18(2353957263831650000000n)).toBe("2,353.96");
    expect(fmtPrice18(4123000000000000n)).toBe("0.004123");
  });

  it("formats 18-decimal USD, rounding minimums up when asked", () => {
    expect(fmtUsd18(31409238950165660000n)).toBe("$31.41");
    expect(fmtUsd18(34550162845182226000n, "up")).toBe("$34.56");
    expect(fmtUsd18(31400000000000000000n, "up")).toBe("$31.40");
    expect(fmtUsd18(0n)).toBe("$0.00");
  });

  it("signs PnL with a true minus and no colour cue in the text", () => {
    expect(fmtPnl(26075.06)).toBe("+26,075.06");
    expect(fmtPnl(-0.09)).toBe("−0.09");
    expect(fmtPnl(0)).toBe("0.00");
  });

  it("formats STT", () => {
    expect(fmtStt(500000000000000000n)).toBe("0.5 STT");
    expect(fmtStt(12000000000000000000n)).toBe("12 STT");
  });

  it("formats unix seconds as UTC, the same on server and client", () => {
    expect(fmtUtc(1793194591)).toBe("28 Oct 2026, 13:36:31 UTC");
    expect(fmtUtc(1793194591 + 86400)).toBe("29 Oct 2026, 13:36:31 UTC");
  });
});

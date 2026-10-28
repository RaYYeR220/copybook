import { describe, expect, it } from "vitest";
import { riskSummary, type TraderStats } from "../src/index.ts";

const base: TraderStats = {
  trader: "0x0000000000000000000000000000000000000001",
  windowDays: 30,
  trades30d: 412,
  activeDays30d: 14,
  marketsTraded: 6,
  realizedPnl30d: 812.4,
  liquidations30d: 3,
  maxDrawdownAbs30d: 100,
  maxDrawdownPct30d: 31.2,
  avgLeverage: 12.4,
  lastActiveAt: "2026-10-27T10:00:00.000Z",
  truncated: false,
};

describe("riskSummary", () => {
  it("renders the exact key=value string", () => {
    expect(riskSummary(base)).toBe(
      "trades30d=412 activeDays30d=14 markets=6 realizedPnl30d=+812.4 liquidations30d=3 maxDrawdownPct30d=31.2 avgLeverage=12.4 lastActive=2026-10-27",
    );
  });

  it("writes n/a for unknown values and signs losses", () => {
    const s = riskSummary({
      ...base,
      realizedPnl30d: -979.66,
      maxDrawdownPct30d: null,
      avgLeverage: null,
      lastActiveAt: null,
    });
    expect(s).toBe(
      "trades30d=412 activeDays30d=14 markets=6 realizedPnl30d=-979.7 liquidations30d=3 maxDrawdownPct30d=n/a avgLeverage=n/a lastActive=n/a",
    );
  });

  it("flags partial data and never prints a negative zero", () => {
    const s = riskSummary({ ...base, realizedPnl30d: -0.01, truncated: true });
    expect(s).toContain("realizedPnl30d=+0.0 ");
    expect(s.endsWith(" partial=1")).toBe(true);
  });

  it("is deterministic and at most 280 characters even for extreme values", () => {
    const extreme = { ...base, trades30d: 99999999, realizedPnl30d: -123456789012345.6, truncated: true };
    expect(riskSummary(extreme)).toBe(riskSummary({ ...extreme }));
    expect(riskSummary(extreme).length).toBeLessThanOrEqual(280);
  });

  it("uses the window length in the key suffix", () => {
    expect(riskSummary({ ...base, windowDays: 7 })).toContain("trades7d=412 activeDays7d=14");
  });
});

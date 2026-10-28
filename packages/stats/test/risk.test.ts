import { describe, expect, it } from "vitest";
import { riskRubric, riskSummary, type TraderStats } from "../src/index.ts";

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
  hasHistory: true,
  truncated: false,
};

describe("riskSummary", () => {
  it("renders the exact key=value string", () => {
    expect(riskSummary(base)).toBe(
      "trades30d=412 activeDays30d=14 markets=6 realizedPnl30d=+812.4 liquidations30d=3 maxDrawdown30d=100.0 maxDrawdownPct30d=31.2 avgLeverage=12.4 lastActive=2026-10-27",
    );
  });

  it("always carries the absolute drawdown and drops the percentage when it is unknown", () => {
    expect(riskSummary({ ...base, maxDrawdownPct30d: null })).toBe(
      "trades30d=412 activeDays30d=14 markets=6 realizedPnl30d=+812.4 liquidations30d=3 maxDrawdown30d=100.0 avgLeverage=12.4 lastActive=2026-10-27",
    );
  });

  it("writes n/a for unknown values and signs losses", () => {
    const s = riskSummary({
      ...base,
      realizedPnl30d: -979.66,
      maxDrawdownAbs30d: null,
      maxDrawdownPct30d: null,
      avgLeverage: null,
      lastActiveAt: null,
    });
    expect(s).toBe(
      "trades30d=412 activeDays30d=14 markets=6 realizedPnl30d=-979.7 liquidations30d=3 maxDrawdown30d=n/a avgLeverage=n/a lastActive=n/a",
    );
  });

  it("marks a trader with no history in the window", () => {
    const s = riskSummary({
      ...base,
      trades30d: 0,
      activeDays30d: 0,
      marketsTraded: 0,
      realizedPnl30d: 0,
      liquidations30d: 0,
      maxDrawdownAbs30d: null,
      maxDrawdownPct30d: null,
      avgLeverage: null,
      lastActiveAt: null,
      hasHistory: false,
    });
    expect(s).toBe(
      "trades30d=0 activeDays30d=0 markets=0 realizedPnl30d=+0.0 liquidations30d=0 maxDrawdown30d=n/a avgLeverage=n/a lastActive=n/a history=none",
    );
  });

  it("flags partial data and never prints a negative zero", () => {
    const s = riskSummary({ ...base, realizedPnl30d: -0.01, truncated: true });
    expect(s).toContain("realizedPnl30d=+0.0 ");
    expect(s.endsWith(" partial=1")).toBe(true);
  });

  it("keeps the flags when the line hits the length cap, and never exceeds 280 characters", () => {
    const extreme = {
      ...base,
      windowDays: 999999,
      trades30d: 99999999,
      activeDays30d: 99999999,
      marketsTraded: 99999999,
      liquidations30d: 99999999,
      realizedPnl30d: -123456789012345678901.6,
      maxDrawdownAbs30d: 123456789012345678901.6,
      avgLeverage: 99999999999.9,
      hasHistory: false,
      truncated: true,
    };
    const s = riskSummary(extreme);
    expect(s).toBe(riskSummary({ ...extreme }));
    expect(s.length).toBeLessThanOrEqual(280);
    expect(s.endsWith(" history=none partial=1")).toBe(true);
  });

  it("uses the window length in the key suffix", () => {
    expect(riskSummary({ ...base, windowDays: 7 })).toContain("trades7d=412 activeDays7d=14");
  });
});

describe("riskRubric", () => {
  it("carries only the rubric's inputs, in a fixed order", () => {
    expect(riskRubric(base)).toBe("liquidations30d=3 trades30d=412 maxDrawdownPct30d=31.2 history=yes partial=0");
  });

  it("leaves out the drawdown percentage when it is unknown, as the summary does", () => {
    expect(riskRubric({ ...base, maxDrawdownPct30d: null })).toBe("liquidations30d=3 trades30d=412 history=yes partial=0");
  });

  it("drops every key the rubric does not read", () => {
    const line = riskRubric({ ...base, realizedPnl30d: -979.66, avgLeverage: null, lastActiveAt: null });
    for (const key of ["realizedPnl", "maxDrawdown30d", "avgLeverage", "lastActive", "activeDays", "markets"]) {
      expect(line).not.toContain(key);
    }
  });

  it("states history=none and partial=1", () => {
    expect(
      riskRubric({ ...base, trades30d: 0, liquidations30d: 0, maxDrawdownPct30d: null, hasHistory: false, truncated: true }),
    ).toBe("liquidations30d=0 trades30d=0 history=none partial=1");
  });

  it("writes n/a for a count that is not a number", () => {
    expect(riskRubric({ ...base, liquidations30d: Number.NaN, trades30d: Number.POSITIVE_INFINITY })).toBe(
      "liquidations30d=n/a trades30d=n/a maxDrawdownPct30d=31.2 history=yes partial=0",
    );
  });

  it("uses the window length in the key suffix", () => {
    expect(riskRubric({ ...base, windowDays: 7 })).toBe("liquidations7d=3 trades7d=412 maxDrawdownPct7d=31.2 history=yes partial=0");
  });
});

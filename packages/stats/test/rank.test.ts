import { describe, expect, it } from "vitest";
import { topTraders } from "../src/index.ts";
import { LEVERAGED, LIQUIDATED, NOW, STEADY, fixtureFetch } from "./helpers.ts";

const ALL = [LIQUIDATED, LEVERAGED, STEADY];

const run = (n: number, opts: object = {}, candidates = ALL, stub: { failFor?: typeof STEADY } = {}) => {
  const { fetch, calls } = fixtureFetch(ALL, { candidates, ...stub });
  return topTraders(n, 30, { fetch, now: NOW, delayMs: 0, ...opts }).then((r) => ({ r, calls }));
};

describe("topTraders", () => {
  it("ranks by realized PnL and exposes PnL per unit of drawdown", async () => {
    const { r } = await run(3, { maxLiquidations: 10 });
    expect(r.traders.map((t) => [t.rank, t.trader, t.realizedPnl30d, t.riskAdjusted])).toEqual([
      [1, STEADY, 3773.31, 5.55],
      [2, LEVERAGED, 12.14, 0.14],
      [3, LIQUIDATED, -979.65, -0.38],
    ]);
    expect(r.traders[0].stats.trades30d).toBe(113);
    expect(r.skipped).toEqual([]);
  });

  it("by default drops traders with more than one liquidation in the window", async () => {
    const { r } = await run(3);
    expect(r.traders.map((t) => t.trader)).toEqual([STEADY, LEVERAGED]);
    const { r: lenient } = await run(3, { maxLiquidations: 3 });
    expect(lenient.traders.map((t) => t.trader)).toContain(LIQUIDATED);
  });

  it("returns at most n", async () => {
    const { r } = await run(1);
    expect(r.traders.map((t) => t.trader)).toEqual([STEADY]);
  });

  it("drops excluded wallets (case-insensitive) before fetching their history", async () => {
    const { r, calls } = await run(3, { exclude: ["0x" + STEADY.slice(2).toUpperCase()] });
    expect(r.traders.map((t) => t.trader)).toEqual([LEVERAGED]);
    expect(calls.some((c) => c.variables.account === STEADY)).toBe(false);
  });

  it("applies the minimum-activity filters (defaults 20 trades, 5 active days)", async () => {
    const { r } = await run(3, { minTrades: 100 });
    expect(r.traders.map((t) => t.trader)).toEqual([STEADY]);
    const { r: r2 } = await run(3, { minActiveDays: 8 });
    expect(r2.traders.map((t) => t.trader)).toEqual([LEVERAGED]);
    const { r: r3 } = await run(3, { minTrades: 20 });
    expect(r3.traders).toHaveLength(2);
  });

  it("skips traders whose history was cut off by the row cap", async () => {
    const { r } = await run(3, { maxRows: 50, maxLiquidations: 10 });
    expect(r.traders).toEqual([]);
  });

  it("pages candidate rows until enough distinct accounts are found", async () => {
    const dup = [STEADY, STEADY, LEVERAGED, LEVERAGED, LIQUIDATED];
    const { r, calls } = await run(3, { candidatePageSize: 2, candidateLimit: 3, maxLiquidations: 10 }, dup);
    expect(r.traders.map((t) => t.trader)).toEqual([STEADY, LEVERAGED, LIQUIDATED]);
    const pages = calls.filter((c) => c.operationName === "Candidates");
    expect(pages.map((c) => c.variables.offset)).toEqual([0, 2, 4]);
    expect(r.candidateShortfall).toBe(false);
  });

  it("stops at the page budget and reports the shortfall", async () => {
    const dup = [STEADY, STEADY, STEADY, STEADY, LEVERAGED];
    const { r, calls } = await run(3, { candidatePageSize: 2, candidatePages: 2, candidateLimit: 3 }, dup);
    expect(calls.filter((c) => c.operationName === "Candidates")).toHaveLength(2);
    expect(r.traders.map((t) => t.trader)).toEqual([STEADY]);
    expect(r.candidateShortfall).toBe(true);
  });

  it("does not let excluded accounts use up candidate slots", async () => {
    const { r } = await run(3, { exclude: [STEADY], candidateLimit: 2, maxLiquidations: 10 });
    expect(r.traders.map((t) => t.trader).sort()).toEqual([LEVERAGED, LIQUIDATED].sort());
  });

  it("reports a candidate whose fetch fails and keeps going", async () => {
    const { r } = await run(3, { retries: 0 }, ALL, { failFor: LEVERAGED });
    expect(r.traders.map((t) => t.trader)).toEqual([STEADY]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].account).toBe(LEVERAGED);
    expect(r.skipped[0].reason).toMatch(/HTTP 500/);
  });
});

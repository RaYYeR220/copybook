import { describe, expect, it } from "vitest";
import { getTraderStats } from "../src/index.ts";
import { LEVERAGED, LIQUIDATED, NOW, STEADY, fixtureFetch } from "./helpers.ts";

const stats = (a: typeof STEADY, extra: object = {}) => {
  const { fetch, calls } = fixtureFetch([LIQUIDATED, LEVERAGED, STEADY]);
  return getTraderStats(a, { fetch, now: NOW, delayMs: 0, ...extra }).then((s) => ({ s, calls }));
};

describe("getTraderStats", () => {
  it("computes the 30-day picture of a trader with no liquidations", async () => {
    const { s } = await stats(STEADY);
    expect(s).toMatchObject({
      trader: STEADY,
      windowDays: 30,
      trades30d: 815,
      activeDays30d: 17,
      marketsTraded: 11,
      realizedPnl30d: 11250.97,
      liquidations30d: 0,
      maxDrawdownAbs30d: 307.6,
      maxDrawdownPct30d: 1.2,
      avgLeverage: null, // no explicit leverage settings on record
      truncated: false,
    });
    expect(s.lastActiveAt).toBe("2026-10-28T09:46:58.000Z");
  });

  it("counts liquidations by transaction and keeps them out of voluntary trades", async () => {
    const { s } = await stats(LIQUIDATED);
    expect(s.liquidations30d).toBe(3); // 4 events across 3 transactions: AccountLiquidated + PositionLiquidated share one
    expect(s.trades30d).toBe(115); // 121 position changes, 6 of them inside liquidation transactions
    expect(s.realizedPnl30d).toBe(-979.65); // liquidation losses still count toward PnL
    expect(s.maxDrawdownPct30d).toBe(92.2);
    expect(s.maxDrawdownAbs30d).toBe(2609.88);
    expect(s.avgLeverage).toBe(17);
    expect(s.activeDays30d).toBe(6);
  });

  it("averages leverage only when settings cover most of the trading", async () => {
    const { s } = await stats(LEVERAGED);
    expect(s.avgLeverage).toBe(20);
    expect(s.maxDrawdownPct30d).toBe(49.2);
    expect(s.realizedPnl30d).toBe(-437.74);
  });

  it("returns nulls, not guesses, for a trader the indexer has never seen", async () => {
    const { fetch } = fixtureFetch([]);
    const s = await getTraderStats("0x0000000000000000000000000000000000000001", { fetch, now: NOW, delayMs: 0 });
    expect(s).toMatchObject({
      trades30d: 0,
      activeDays30d: 0,
      marketsTraded: 0,
      realizedPnl30d: 0,
      liquidations30d: 0,
      maxDrawdownPct30d: null,
      maxDrawdownAbs30d: null,
      avgLeverage: null,
      lastActiveAt: null,
    });
  });

  it("pages with the configured page size and flags truncation at the row cap", async () => {
    const { s, calls } = await stats(STEADY, { pageSize: 100, maxRows: 250 });
    const pages = calls.filter((c) => c.operationName === "Changes");
    expect(pages.map((c) => [c.variables.offset, c.variables.limit])).toEqual([
      [0, 100],
      [100, 100],
      [200, 50],
    ]);
    expect(s.truncated).toBe(true);
    expect(s.trades30d).toBe(250);
  });

  it("lowercases the account and sends the window start", async () => {
    const { calls } = await stats(STEADY);
    const first = calls.find((c) => c.operationName === "Changes")!;
    expect(first.variables.account).toBe(STEADY);
    expect(first.variables.since).toBe(String(NOW - 30 * 86400));
  });

  it("surfaces indexer errors instead of reporting empty stats", async () => {
    const bad = (async () => new Response(JSON.stringify({ errors: [{ message: "database query error" }] }))) as unknown as typeof fetch;
    await expect(getTraderStats(STEADY, { fetch: bad, now: NOW, delayMs: 0, retries: 0 })).rejects.toThrow(/database query error/);
  });
});

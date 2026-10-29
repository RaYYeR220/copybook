import { describe, expect, it } from "vitest";
import { Indexer, IndexerError, getTraderStats } from "../src/index.ts";
import { LEVERAGED, LIQUIDATED, NOW, STEADY, fixtureFetch } from "./helpers.ts";

const stats = (a: typeof STEADY, extra: object = {}) => {
  const { fetch, calls } = fixtureFetch([LIQUIDATED, LEVERAGED, STEADY]);
  return getTraderStats(a, { fetch, now: NOW, delayMs: 0, ...extra }).then((s) => ({ s, calls }));
};

describe("getTraderStats", () => {
  it("computes the 30-day picture of an unlevered trader with no liquidations", async () => {
    const { s } = await stats(STEADY);
    expect(s).toMatchObject({
      trader: STEADY,
      windowDays: 30,
      trades30d: 113,
      activeDays30d: 7,
      marketsTraded: 3,
      realizedPnl30d: 3773.31,
      liquidations30d: 0,
      maxDrawdownAbs30d: 679.31,
      maxDrawdownPct30d: null, // no explicit leverage settings: the percentage would rest on protocol-minimum margin
      avgLeverage: null,
      hasHistory: true,
      truncated: false,
    });
    expect(s.lastActiveAt).toBe("2026-10-22T11:01:03.000Z");
  });

  it("counts liquidations by transaction and keeps them out of voluntary trades", async () => {
    const { s } = await stats(LIQUIDATED);
    expect(s.liquidations30d).toBe(3); // 4 events across 3 transactions: AccountLiquidated + PositionLiquidated share one
    expect(s.trades30d).toBe(115); // 121 position changes, 6 of them inside liquidation transactions
    expect(s.realizedPnl30d).toBe(-979.65); // liquidation losses still count toward PnL
    expect(s.maxDrawdownAbs30d).toBe(2609.88);
    expect(s.maxDrawdownPct30d).toBe(92.2); // explicit leverage covers ~91% of notional
    expect(s.avgLeverage).toBe(17);
    expect(s.activeDays30d).toBe(6);
  });

  it("reports leverage-based figures when settings cover the trading", async () => {
    const { s } = await stats(LEVERAGED);
    expect(s.avgLeverage).toBe(14.5);
    expect(s.maxDrawdownAbs30d).toBe(85.99);
    expect(s.maxDrawdownPct30d).toBe(3.8);
    expect(s.realizedPnl30d).toBe(12.14);
  });

  it("returns zeros and hasHistory=false, not guesses, for a trader the indexer has never seen", async () => {
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
      hasHistory: false,
    });
  });

  it("pages with the configured page size and flags truncation at the row cap", async () => {
    const { s, calls } = await stats(STEADY, { pageSize: 50, maxRows: 100 });
    const pages = calls.filter((c) => c.operationName === "Changes");
    expect(pages.map((c) => [c.variables.offset, c.variables.limit])).toEqual([
      [0, 50],
      [50, 50],
    ]);
    expect(s.truncated).toBe(true);
    expect(s.trades30d).toBe(100);
  });

  it("lowercases the account and sends the window start", async () => {
    const { calls } = await stats(STEADY);
    const first = calls.find((c) => c.operationName === "Changes")!;
    expect(first.variables.account).toBe(STEADY);
    expect(first.variables.since).toBe(String(NOW - 30 * 86400));
  });

  it("rejects malformed addresses before touching the indexer", async () => {
    const { fetch, calls } = fixtureFetch([]);
    for (const bad of ["0x123", "not-an-address", `0x${"g".repeat(40)}`, `${STEADY}00`]) {
      await expect(getTraderStats(bad as any, { fetch, now: NOW, delayMs: 0 })).rejects.toThrow(/invalid trader address/);
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts checksummed (mixed-case) addresses", async () => {
    const mixed = ("0x" + STEADY.slice(2).toUpperCase()) as typeof STEADY;
    const { fetch } = fixtureFetch([STEADY]);
    const s = await getTraderStats(mixed, { fetch, now: NOW, delayMs: 0 });
    expect(s.trader).toBe(STEADY);
    expect(s.trades30d).toBe(113);
  });

  it("throws IndexerError with GraphQL details instead of reporting empty stats", async () => {
    const bad = (async () => new Response(JSON.stringify({ errors: [{ message: "database query error" }] }))) as unknown as typeof fetch;
    const err = await getTraderStats(STEADY, { fetch: bad, now: NOW, delayMs: 0, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.message).toMatch(/database query error/);
    expect(err.graphqlErrors).toEqual([{ message: "database query error" }]);
    expect(err.operationName).toBe("Changes");
  });

  it("throws IndexerError with the HTTP status", async () => {
    const bad = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const err = await getTraderStats(STEADY, { fetch: bad, now: NOW, delayMs: 0, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.status).toBe(503);
  });

  it("wraps transport failures in IndexerError", async () => {
    const bad = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await getTraderStats(STEADY, { fetch: bad, now: NOW, delayMs: 0, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.cause).toBeInstanceOf(TypeError);
  });
});

describe("openPositionPools", () => {
  it("lists each pool the account holds a non-zero position in, once, lower-cased", async () => {
    const seen: { operationName: string; variables: Record<string, unknown> }[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(body);
      const rows = [{ pool: "0x4181DD08E73BBCDD1BA3E615A18F6ABD941B94C0" }, { pool: "0xd6cb1dd58580b84d76068ac21594219ce03aeddf" }, { pool: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0" }];
      return new Response(JSON.stringify({ data: { PerpPosition: rows } }));
    }) as unknown as typeof globalThis.fetch;
    const pools = await new Indexer({ fetch, delayMs: 0 }).openPositionPools("0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d");
    expect(pools).toEqual(["0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0", "0xd6cb1dd58580b84d76068ac21594219ce03aeddf"]);
    expect(seen[0]).toMatchObject({ operationName: "OpenPools", variables: { account: "0xa1d0cb85c869e534fe1e0c22af3b238301157b5d" } });
  });
});

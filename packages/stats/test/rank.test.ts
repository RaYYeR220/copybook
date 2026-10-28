import { describe, expect, it } from "vitest";
import { topTraders } from "../src/index.ts";
import { LEVERAGED, LIQUIDATED, NOW, STEADY, fixtureFetch } from "./helpers.ts";

const run = (n: number, opts: object = {}, candidates = [LIQUIDATED, LEVERAGED, STEADY]) => {
  const { fetch, calls } = fixtureFetch([LIQUIDATED, LEVERAGED, STEADY], { candidates });
  return topTraders(n, 30, { fetch, now: NOW, delayMs: 0, ...opts }).then((r) => ({ r, calls }));
};

describe("topTraders", () => {
  it("ranks by realized PnL over the window, best first", async () => {
    const { r } = await run(3);
    expect(r.map((t) => [t.rank, t.trader, t.realizedPnl30d])).toEqual([
      [1, STEADY, 11250.97],
      [2, LEVERAGED, -437.74],
      [3, LIQUIDATED, -979.65],
    ]);
    expect(r[0].stats.trades30d).toBe(815);
  });

  it("returns at most n", async () => {
    const { r } = await run(1);
    expect(r.map((t) => t.trader)).toEqual([STEADY]);
  });

  it("drops excluded wallets (case-insensitive) before fetching their history", async () => {
    const { r, calls } = await run(3, { exclude: [STEADY.toUpperCase().replace("0X", "0x")] });
    expect(r.map((t) => t.trader)).toEqual([LEVERAGED, LIQUIDATED]);
    expect(calls.some((c) => c.variables.account === STEADY)).toBe(false);
  });

  it("applies the minimum-activity filter", async () => {
    const { r } = await run(3, { minTrades: 200 });
    expect(r.map((t) => t.trader)).toEqual([STEADY, LEVERAGED]);
    const { r: r2 } = await run(3, { minActiveDays: 10 });
    expect(r2.map((t) => t.trader)).toEqual([STEADY, LEVERAGED]);
  });

  it("skips traders whose history was cut off by the row cap", async () => {
    const { r } = await run(3, { maxRows: 100 });
    expect(r).toEqual([]);
  });

  it("asks the indexer for a bounded candidate list", async () => {
    const { calls } = await run(3, { candidateLimit: 2 });
    expect(calls.find((c) => c.operationName === "Candidates")!.variables.limit).toBeGreaterThanOrEqual(2);
  });
});

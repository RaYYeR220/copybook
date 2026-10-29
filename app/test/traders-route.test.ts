import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopybookEvent } from "@copybook/sdk";
import type { RankOptions, TraderStats } from "@copybook/stats";

const stats = (trader: string, pnl: number): TraderStats => ({
  trader: trader as `0x${string}`,
  windowDays: 30,
  trades30d: 100,
  activeDays30d: 10,
  marketsTraded: 3,
  realizedPnl30d: pnl,
  liquidations30d: 0,
  maxDrawdownAbs30d: 50,
  maxDrawdownPct30d: null,
  avgLeverage: null,
  lastActiveAt: "2026-10-28T10:00:00.000Z",
  hasHistory: true,
  truncated: false,
});

const T1 = "0x1cf35c559bd4e1d45b738b83041855c8634e5a56";
const T2 = "0x034ae6f91a5ca53367693a202f678557635db46f";
const COPY = "0xcee40d3c7709404cf60916bfea39925fcb1f09ed";
const T3 = "0x6956984d42982ae0d1a24322db689d5fa5d16393";
const LEADER = "0xa1d0cb85c869e534fe1e0c22af3b238301157b5d";

const topCalls: { n: number; window: number; opts: RankOptions }[] = [];
const statsCalls: string[] = [];
let topImpl: () => Promise<unknown>;
let statsImpl: (t: string) => Promise<TraderStats>;
let logImpl: () => Promise<{ events: CopybookEvent[]; complete: boolean }>;

vi.mock("@copybook/stats", async () => {
  const actual = await vi.importActual<typeof import("@copybook/stats")>("@copybook/stats");
  return {
    ...actual,
    topTraders: (n: number, window: number, opts: RankOptions) => {
      topCalls.push({ n, window, opts });
      return topImpl();
    },
    getTraderStats: (t: string) => {
      statsCalls.push(t.toLowerCase());
      return statsImpl(t);
    },
  };
});
vi.mock("@/lib/server/chain", () => ({ hubLog: { read: () => logImpl(), settled: async () => undefined }, primeHubLog: async () => undefined }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));

const { GET } = await import("../app/api/traders/route.ts");
const { IndexerError } = await import("@copybook/stats");

const ranked = (list: [string, number][]) => ({
  traders: list.map(([t, p], i) => ({ rank: i + 1, trader: t, realizedPnl30d: p, riskAdjusted: 1, stats: stats(t, p) })),
  skipped: [{ account: "0x9999999999999999999999999999999999999999", reason: "indexer HTTP 500" }],
  candidateShortfall: true,
});

beforeEach(() => {
  topCalls.length = 0;
  statsCalls.length = 0;
  topImpl = async () => ranked([[T1, 26075.06], [COPY, 900], [T2, 22063.54], [T3, 21736.25]]);
  statsImpl = async (t) => stats(t, -0.09);
  logImpl = async () => ({
    events: [{ name: "Followed", follower: COPY, sourceId: `0x${"1".repeat(64)}`, kind: "Theme", ref: 1n, log: { address: COPY, topics: [], data: "0x" } } as unknown as CopybookEvent],
    complete: true,
  });
});

describe("GET /api/traders", () => {
  it("ranks real traders over 30 days without our own wallets, cached for 5 minutes", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    const body = await res.json();
    expect(topCalls[0].window).toBe(30);
    const exclude = topCalls[0].opts.exclude!.map((a) => a.toLowerCase());
    expect(exclude).toContain(LEADER);
    expect(exclude).toContain("0xdf73bbbb6517b712bbed9bfae6253a5e1fcde154"); // hub
    expect(exclude).toContain("0x5397812d66f3233e0972b7aeb5e195a945504632"); // owner
    expect(exclude).toContain("0x7d736a88978e94e60494ff91c49ba838edfb1932"); // the demo follower
    expect(body.windowDays).toBe(30);
    expect(body.rules).toEqual({ minTrades: 20, minActiveDays: 5, maxLiquidations: 1, candidates: 20, maxRows: 2000 });
    expect(topCalls[0].opts).toMatchObject({ minTrades: 20, minActiveDays: 5, maxLiquidations: 1, candidateLimit: 20, maxRows: 2000 });
    expect(typeof body.asOf).toBe("string");
  });

  it("drops copy wallets found in the hub's Followed events and renumbers", async () => {
    const body = await (await GET()).json();
    expect(body.traders.map((t: { trader: string; rank: number }) => [t.rank, t.trader])).toEqual([
      [1, T1],
      [2, T2],
      [3, T3],
    ]);
    expect(body.removedFollowers).toEqual([COPY]);
    expect(body.followerExclusion).toBe("complete");
  });

  it("says when the copy-wallet list came from a partly read log", async () => {
    const full = await logImpl();
    logImpl = async () => ({ ...full, complete: false });
    expect((await (await GET()).json()).followerExclusion).toBe("partial");
  });

  it("reports skipped candidates and a candidate shortfall as they are", async () => {
    const body = await (await GET()).json();
    expect(body.skipped).toEqual([{ account: "0x9999999999999999999999999999999999999999", reason: "indexer HTTP 500" }]);
    expect(body.candidateShortfall).toBe(true);
  });

  it("lists the demo leader apart, with its own stats, never in the ranking", async () => {
    const body = await (await GET()).json();
    expect(body.demo.trader.toLowerCase()).toBe(LEADER);
    expect(body.demo.stats.realizedPnl30d).toBe(-0.09);
    expect(body.traders.some((t: { trader: string }) => t.trader.toLowerCase() === LEADER)).toBe(false);
    expect(statsCalls).toEqual([LEADER]);
  });

  it("still ranks when the hub log is unavailable", async () => {
    logImpl = async () => {
      throw new Error("rpc down");
    };
    const body = await (await GET()).json();
    expect(body.traders.length).toBe(4);
    expect(body.removedFollowers).toEqual([]);
    expect(body.followerExclusion).toBe("unavailable");
  });

  it("the demo leader's stats are null, not invented, when the indexer fails on them", async () => {
    statsImpl = async () => {
      throw new IndexerError("down", { operationName: "Changes" });
    };
    const body = await (await GET()).json();
    expect(body.demo.stats).toBeNull();
    expect(body.traders.length).toBe(3);
  });

  it("502 when the indexer fails the ranking, nothing cached", async () => {
    topImpl = async () => {
      throw new IndexerError("indexer HTTP 503", { operationName: "Candidates", status: 503 });
    };
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "indexer unavailable" });
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("500 on anything else, no message leak", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    topImpl = async () => {
      throw new Error("secret detail");
    };
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    spy.mockRestore();
  });
});

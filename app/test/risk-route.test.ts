import { beforeEach, describe, expect, it, vi } from "vitest";

let impl: () => Promise<unknown> = async () => stats;
const calls: unknown[][] = [];
const getTraderStats = (...a: unknown[]) => {
  calls.push(a);
  return impl();
};

vi.mock("@copybook/stats", async () => {
  const actual = await vi.importActual<typeof import("@copybook/stats")>("@copybook/stats");
  return { ...actual, getTraderStats };
});

const { GET } = await import("../app/api/risk/[trader]/route.ts");

const TRADER = "0xa14d4561f2697859ab6c2d5eb62e1172a6cc3d14";
const call = (trader: string) =>
  GET(new Request(`http://x/api/risk/${trader}`), { params: Promise.resolve({ trader }) });

const stats = {
  trader: TRADER,
  windowDays: 30,
  hasHistory: true,
  truncated: false,
  trades30d: 12,
  activeDays30d: 4,
  marketsTraded: 2,
  realizedPnl30d: 10.5,
  liquidations30d: 0,
  maxDrawdownAbs30d: 3,
  maxDrawdownPct30d: null,
  avgLeverage: null,
  lastActiveAt: "2026-10-27T10:00:00.000Z",
};

beforeEach(() => {
  calls.length = 0;
  impl = async () => stats;
});

describe("GET /api/risk/[trader]", () => {
  it("400 on an invalid address", async () => {
    impl = async () => {
      throw new TypeError("bad address");
    };
    const res = await call("nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid trader address" });
    expect(res.headers.get("cache-control")).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("200 with a summary string", async () => {
    impl = async () => stats;
    const res = await call(TRADER);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    const body = await res.json();
    expect(body.trader).toBe(TRADER);
    expect(typeof body.summary).toBe("string");
    expect(body.summary.length).toBeGreaterThan(0);
    expect(body.summary.length).toBeLessThanOrEqual(280);
    expect(body.stats.trades30d).toBe(12);
    expect(calls[0][1]).toEqual({ maxRows: 2000 });
    expect(typeof body.asOf).toBe("string");
  });

  it("502 on indexer failure, no summary", async () => {
    const { IndexerError } = await import("@copybook/stats");
    impl = async () => {
      throw new IndexerError("down", { operationName: "x" });
    };
    const res = await call(TRADER);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.summary).toBeUndefined();
    expect(body.error).toBe("risk summary unavailable");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("500 on an unexpected error, no message leak", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    impl = async () => {
      throw new Error("secret detail");
    };
    const res = await call(TRADER);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(res.headers.get("cache-control")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

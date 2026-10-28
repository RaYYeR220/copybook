import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { sourceIdOf, type CopybookEvent } from "@copybook/sdk";
import { fromJsonSafe } from "@/lib/json";
import type { HubLogRead, LoggedEvent } from "@/lib/server/hubLog";

const TRADER = "0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d" as Address;
const FOLLOWER = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932" as Address;
const OTHER = "0xcee40D3C7709404Cf60916BFEa39925fcB1f09Ed" as Address;
const HUB = "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154" as Address;
const GATE = "0xEe54c49E9e70a0e5C2218Eec1b1BDBd4e1Cb20f1" as Address;
const SRC = sourceIdOf("Trader", TRADER);
const THEME1 = sourceIdOf("Theme", 1n);

const meta = (address: Address, block: number, i: number) => ({
  address,
  blockNumber: BigInt(block),
  transactionHash: `0x${i.toString(16).padStart(64, "0")}` as Hex,
  transactionIndex: 0,
  logIndex: 0,
  topics: [] as Hex[],
  data: "0x" as Hex,
});

const EVENTS: LoggedEvent[] = [
  { name: "Followed", follower: FOLLOWER, sourceId: SRC, kind: "Trader", ref: BigInt(TRADER), log: meta(HUB, 100, 1) },
  { name: "Followed", follower: OTHER, sourceId: THEME1, kind: "Theme", ref: 1n, log: meta(HUB, 110, 2) },
  { name: "Copied", follower: FOLLOWER, sourceId: SRC, pool: TRADER, fromSize: 0n, toSize: 50000n, limitPrice: 81065n * 10n ** 18n, capped: false, via: "handler", log: meta(HUB, 120, 3) },
  { name: "TankCharged", follower: FOLLOWER, amount: 12n, log: meta(HUB, 120, 4) },
  { name: "ReviewRequested", trader: TRADER, nonce: 3n, requester: OTHER, log: meta(GATE, 130, 5) },
  { name: "VerdictReceived", sourceId: SRC, trader: TRADER, tier: "Block", shannonRequestId: 18072906n, summaryHash: `0x${"0".repeat(64)}`, log: meta(GATE, 140, 6) },
  { name: "Copied", follower: OTHER, sourceId: THEME1, pool: TRADER, fromSize: 0n, toSize: -3n, limitPrice: 1n, capped: true, via: "handler", log: meta(HUB, 150, 7) },
] as LoggedEvent[];

let impl: (o: { fromBlock?: bigint; budgetMs?: number }) => Promise<HubLogRead>;
const reads: { fromBlock?: bigint; budgetMs?: number }[] = [];
const afters: (() => unknown)[] = [];

vi.mock("@/lib/server/chain", () => ({
  hubLog: {
    read: (o: { fromBlock?: bigint; budgetMs?: number }) => {
      reads.push(o);
      return impl(o);
    },
    settled: async () => undefined,
  },
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void afters.push(fn) }));

const { GET } = await import("../app/api/history/route.ts");
const call = async (qs = "") => {
  const res = await GET(new Request(`http://x/api/history${qs}`));
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body, decoded: fromJsonSafe<{ events: CopybookEvent[]; toBlock: bigint; fromBlock: bigint }>(body) };
};

const full = (o: { fromBlock?: bigint } = {}): Promise<HubLogRead> =>
  Promise.resolve({
    events: EVENTS.filter((e) => o.fromBlock === undefined || e.log.blockNumber! >= o.fromBlock),
    fromBlock: o.fromBlock ?? 100n,
    toBlock: 200n,
    complete: true,
    missing: [],
  });

beforeEach(() => {
  reads.length = 0;
  afters.length = 0;
  impl = full;
});

describe("GET /api/history", () => {
  it("serves the whole log, bigints encoded, cached for 30 s", async () => {
    const { res, body, decoded } = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
    expect(decoded.events.length).toBe(EVENTS.length);
    expect(decoded.toBlock).toBe(200n);
    expect(body.complete).toBe(true);
    const copy = decoded.events[2] as Extract<CopybookEvent, { name: "Copied" }> & { via: string };
    expect(copy.toSize).toBe(50000n);
    expect(copy.limitPrice).toBe(81065n * 10n ** 18n);
    expect(copy.via).toBe("handler");
    expect(JSON.stringify(body)).toContain('{"$bigint":"50000"}');
    expect(afters.length).toBe(1); // scans still running keep going after the response
  });

  it("leaves the raw topics and data out unless asked", async () => {
    const lean = (await call()).decoded.events[0].log;
    expect("topics" in lean).toBe(false);
    expect(lean.transactionHash).toBe(`0x${(1).toString(16).padStart(64, "0")}`);
    expect((await call("?raw=1")).decoded.events[0].log.topics).toEqual([]);
  });

  it("filters by follower", async () => {
    const { decoded } = await call(`?follower=${FOLLOWER.toLowerCase()}`);
    expect(decoded.events.map((e) => e.name)).toEqual(["Followed", "Copied", "TankCharged"]);
  });

  it("filters by a trader source: its follows and copies, and the reviews of that trader", async () => {
    const { decoded } = await call(`?source=${TRADER}`);
    expect(decoded.events.map((e) => e.name)).toEqual(["Followed", "Copied", "ReviewRequested", "VerdictReceived"]);
  });

  it("filters by a thesis id or a raw source id", async () => {
    expect((await call("?source=1")).decoded.events.map((e) => e.log.blockNumber)).toEqual([110n, 150n]);
    expect((await call(`?source=${THEME1}`)).decoded.events.map((e) => e.log.blockNumber)).toEqual([110n, 150n]);
  });

  it("passes fromBlock to the log so older segments are not read", async () => {
    const { decoded } = await call("?fromBlock=130");
    expect(reads[0].fromBlock).toBe(130n);
    expect(decoded.events.map((e) => e.log.blockNumber)).toEqual([130n, 140n, 150n]);
  });

  it("keeps the newest events under a limit, in chain order", async () => {
    const { body, decoded } = await call("?limit=2");
    expect(decoded.events.map((e) => e.log.blockNumber)).toEqual([140n, 150n]);
    expect(body.total).toBe(EVENTS.length);
  });

  it("says so when the log is incomplete, and caches that only briefly", async () => {
    impl = async () => ({ events: EVENTS.slice(0, 2), fromBlock: 100n, toBlock: 200n, complete: false, missing: [{ contract: "hub", from: 111n, to: 160n }] });
    const { res, body, decoded } = await call();
    expect(body.complete).toBe(false);
    expect(fromJsonSafe(body.missing)).toEqual([{ contract: "hub", from: 111n, to: 160n }]);
    expect(decoded.events.length).toBe(2);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=5");
  });

  it.each([
    ["?follower=0x1234", "invalid follower address"],
    ["?source=nope", "invalid source"],
    ["?source=0", "invalid source"],
    ["?fromBlock=-1", "invalid fromBlock"],
    ["?fromBlock=abc", "invalid fromBlock"],
    ["?limit=0", "invalid limit"],
    ["?limit=5001", "invalid limit"],
  ])("400 on %s", async (qs, error) => {
    const { res, body } = await call(qs);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error });
    expect(res.headers.get("cache-control")).toBeNull();
    expect(reads.length).toBe(0);
  });

  it("502 when the chain cannot be read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    impl = async () => {
      throw new Error("fetch failed https://rpc.example/secret");
    };
    const { res, body } = await call();
    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "chain unavailable" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(res.headers.get("cache-control")).toBeNull();
    spy.mockRestore();
  });
});

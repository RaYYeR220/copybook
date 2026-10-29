import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import type { RawLog } from "@copybook/sdk";
import type { TraderStats } from "@copybook/stats";
import { LEADER, sameBlockOpen, thesisRebalance } from "@/content/proof";
import { loadCopy, type CopyDeps, type CopyReceipt } from "@/lib/copy";
import { fromJsonSafe } from "@/lib/json";
import { copyCardModel, thesisCardModel, traderCardModel, type CardNames } from "@/lib/og/model";
import { CACHE_IMMUTABLE, CACHE_LIVE, cardResponse, copyCard, thesisCard, traderCard, type CardDeps } from "@/lib/og/respond";
import raw from "./fixtures/copies.json";

interface Entry {
  hash: Hex;
  receipt: CopyReceipt;
  tx: { from: Address; to: Address | null; input: Hex };
  blockTime: number;
  logs: { query: { block: bigint; address: Address }; result: RawLog[] }[];
}
const fx = fromJsonSafe<{ deployments: { hub: Address; themes: Address; marginBank: Address }; txs: Record<string, Entry> }>(raw);
const entries = Object.values(fx.txs);
const chain: CopyDeps = {
  deployments: { ...fx.deployments, gate: "0xEe5400000000000000000000000000000000020f" },
  receipt: async (h) => entries.find((e) => e.hash.toLowerCase() === h.toLowerCase())?.receipt ?? null,
  transaction: async (h) => entries.find((e) => e.hash.toLowerCase() === h.toLowerCase())!.tx,
  blockTime: async (b) => entries.find((e) => e.receipt.blockNumber === b)!.blockTime,
  logs: async (q) => entries.flatMap((e) => e.logs).find((l) => l.query.block === q.block && l.query.address.toLowerCase() === q.address.toLowerCase())?.result ?? [],
};

const BTC = "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0";
const ETH = "0xd6cb1dd58580b84d76068ac21594219ce03aeddf";
const OWNER = getAddress("0x5397812d66f3233e0972b7aeb5e195a945504632");
const names: CardNames = {
  markets: { [BTC]: { symbol: "BTC", decimals: 8 }, [ETH]: { symbol: "ETH", decimals: 18 } },
  theses: { "1": "BTC vs ETH" },
  demoLeader: getAddress(LEADER),
  // the owner and a demo wallet that published a thesis
  ours: [OWNER.toLowerCase(), "0xa969dd0b79ca1d4571e45d97a8f4981805ebaed3"],
};
/** The demo leader's 30-day record as /api/traders served it on 29 Oct 2026. */
const demoStats: TraderStats = {
  trader: LEADER,
  windowDays: 30,
  trades30d: 45,
  activeDays30d: 2,
  marketsTraded: 2,
  realizedPnl30d: -0.25,
  liquidations30d: 0,
  maxDrawdownAbs30d: 0.25,
  maxDrawdownPct30d: null,
  avgLeverage: null,
  lastActiveAt: "2026-10-28T13:37:18.000Z",
  hasHistory: true,
  truncated: false,
};
const NOW = 1793244876; // 29 Oct 2026, 03:34:36 UTC

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(res: Response) {
  const b = Buffer.from(await res.arrayBuffer());
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const cardDeps = (over: Partial<CardDeps> = {}): CardDeps => ({ names: async () => names, followers: async () => ({ n: 1, complete: true }), now: () => NOW, ...over });

describe("what the cards say, from chain data", () => {
  it("the same-block copy: block, the two tx positions, the move, the source", async () => {
    const v = await loadCopy(sameBlockOpen.copy.hash, undefined, chain);
    const m = copyCardModel(v!, names);
    expect(m).toMatchObject({
      sameBlock: true,
      block: "35,025,602",
      market: "BTC-PERP",
      move: "0 → long 0.0005 BTC",
      leader: { index: 0 },
      copy: { index: 22 },
      sentBy: null,
      source: "trader 0xA1d0…7b5d · demo leader, ours",
      sourceOurs: true,
    });
  });

  it("a copy sent by the follow call says so and claims no same block", async () => {
    const v = await loadCopy(fx.txs.followCopy.hash, undefined, chain);
    const m = copyCardModel(v!, names);
    expect(m.sameBlock).toBe(false);
    expect(m.leader).toBeNull();
    expect(m.sentBy).toBe("sent by a follow call to the hub");
    expect(m.source).toBe("thesis #1 · BTC vs ETH");
  });

  it("a market the indexer does not name keeps its raw units", async () => {
    const v = await loadCopy(thesisRebalance.copy.hash, undefined, chain);
    const m = copyCardModel(v!, { ...names, markets: {} });
    expect(m.market).toMatch(/^0x/);
    expect(m.move).toMatch(/units$/);
  });

  it("the trader card: record only when the indexer answered; PnL signed, never coloured", () => {
    const m = traderCardModel({ trader: getAddress(LEADER), demoLeader: getAddress(LEADER), stats: demoStats, verdict: { tier: "Caution", blocking: false }, followers: { n: 1, complete: false }, now: NOW });
    expect(m.demo).toBe(true);
    expect(m.stats?.map((s) => s.value)).toEqual(["−0.25", "45", "2 of 30"]);
    expect(m.verdict).toBe("CAUTION");
    expect(m.followers).toBe("at least 1 following through Copybook");
    const down = traderCardModel({ trader: getAddress(LEADER), demoLeader: OWNER, stats: null, verdict: null, followers: null, now: NOW });
    expect(down.stats).toBeNull();
    expect(down.noTrades).toBe(false);
    expect(down.followers).toBeNull();
  });

  it("the thesis card draws thesis #1's legs to scale and its minimum", () => {
    const m = thesisCardModel({
      id: 1n,
      name: "BTC vs ETH",
      version: 2,
      creator: OWNER,
      legs: [
        { pool: getAddress(BTC), weightBps: 7000 },
        { pool: getAddress(ETH), weightBps: -3000 },
      ],
      minimum: 30_700_000_000_000_000_000n,
      names,
      followers: { n: 1, complete: true },
      now: NOW,
    });
    expect(m.legs).toEqual([
      { market: "BTC-PERP", side: "long", pct: "70%", share: 1 },
      { market: "ETH-PERP", side: "short", pct: "30%", share: 3000 / 7000 },
    ]);
    expect(m).toMatchObject({ ours: true, gross: "100%", net: "40% long", opensFrom: "$30.70", followers: "1 following through Copybook" });
  });

  it("marks a thesis ours when any wallet Copybook runs published it, and no one else's", () => {
    const base = { id: 2n, name: "BTC over ETH, small", version: 2, legs: [{ pool: getAddress(BTC), weightBps: 12_000 }], minimum: null, names, followers: null, now: NOW };
    expect(thesisCardModel({ ...base, creator: getAddress("0xA969Dd0B79Ca1d4571E45d97A8f4981805eBaEd3") }).ours).toBe(true);
    expect(thesisCardModel({ ...base, creator: getAddress("0x1cf35c559bd4e1d45b738b83041855c8634e5a56") }).ours).toBe(false);
  });
});

describe("the card routes", () => {
  it("draws the copy card as a 1200×630 PNG, cached for good", async () => {
    const res = await copyCard(sameBlockOpen.copy.hash, undefined, { copy: (h, l) => loadCopy(h, l, chain), names: async () => names });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(CACHE_IMMUTABLE);
    expect(await pngSize(res)).toEqual({ width: 1200, height: 630 });
  });

  it("keeps a copy card for good only when every name resolved, and not at all while the source is unnamed", async () => {
    const copy = (h: string, l: number | undefined) => loadCopy(h, l, chain);
    const noMarkets = await copyCard(sameBlockOpen.copy.hash, undefined, { copy, names: async () => ({ ...names, markets: {} }) });
    expect(noMarkets.status).toBe(200);
    expect(noMarkets.headers.get("cache-control")).toBe(CACHE_LIVE);
    const noThesisName = await copyCard(thesisRebalance.copy.hash, undefined, { copy, names: async () => ({ ...names, theses: {} }) });
    expect(noThesisName.headers.get("cache-control")).toBe(CACHE_LIVE);
    const pending = await copyCard(fx.txs.followCopy.hash, undefined, {
      copy: (h, l) => loadCopy(h, l, { ...chain, transaction: async () => ({ ...fx.txs.followCopy.tx, input: "0xdeadbeef" as Hex }), sourceOf: async () => ({ source: null, complete: false }) }),
      names: async () => names,
    });
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("no-store");
  });

  it("a log read that fails is a 502, not a card without its move", async () => {
    const res = await copyCard(sameBlockOpen.copy.hash, undefined, {
      copy: (h, l) =>
        loadCopy(h, l, {
          ...chain,
          logs: async () => {
            throw new Error("timeout");
          },
        }),
      names: async () => names,
    });
    expect(res.status).toBe(502);
  });

  it("404 for a transaction with no Copied event, never a made-up card", async () => {
    const res = await copyCard(sameBlockOpen.leader.hash, undefined, { copy: (h, l) => loadCopy(h, l, chain), names: async () => names });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("cache-control")).not.toMatch(/immutable/);
    expect((await copyCard("0xnope", undefined, { copy: (h, l) => loadCopy(h, l, chain), names: async () => names })).status).toBe(404);
    expect((await copyCard(sameBlockOpen.copy.hash, 7, { copy: (h, l) => loadCopy(h, l, chain), names: async () => names })).status).toBe(404);
  });

  it("502, uncached, when the chain does not answer", async () => {
    const res = await copyCard(sameBlockOpen.copy.hash, undefined, {
      copy: async () => {
        throw new Error("rpc down");
      },
      names: async () => names,
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("draws the trader card, and refuses what is not an address", async () => {
    const deps = { ...cardDeps(), stats: async () => demoStats, verdict: async () => ({ tier: "Caution" as const, blocking: false }) };
    const res = await traderCard(LEADER, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(CACHE_LIVE);
    expect(await pngSize(res)).toEqual({ width: 1200, height: 630 });
    expect((await traderCard("0x123", deps)).status).toBe(404);
    // the indexer down still draws the card, without a record
    const down = await traderCard(LEADER, {
      ...deps,
      stats: async () => {
        throw new Error("indexer");
      },
    });
    expect(down.status).toBe(200);
  });

  it("draws the thesis card; 404 for a thesis that does not exist, 502 when the registry cannot be read", async () => {
    const thesis = async (id: bigint) => (id === 1n ? { name: "BTC vs ETH", version: 2, creator: OWNER, legs: [{ pool: getAddress(BTC), weightBps: 7000 }, { pool: getAddress(ETH), weightBps: -3000 }], minimum: null } : null);
    const res = await thesisCard("1", { ...cardDeps(), thesis });
    expect(res.status).toBe(200);
    expect(await pngSize(res)).toEqual({ width: 1200, height: 630 });
    expect((await thesisCard("2", { ...cardDeps(), thesis })).status).toBe(404);
    expect((await thesisCard("0", { ...cardDeps(), thesis })).status).toBe(404);
    expect((await thesisCard("x", { ...cardDeps(), thesis })).status).toBe(404);
    expect((await thesisCard("01", { ...cardDeps(), thesis })).status).toBe(404);
    expect((await thesisCard("001", { ...cardDeps(), thesis })).status).toBe(404);
    const down = await thesisCard("1", {
      ...cardDeps(),
      thesis: async () => {
        throw new Error("rpc");
      },
    });
    expect(down.status).toBe(502);
  });

  it("answers 404 before reading fonts", async () => {
    let read = false;
    const res = await cardResponse(async () => null, () => <div />, {
      cache: CACHE_LIVE,
      fonts: async () => {
        read = true;
        return [];
      },
    });
    expect(res.status).toBe(404);
    expect(read).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { CopybookEvent } from "@copybook/sdk";
import { createHubLog, type LoggedEvent } from "@/lib/server/hubLog";

const HUB = "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154" as Address;
const GATE = "0xEe54c49E9e70a0e5C2218Eec1b1BDBd4e1Cb20f1" as Address;
const FOLLOWER = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932" as Address;
const EOA = "0x5397812d66F3233E0972b7AEB5e195a945504632" as Address;
const SRC = `0x${"ab".repeat(32)}` as Hex;
const POOL = "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0" as Address;

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const log = (address: Address, block: number, tx: number, logIndex = 0) => ({
  address,
  blockNumber: BigInt(block),
  transactionHash: hash(tx),
  transactionIndex: 0,
  logIndex,
  topics: [] as Hex[],
  data: "0x" as Hex,
});
const copied = (block: number, tx: number): CopybookEvent => ({
  name: "Copied",
  follower: FOLLOWER,
  sourceId: SRC,
  pool: POOL,
  fromSize: 0n,
  toSize: 50000n,
  limitPrice: 1n,
  capped: false,
  log: log(HUB, block, tx),
});
const followed = (block: number, tx: number): CopybookEvent => ({ name: "Followed", follower: FOLLOWER, sourceId: SRC, kind: "Trader", ref: 1n, log: log(HUB, block, tx) });
const verdict = (block: number, tx: number): CopybookEvent => ({
  name: "VerdictReceived",
  sourceId: SRC,
  trader: EOA,
  tier: "Block",
  shannonRequestId: 7n,
  summaryHash: hash(9),
  log: log(GATE, block, tx),
});

/** A scripted chain: events by contract, a head, a sender per tx, and a record of every scan. */
function world(opts: { head: bigint; hub?: CopybookEvent[]; gate?: CopybookEvent[]; senders?: Record<string, Address>; slow?: (c: string, from: bigint) => Promise<void> | undefined; fail?: (c: string, from: bigint) => boolean }) {
  const scans: string[] = [];
  const state = { head: opts.head };
  const deps = {
    head: async () => state.head,
    scan: async (c: "hub" | "gate", from: bigint, to: bigint) => {
      scans.push(`${c}:${from}-${to}`);
      await opts.slow?.(c, from);
      if (opts.fail?.(c, from)) throw new Error("node refused");
      const all = (c === "hub" ? opts.hub : opts.gate) ?? [];
      return all.filter((e) => e.log.blockNumber! >= from && e.log.blockNumber! <= to);
    },
    senderOf: async (h: Hex) => opts.senders?.[h] ?? HUB,
    hub: HUB,
    gate: GATE,
    starts: { hub: 1000n, gate: 1500n },
    segmentBlocks: 100n,
    sealMargin: 10n,
    concurrency: 4,
  };
  return { deps, scans, state };
}

describe("hub log", () => {
  it("scans sealed segments once and the unsealed tail incrementally", async () => {
    const w = world({ head: 1265n, hub: [followed(1005, 1), copied(1250, 2)] });
    const hl = createHubLog(w.deps);
    const a = await hl.read();
    expect(a.complete).toBe(true);
    expect(a.fromBlock).toBe(1000n);
    expect(a.toBlock).toBe(1265n);
    // sealed up to 1255: hub 1000-1099, 1100-1199; tail 1200-1265. gate starts at 1500: nothing yet.
    expect(w.scans.sort()).toEqual(["hub:1000-1099", "hub:1100-1199", "hub:1200-1265"]);
    expect(a.events.map((e) => e.name)).toEqual(["Followed", "Copied"]);

    w.scans.length = 0;
    w.state.head = 1280n;
    const b = await hl.read();
    expect(w.scans).toEqual(["hub:1266-1280"]);
    expect(b.events.length).toBe(2);
    expect(b.toBlock).toBe(1280n);
  });

  it("seals a segment once the head is past it and drops the old tail", async () => {
    const w = world({ head: 1150n, hub: [copied(1120, 1), copied(1210, 2)] });
    const hl = createHubLog(w.deps);
    await hl.read(); // sealed: 1000-1099; tail: 1100-1150
    w.scans.length = 0;
    w.state.head = 1230n; // sealed now up to 1220: 1100-1199 seals; tail 1200-1230
    const r = await hl.read();
    expect(w.scans.sort()).toEqual(["hub:1100-1199", "hub:1200-1230"]);
    expect(r.events.map((e) => e.log.blockNumber)).toEqual([1120n, 1210n]);
  });

  it("merges hub and gate events in chain order, gate from its own deploy block", async () => {
    const w = world({ head: 1720n, hub: [copied(1600, 3), followed(1001, 1)], gate: [verdict(1550, 2)] });
    const r = await createHubLog(w.deps).read();
    expect(r.events.map((e) => [e.name, e.log.blockNumber])).toEqual([
      ["Followed", 1001n],
      ["VerdictReceived", 1550n],
      ["Copied", 1600n],
    ]);
    expect(w.scans.filter((s) => s.startsWith("gate:"))[0]).toBe("gate:1500-1599");
  });

  it("marks copies sent by the hub's handler apart from direct calls", async () => {
    const w = world({ head: 1050n, hub: [copied(1010, 1), copied(1020, 2)], senders: { [hash(2)]: EOA } });
    const r = await createHubLog(w.deps).read();
    expect(r.events.map((e) => (e as LoggedEvent).via)).toEqual(["handler", "call"]);
  });

  it("skips segments that end before fromBlock", async () => {
    const w = world({ head: 1265n, hub: [followed(1005, 1), copied(1250, 2)] });
    const r = await createHubLog(w.deps).read({ fromBlock: 1200n });
    expect(w.scans).toEqual(["hub:1200-1265"]);
    expect(r.events.map((e) => e.name)).toEqual(["Copied"]);
    expect(r.complete).toBe(true);
  });

  it("answers within its budget and lists what it has not read yet", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({ head: 1265n, hub: [followed(1005, 1), copied(1150, 2)], slow: (_c, from) => (from === 1100n ? gate : undefined) });
    const hl = createHubLog(w.deps);
    const r = await hl.read({ budgetMs: 30 });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([{ contract: "hub", from: 1100n, to: 1199n }]);
    expect(r.events.map((e) => e.name)).toEqual(["Followed"]);
    release();
    await hl.settled();
    const again = await hl.read({ budgetMs: 30 });
    expect(again.complete).toBe(true);
    expect(again.events.map((e) => e.name)).toEqual(["Followed", "Copied"]);
  });

  it("reports a failing segment as missing and retries it on the next read", async () => {
    let fail = true;
    const w = world({ head: 1150n, hub: [followed(1005, 1)], fail: (_c, from) => fail && from === 1000n });
    const hl = createHubLog(w.deps);
    const r = await hl.read();
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([{ contract: "hub", from: 1000n, to: 1099n }]);
    fail = false;
    const r2 = await hl.read();
    expect(r2.complete).toBe(true);
    expect(r2.events.length).toBe(1);
  });

  it("keeps sealed segments in the long-lived store, never the tail", async () => {
    const stored: string[] = [];
    const store = new Map<string, LoggedEvent[]>();
    const w = world({ head: 1150n, hub: [followed(1005, 1)] });
    const persist = async (key: string, load: () => Promise<LoggedEvent[]>) => {
      if (!store.has(key)) {
        stored.push(key);
        store.set(key, await load());
      }
      return store.get(key)!;
    };
    await createHubLog({ ...w.deps, persist }).read();
    expect(stored).toEqual([`hub:${HUB.toLowerCase()}:1000-1099:v1`]);
    // a fresh process reads the sealed segment from the store, not the chain
    w.scans.length = 0;
    const r = await createHubLog({ ...w.deps, persist }).read();
    expect(w.scans).toEqual(["hub:1100-1150"]);
    expect(r.events.length).toBe(1);
  });

  it("shares one scan between concurrent reads", async () => {
    const w = world({ head: 1150n, hub: [followed(1005, 1)] });
    const hl = createHubLog(w.deps);
    await Promise.all([hl.read(), hl.read(), hl.read()]);
    expect(w.scans.sort()).toEqual(["hub:1000-1099", "hub:1100-1150"]);
  });

  describe("checkpoints", () => {
    // segments of 100 blocks, a checkpoint every 1,000: hub from 1000, gate from 1500, sealed up to head - 10
    const store = () => {
      const m = new Map<string, LoggedEvent[]>();
      const gets: string[] = [];
      const persist = async (key: string, load: () => Promise<LoggedEvent[]>) => {
        gets.push(key);
        if (!m.has(key)) m.set(key, await load());
        return m.get(key)!;
      };
      return { m, gets, persist };
    };
    const hubScans = (w: { scans: string[] }) => w.scans.filter((x) => x.startsWith("hub:")).sort();
    const gateScans = (w: { scans: string[] }) => w.scans.filter((x) => x.startsWith("gate:")).sort();

    it("a cold instance reads one checkpoint, at most ten segments and the tail", async () => {
      const st = store();
      const evs = [followed(1005, 1), copied(1999, 2), copied(2000, 3), copied(2999, 4), copied(3050, 5), copied(3460, 6)];
      const w1 = world({ head: 3465n, hub: evs, gate: [verdict(1600, 7)] });
      const first = await createHubLog({ ...w1.deps, checkpointBlocks: 1000n, persist: st.persist }).read();
      expect(first.events.map((e) => e.log.blockNumber)).toEqual([1005n, 1600n, 1999n, 2000n, 2999n, 3050n, 3460n]);
      // building the store: every hub segment once (1000..3399 = 24) plus the tail
      expect(hubScans(w1).length).toBe(25);
      expect([...st.m.keys()].filter((k) => k.startsWith("ckpt:hub"))).toEqual([
        `ckpt:hub:${HUB.toLowerCase()}:1000-1999:v1`,
        `ckpt:hub:${HUB.toLowerCase()}:1000-2999:v1`,
      ]);

      // a fresh instance on the same store: only the open tails touch the chain
      const w2 = world({ head: 3465n, hub: evs, gate: [verdict(1600, 7)] });
      st.gets.length = 0;
      const again = await createHubLog({ ...w2.deps, checkpointBlocks: 1000n, persist: st.persist }).read();
      expect(w2.scans.sort()).toEqual(["gate:3400-3465", "hub:3400-3465"]);
      const hubGets = st.gets.filter((k) => k.includes(HUB.toLowerCase()));
      expect(hubGets.filter((k) => k.startsWith("ckpt:"))).toEqual([`ckpt:hub:${HUB.toLowerCase()}:1000-2999:v1`]);
      expect(hubGets.filter((k) => k.startsWith("hub:")).length).toBe(4); // 3000..3399
      expect(st.gets.filter((k) => k.startsWith("gate:")).length).toBeLessThanOrEqual(10);
      expect(again.events).toEqual(first.events);
      expect(again.complete).toBe(true);
    });

    it("a checkpoint ending exactly at the sealed edge is used, and the tail starts right after it", async () => {
      const w = world({ head: 3009n, hub: [copied(2999, 1), copied(3005, 2)] });
      const st = store();
      const r = await createHubLog({ ...w.deps, checkpointBlocks: 1000n, persist: st.persist }).read();
      expect(st.gets.filter((k) => k.startsWith("ckpt:hub"))).toContain(`ckpt:hub:${HUB.toLowerCase()}:1000-2999:v1`);
      expect(hubScans(w).at(-1)).toBe("hub:3000-3009");
      expect(r.events.map((e) => e.log.blockNumber)).toEqual([2999n, 3005n]);
    });

    it("one block short of a checkpoint's end, the previous checkpoint and nine segments carry it", async () => {
      const w = world({ head: 3008n, hub: [copied(2950, 1)] });
      const st = store();
      const r = await createHubLog({ ...w.deps, checkpointBlocks: 1000n, persist: st.persist }).read();
      const hubCkpts = [...new Set(st.gets.filter((k) => k.startsWith("ckpt:hub")))];
      expect(hubCkpts).toEqual([`ckpt:hub:${HUB.toLowerCase()}:1000-1999:v1`]);
      expect(hubScans(w)).toContain("hub:2900-3008"); // the segment 2900-2999 is not sealed yet: it is the tail
      expect(hubScans(w)).toContain("hub:2800-2899");
      expect(r.events.map((e) => e.log.blockNumber)).toEqual([2950n]);
    });

    it("a fromBlock past every checkpoint reads only the segments after it", async () => {
      const w = world({ head: 3465n, hub: [copied(1500, 1), copied(3100, 2)] });
      const st = store();
      const r = await createHubLog({ ...w.deps, checkpointBlocks: 1000n, persist: st.persist }).read({ fromBlock: 3050n });
      expect(st.gets.filter((k) => k.startsWith("ckpt:"))).toEqual([]);
      expect(hubScans(w)).toEqual(["hub:3000-3099", "hub:3100-3199", "hub:3200-3299", "hub:3300-3399", "hub:3400-3465"]);
      expect(gateScans(w)).toEqual(["gate:3000-3099", "gate:3100-3199", "gate:3200-3299", "gate:3300-3399", "gate:3400-3465"]);
      expect(r.events.map((e) => e.log.blockNumber)).toEqual([3100n]);
    });

    it("a fromBlock inside a checkpoint reads the checkpoint and filters it", async () => {
      const w = world({ head: 2015n, hub: [copied(1200, 1), copied(1700, 2)] });
      const st = store();
      const r = await createHubLog({ ...w.deps, checkpointBlocks: 1000n, persist: st.persist }).read({ fromBlock: 1500n });
      expect(st.gets).toContain(`ckpt:hub:${HUB.toLowerCase()}:1000-1999:v1`);
      expect(r.events.map((e) => e.log.blockNumber)).toEqual([1700n]);
    });

    it("a failed checkpoint is reported as its whole range and rebuilt on the next read", async () => {
      let fail = true;
      const w = world({ head: 2015n, hub: [copied(1200, 1)], fail: (c, from) => fail && c === "hub" && from === 1300n });
      const hl = createHubLog({ ...w.deps, checkpointBlocks: 1000n });
      const r = await hl.read();
      expect(r.complete).toBe(false);
      expect(r.missing).toEqual([{ contract: "hub", from: 1000n, to: 1999n }]);
      fail = false;
      const r2 = await hl.read();
      expect(r2.complete).toBe(true);
      expect(r2.events.map((e) => e.log.blockNumber)).toEqual([1200n]);
    });
  });
});

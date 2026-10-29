import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, toHex, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { hubAbi } from "../src/abi/hub.ts";
import { getHubHistory } from "../src/history.ts";
import { watchHub, type WatchTransport } from "../src/watch.ts";
import type { CopybookEvent } from "../src/events.ts";
import { ETH, ME, TRADER, world } from "./world.ts";
import { deployments } from "./fake.ts";

const SID = `0x${"aa".repeat(32)}` as Hex;

function hubLog(eventName: string, args: Record<string, unknown>, block: bigint, logIndex = 0, tx = "ab") {
  const item = getAbiItem({ abi: hubAbi as Abi, name: eventName }) as AbiEvent;
  const topics = encodeEventTopics({ abi: hubAbi as Abi, eventName, args } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name!]) as never) : "0x";
  return {
    address: deployments.hub,
    topics,
    data,
    blockNumber: toHex(block),
    transactionHash: `0x${tx.repeat(32)}`,
    transactionIndex: "0x0",
    blockHash: `0x${"cd".repeat(32)}`,
    logIndex: toHex(logIndex),
    removed: false,
  };
}
const copied = (follower: Address, block: bigint, logIndex = 0, to = 1n, tx = "ab") =>
  hubLog("Copied", { follower, sourceId: SID, pool: ETH, fromSize: 0n, toSize: to, price: 10n, capped: false }, block, logIndex, tx);

describe("getHubHistory", () => {
  it("reads in chunks, orders by block and log index, and drops duplicates", async () => {
    const c = world();
    c.head = 250n;
    c.logs = [copied(ME, 210n, 1, 2n, "02"), copied(ME, 10n, 0, 1n, "01"), copied(ME, 210n, 0, 3n, "03")];
    const h = await getHubHistory({ publicClient: c.publicClient, deployments }, { fromBlock: 0n, chunkSize: 100n });
    expect(h.toBlock).toBe(250n);
    expect(h.events.map((e) => (e.name === "Copied" ? e.toSize : -1n))).toEqual([1n, 3n, 2n]);
    const calls = c.rpc.filter((r) => r.method === "eth_getLogs");
    expect(calls).toHaveLength(3);
  });

  it("filters server-side by follower and leaves out events that name none", async () => {
    const c = world();
    c.head = 100n;
    c.logs = [copied(ME, 5n, 0, 1n, "01"), copied(TRADER, 6n, 0, 2n, "02"), hubLog("GroupDeferred", { sourceId: SID, group: 0, fromIndex: 1n }, 7n, 0, "03")];
    const h = await getHubHistory({ publicClient: c.publicClient, deployments }, { fromBlock: 0n, follower: ME });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ name: "Copied", follower: ME });
  });

  it("halves the range when the node refuses it", async () => {
    const c = world();
    c.head = 999n;
    c.getLogsFailAbove = 300n;
    c.logs = [copied(ME, 900n, 0, 1n, "01")];
    const h = await getHubHistory({ publicClient: c.publicClient, deployments }, { fromBlock: 0n, chunkSize: 1_000n });
    expect(h.events).toHaveLength(1);
  });

  it("returns nothing for an empty range", async () => {
    const c = world();
    const h = await getHubHistory({ publicClient: c.publicClient, deployments }, { fromBlock: 50n, toBlock: 10n });
    expect(h.events).toEqual([]);
  });
});

/** A hand-driven stand-in for the somnia_watch socket: it only ever sends ticks. */
class FakeSocket implements WatchTransport {
  subs: { tick: () => void; drop: (e?: unknown) => void; closed: boolean }[] = [];
  failNext = 0;
  hangNext = 0;
  hung: { closed: boolean; resolve: () => void }[] = [];
  async subscribe(p: Parameters<WatchTransport["subscribe"]>[0]) {
    if (this.hangNext > 0) {
      // a socket that accepts the subscription and never answers it (a dead cached client)
      this.hangNext--;
      const h = { closed: false, resolve: () => {} };
      this.hung.push(h);
      return new Promise<{ close(): Promise<void> }>((r) => (h.resolve = () => r({ close: async () => void (h.closed = true) })));
    }
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("socket refused");
    }
    const sub = { tick: p.onTick, drop: p.onClose, closed: false };
    this.subs.push(sub);
    return { close: async () => void (sub.closed = true) };
  }
  get live() {
    return this.subs[this.subs.length - 1]!;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sizes = (got: { e: CopybookEvent }[]) => got.map((g) => (g.e.name === "Copied" ? g.e.toSize : -1n));

async function start(c: ReturnType<typeof world>, sock: FakeSocket, extra: Partial<Parameters<typeof watchHub>[0]> = {}) {
  const got: { e: CopybookEvent; source: string }[] = [];
  const errors: unknown[] = [];
  const h = await watchHub({
    publicClient: c.publicClient,
    deployments,
    transport: sock,
    reconnect: { minDelayMs: 5, maxDelayMs: 10 },
    onEvent: (e, i) => got.push({ e, source: i.source }),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { h, got, errors };
}

describe("watchHub", () => {
  it("treats a notification as a tick and emits what the chain logged, with its block", async () => {
    const c = world();
    c.head = 1_000n;
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock);
    await wait(20);
    c.head = 1_001n;
    c.logs = [copied(ME, 1_001n, 0, 1n, "01")];
    sock.live.tick();
    await wait(30);
    expect(got).toHaveLength(1);
    expect(got[0]!.e).toMatchObject({ name: "Copied", follower: ME });
    expect(got[0]!.e.log).toMatchObject({ blockNumber: 1_001n, logIndex: 0 });
    expect(got[0]!.source).toBe("live");
    expect(h.lastBlock).toBe(1_001n);
    await h.stop();
    expect(sock.live.closed).toBe(true);
  });

  it("filters to one follower", async () => {
    const c = world();
    c.head = 1_000n;
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock, { follower: ME });
    await wait(20);
    c.head = 1_003n;
    c.logs = [copied(TRADER, 1_001n, 0, 1n, "01"), copied(ME, 1_002n, 0, 2n, "02")];
    sock.live.tick();
    await wait(30);
    expect(sizes(got)).toEqual([2n]);
    await h.stop();
  });

  it("a tick with a malformed payload still triggers a fetch", async () => {
    const c = world();
    c.head = 1_000n;
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock);
    await wait(20);
    c.head = 1_002n;
    c.logs = [copied(ME, 1_002n, 0, 7n, "07")];
    // the transport hands over no usable payload at all; the tick alone is the signal
    (sock.live.tick as (x?: unknown) => void)({ garbage: true });
    await wait(30);
    expect(sizes(got)).toEqual([7n]);
    await h.stop();
  });

  it("two consecutive reconnects with overlapping windows deliver every event exactly once", async () => {
    const c = world();
    c.head = 1_000n;
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock);
    await wait(20);
    c.head = 1_002n;
    c.logs = [copied(ME, 1_001n, 0, 1n, "01")];
    sock.live.tick();
    await wait(30);
    // first drop: an event lands while down
    c.head = 1_005n;
    c.logs.push(copied(ME, 1_004n, 0, 2n, "02"));
    sock.live.drop(new Error("closed"));
    await wait(60);
    expect(sock.subs).toHaveLength(2);
    // second drop right away: same window is read again, plus one more event
    c.head = 1_009n;
    c.logs.push(copied(ME, 1_008n, 0, 3n, "03"), copied(ME, 1_008n, 1, 4n, "03"));
    sock.live.drop(new Error("closed again"));
    await wait(60);
    expect(sock.subs).toHaveLength(3);
    sock.live.tick();
    await wait(30);
    expect(sizes(got)).toEqual([1n, 2n, 3n, 4n]);
    expect(got.map((g) => g.source)).toEqual(["live", "backfill", "backfill", "backfill"]);
    await h.stop();
  });

  it("ticks that arrive faster than the reads neither duplicate nor miss events", async () => {
    const c = world();
    c.head = 1_000n;
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock);
    await wait(20);
    c.head = 1_010n;
    c.logs = [copied(ME, 1_005n, 0, 1n, "01")];
    const before = c.rpc.filter((r) => r.method === "eth_getLogs").length;
    // a burst of ticks while the first fetch is still in flight, then a late event the first fetch cannot have seen
    for (let i = 0; i < 20; i++) sock.live.tick();
    c.logs.push(copied(ME, 1_010n, 0, 2n, "02"));
    await wait(80);
    expect(sizes(got)).toEqual([1n, 2n]);
    // 20 ticks coalesce into at most two fetches, never twenty
    expect(c.rpc.filter((r) => r.method === "eth_getLogs").length - before).toBeLessThanOrEqual(2);
    await h.stop();
  });

  it("keeps retrying with backoff while the socket refuses, and stops when asked", async () => {
    const c = world();
    const sock = new FakeSocket();
    const { h, errors } = await start(c, sock, { reconnect: { minDelayMs: 5, maxDelayMs: 20 } });
    sock.failNext = 2;
    sock.live.drop();
    await wait(200);
    expect(errors.filter((e) => String(e).includes("refused"))).toHaveLength(2);
    expect(sock.subs).toHaveLength(2);
    await h.stop();
    sock.live.drop();
    await wait(50);
    expect(sock.subs).toHaveLength(2);
  });

  it("a subscription that never answers times out and is retried on a new one", async () => {
    const c = world();
    const sock = new FakeSocket();
    sock.hangNext = 1;
    const statuses: string[] = [];
    const { h, errors } = await start(c, sock, { subscribeTimeoutMs: 30, onStatus: (s) => statuses.push(s) });
    await wait(120);
    expect(errors.some((e) => String(e).includes("did not answer"))).toBe(true);
    expect(sock.subs).toHaveLength(1); // the retry got through
    expect(statuses.at(-1)).toBe("live");
    // the stale subscription answering late is closed and its socket never drives the watcher
    sock.hung[0]!.resolve();
    await wait(20);
    expect(sock.hung[0]!.closed).toBe(true);
    await h.stop();
  });

  it("from a given block, the first connect delivers what landed between that block and the head", async () => {
    // a feed seeded from history read up to 1_004 starts the watcher there: the events of 1_005..1_008 are not lost
    const c = world();
    c.head = 1_010n;
    c.logs = [copied(ME, 1_003n, 0, 1n, "01"), copied(ME, 1_005n, 0, 2n, "02"), copied(ME, 1_008n, 0, 3n, "03")];
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock, { fromBlock: 1_004n, chunkSize: 1_000n });
    await wait(40);
    expect(sizes(got)).toEqual([2n, 3n]);
    expect(got.every((g) => g.source === "backfill")).toBe(true);
    const first = c.rpc.find((r) => r.method === "eth_getLogs")!;
    expect((first.params as { fromBlock: Hex }[])[0]!.fromBlock).toBe(toHex(1_004n));
    expect(h.lastBlock).toBe(1_010n);
    await h.stop();
  });

  it("without fromBlock it starts at the head and delivers nothing older", async () => {
    const c = world();
    c.head = 1_010n;
    c.logs = [copied(ME, 1_005n, 0, 2n, "02")];
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock);
    await wait(40);
    expect(got).toEqual([]);
    await h.stop();
  });

  it("forgets old keys past the delivered capacity but never repeats a recent one", async () => {
    const c = world();
    c.head = 1_000n;
    const sock = new FakeSocket();
    const { h, got } = await start(c, sock, { deliveredCapacity: 2 });
    await wait(20);
    c.head = 1_003n;
    c.logs = [copied(ME, 1_001n, 0, 1n, "01"), copied(ME, 1_002n, 0, 2n, "02"), copied(ME, 1_003n, 0, 3n, "03")];
    sock.live.tick();
    await wait(30);
    sock.live.tick();
    await wait(30);
    // the cursor sits at the head, so the window holds only the newest block: 3n is re-read and still deduped
    expect(sizes(got)).toEqual([1n, 2n, 3n]);
    await h.stop();
  });
});

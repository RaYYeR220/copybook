import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, toHex, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { hubAbi } from "../src/abi/hub.ts";
import { getHubHistory } from "../src/history.ts";
import { watchHub, type WatchNotification, type WatchTransport } from "../src/watch.ts";
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

/** A hand-driven stand-in for the somnia_watch socket. */
class FakeSocket implements WatchTransport {
  subs: { push: (n: WatchNotification) => void; drop: (e?: unknown) => void; closed: boolean }[] = [];
  failNext = 0;
  async subscribe(p: Parameters<WatchTransport["subscribe"]>[0]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("socket refused");
    }
    const sub = { push: p.onNotification, drop: p.onClose, closed: false };
    this.subs.push(sub);
    return { close: async () => void (sub.closed = true) };
  }
  get live() {
    return this.subs[this.subs.length - 1]!;
  }
}

const notify = (log: ReturnType<typeof hubLog>, block: bigint): WatchNotification => ({
  address: log.address,
  topics: log.topics,
  data: log.data,
  simulationResults: [toHex(block, { size: 32 })],
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchHub", () => {
  it("delivers live events, reading their block from the notification", async () => {
    const c = world();
    const sock = new FakeSocket();
    const got: CopybookEvent[] = [];
    const h = await watchHub({ publicClient: c.publicClient, deployments, transport: sock, onEvent: (e) => got.push(e) });
    sock.live.push(notify(copied(ME, 1001n), 1001n));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: "Copied", follower: ME });
    expect(got[0]!.log.blockNumber).toBe(1001n);
    expect(h.lastBlock).toBe(1001n);
    await h.stop();
    expect(sock.live.closed).toBe(true);
  });

  it("filters to one follower and ignores foreign logs", async () => {
    const c = world();
    const sock = new FakeSocket();
    const got: CopybookEvent[] = [];
    await watchHub({ publicClient: c.publicClient, deployments, transport: sock, follower: ME, onEvent: (e) => got.push(e) });
    sock.live.push(notify(copied(TRADER, 1001n), 1001n));
    sock.live.push({ ...notify(copied(ME, 1002n), 1002n), address: TRADER });
    sock.live.push(notify(copied(ME, 1003n), 1003n));
    expect(got).toHaveLength(1);
  });

  it("reconnects after a drop and backfills the gap without repeating what it already delivered", async () => {
    const c = world();
    c.head = 1_000n;
    const sock = new FakeSocket();
    const got: { e: CopybookEvent; source: string }[] = [];
    const statuses: string[] = [];
    const h = await watchHub({
      publicClient: c.publicClient,
      deployments,
      transport: sock,
      reconnect: { minDelayMs: 5, maxDelayMs: 10 },
      onEvent: (e, i) => got.push({ e, source: i.source }),
      onStatus: (s) => statuses.push(s),
    });
    const first = copied(ME, 1_001n, 0, 1n, "01");
    sock.live.push(notify(first, 1_001n));
    // the socket drops; two more events land on chain while it is down
    c.head = 1_010n;
    c.logs = [first, copied(ME, 1_004n, 0, 2n, "02"), copied(ME, 1_006n, 0, 3n, "03")];
    sock.live.drop(new Error("closed"));
    await wait(80);
    expect(sock.subs).toHaveLength(2);
    expect(got.map((g) => [g.source, g.e.name === "Copied" ? g.e.toSize : 0n])).toEqual([
      ["live", 1n],
      ["backfill", 2n],
      ["backfill", 3n],
    ]);
    // live resumes on the new socket
    sock.live.push(notify(copied(ME, 1_011n, 0, 4n, "04"), 1_011n));
    expect(got).toHaveLength(4);
    expect(statuses).toContain("reconnecting");
    expect(statuses.filter((s) => s === "live")).toHaveLength(2);
    await h.stop();
  });

  it("keeps retrying with backoff while the socket refuses", async () => {
    const c = world();
    const sock = new FakeSocket();
    const errors: unknown[] = [];
    const h = await watchHub({ publicClient: c.publicClient, deployments, transport: sock, reconnect: { minDelayMs: 5, maxDelayMs: 20 }, onEvent: () => {}, onError: (e) => errors.push(e) });
    sock.failNext = 2;
    sock.live.drop();
    await wait(150);
    expect(errors).toHaveLength(2);
    expect(sock.subs).toHaveLength(2);
    await h.stop();
    // no further attempts after stop
    sock.live.drop();
    await wait(50);
    expect(sock.subs).toHaveLength(2);
  });
});

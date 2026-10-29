import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { eventKey, type CopybookEvent, type WatchHandle, type WatchStatus } from "@copybook/sdk";
import type { LoggedEvent } from "@/lib/events";
import { createFeed, resumeAfter, type FeedDeps, type FeedState, type HistoryAnswer } from "@/lib/feedController";

const HUB = "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154" as Address;
const FOLLOWER = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932" as Address;
const SRC = `0x${"ab".repeat(32)}` as Hex;

const copy = (block: number, logIndex = 0): LoggedEvent =>
  ({
    name: "Copied",
    follower: FOLLOWER,
    sourceId: SRC,
    pool: HUB,
    fromSize: 0n,
    toSize: 1n,
    limitPrice: 1n,
    capped: false,
    log: { address: HUB, blockNumber: BigInt(block), transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex, transactionIndex: 0, logIndex, topics: [], data: "0x" },
  }) as LoggedEvent;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scripted chain behind the watcher: what it holds, from which block each watcher was started, and its sockets. */
function harness(
  answers: HistoryAnswer[],
  chain: LoggedEvent[],
  opts: { stopMs?: number; deferFirst?: boolean; rejectFirst?: number } = {},
) {
  const historyCalls: (bigint | undefined)[] = [];
  const watches: { fromBlock?: bigint; status: (s: WatchStatus) => void; stopped: boolean }[] = [];
  let hidden = false;
  let calls = 0;
  let release: () => void = () => {};
  const deps: FeedDeps = {
    retryMs: { min: 5, max: 20 },
    history: async (fromBlock) => {
      historyCalls.push(fromBlock);
      const a = answers[Math.min(historyCalls.length - 1, answers.length - 1)]!;
      return { ...a, events: a.events.filter((e) => fromBlock === undefined || e.log.blockNumber! >= fromBlock) };
    },
    watch: async ({ fromBlock, onEvent, onStatus }) => {
      const n = ++calls;
      if (n <= (opts.rejectFirst ?? 0)) throw new Error("the somnia_watch socket did not open within 10000 ms");
      const w = { fromBlock, status: onStatus, stopped: false };
      watches.push(w);
      onStatus("connecting");
      // the first watcher can be held mid-connect until the test releases it
      if (n === 1 && opts.deferFirst) await new Promise<void>((r) => (release = r));
      onStatus("live");
      // like the SDK: the first read covers [fromBlock, head] of what the chain holds
      for (const e of chain) if (fromBlock === undefined || e.log.blockNumber! >= fromBlock) onEvent(e);
      const handle: WatchHandle = {
        lastBlock: chain.reduce((m, e) => (e.log.blockNumber! > m ? e.log.blockNumber! : m), fromBlock ?? 0n),
        stop: async () => {
          await wait(opts.stopMs ?? 0);
          w.stopped = true;
          onStatus("stopped");
        },
      };
      return handle;
    },
    annotate: async (e) => e,
    keep: () => true,
    hidden: () => hidden,
    live: true,
    cap: 400,
  };
  const states: FeedState[] = [];
  const feed = createFeed(deps, (s) => states.push(s));
  return {
    feed,
    historyCalls,
    watches,
    states,
    setHidden: (h: boolean) => (hidden = h),
    last: () => states.at(-1)!,
    release: () => release(),
    running: () => watches.filter((w) => !w.stopped).length,
  };
}

const keysOf = (s: FeedState) => s.events.map(eventKey);

describe("resume point", () => {
  it("a complete answer resumes at its end; a partial one at its first unread block", () => {
    expect(resumeAfter(undefined, { toBlock: 1010n, complete: true, missing: [] })).toBe(1010n);
    expect(resumeAfter(undefined, { toBlock: 1010n, complete: false, missing: [{ contract: "gate", from: 1008n, to: 1010n }, { contract: "hub", from: 1006n, to: 1010n }] })).toBe(1006n);
  });

  it("a complete answer never moves the start back; a partial one never moves it forward", () => {
    expect(resumeAfter(1200n, { toBlock: 1100n, complete: true, missing: [] })).toBe(1200n);
    expect(resumeAfter(1200n, { toBlock: 1300n, complete: true, missing: [] })).toBe(1300n);
    expect(resumeAfter(1200n, { toBlock: 1300n, complete: false, missing: [{ contract: "hub", from: 1250n, to: 1300n }] })).toBe(1200n);
    expect(resumeAfter(1200n, { toBlock: 1300n, complete: false, missing: [{ contract: "hub", from: 1150n, to: 1300n }] })).toBe(1150n);
  });
});

describe("feed", () => {
  it("a partial history with a missing tail: the watcher starts at the first missing block and those events arrive once", async () => {
    const chain = [copy(1003), copy(1007), copy(1009)];
    // the route read up to 1010 but could not cover 1006..1010 in time: it holds only 1003
    const h = harness([{ events: [copy(1003)], toBlock: 1010n, complete: false, missing: [{ contract: "hub", from: 1006n, to: 1010n }] }], chain);
    await h.feed.open();
    await wait(5);
    expect(h.watches[0]!.fromBlock).toBe(1006n);
    expect(keysOf(h.last())).toEqual([copy(1009), copy(1007), copy(1003)].map(eventKey));
    expect(new Set(keysOf(h.last())).size).toBe(3);
    // the status line does not claim the unread tail
    expect(h.states.find((s) => s.loaded)!.readTo).toBe(1005n);
    expect(h.last().status).toBe("live");
  });

  it("a complete history: the watcher starts at the block the history ended on, and the overlap merges away", async () => {
    const chain = [copy(1003), copy(1010), copy(1012)];
    const h = harness([{ events: [copy(1003), copy(1010)], toBlock: 1010n, complete: true, missing: [] }], chain);
    await h.feed.open();
    await wait(5);
    expect(h.watches[0]!.fromBlock).toBe(1010n);
    expect(keysOf(h.last())).toEqual([copy(1012), copy(1010), copy(1003)].map(eventKey));
  });

  it("a hide and a show inside the stop's socket close: the new watcher's status wins, not a late 'paused'", async () => {
    const chain = [copy(1003)];
    const h = harness([{ events: [copy(1003)], toBlock: 1010n, complete: true, missing: [] }], chain, { stopMs: 60 });
    await h.feed.open();
    h.setHidden(true);
    const hiding = h.feed.visibility(true); // its stop takes 60 ms to close the socket
    await wait(5);
    h.setHidden(false);
    await h.feed.visibility(false); // shown again before that: history from the resume point, then a new watcher
    await hiding;
    await wait(80);
    expect(h.watches).toHaveLength(2);
    expect(h.watches[0]!.stopped).toBe(true);
    expect(h.last().status).toBe("live");
    expect(h.states.some((s) => s.status === "paused")).toBe(false);
  });

  it("a plain hide pauses; the show resumes from where the stopped watcher had read", async () => {
    const chain = [copy(1003), copy(1020)];
    const h = harness([{ events: [copy(1003)], toBlock: 1010n, complete: true, missing: [] }], chain);
    await h.feed.open();
    h.setHidden(true);
    await h.feed.visibility(true);
    expect(h.last().status).toBe("paused");
    h.setHidden(false);
    await h.feed.visibility(false);
    expect(h.historyCalls).toEqual([undefined, 1020n]);
    expect(h.watches[1]!.fromBlock).toBe(1020n);
    expect(h.last().status).toBe("live");
    expect(new Set(keysOf(h.last())).size).toBe(2);
  });

  it("after a reconnect the history is read again from the last block seen", async () => {
    const chain = [copy(1003), copy(1015)];
    const h = harness([{ events: [copy(1003)], toBlock: 1010n, complete: true, missing: [] }], chain);
    await h.feed.open();
    await wait(5);
    h.watches[0]!.status("reconnecting");
    h.watches[0]!.status("live");
    await wait(5);
    expect(h.historyCalls).toEqual([undefined, 1015n]);
  });

  describe("while a watcher is still connecting", () => {
    const answer: HistoryAnswer = { events: [copy(1003)], toBlock: 1010n, complete: true, missing: [] };

    it("hidden then shown: the connecting one is closed and exactly one live watcher remains", async () => {
      const h = harness([answer], [copy(1003)], { deferFirst: true });
      void h.feed.open();
      await wait(5);
      expect(h.watches).toHaveLength(1); // connecting
      h.setHidden(true);
      await h.feed.visibility(true);
      h.setHidden(false);
      await h.feed.visibility(false); // its start finds the first one still connecting
      h.release();
      await wait(20);
      expect(h.watches).toHaveLength(2);
      expect(h.watches[0]!.stopped).toBe(true);
      expect(h.running()).toBe(1);
      expect(h.last().status).toBe("live");
    });

    it("hidden and staying hidden: no watcher, paused", async () => {
      const h = harness([answer], [copy(1003)], { deferFirst: true });
      void h.feed.open();
      await wait(5);
      h.setHidden(true);
      await h.feed.visibility(true);
      h.release();
      await wait(20);
      expect(h.running()).toBe(0);
      expect(h.watches).toHaveLength(1);
      expect(h.last().status).toBe("paused");
    });

    it("disposed: no watcher", async () => {
      const h = harness([answer], [copy(1003)], { deferFirst: true });
      void h.feed.open();
      await wait(5);
      await h.feed.dispose();
      h.release();
      await wait(20);
      expect(h.running()).toBe(0);
      expect(h.watches).toHaveLength(1);
    });
  });

  it("a watcher that fails to start is retried with backoff, not left as an unhandled rejection", async () => {
    const h = harness([{ events: [], toBlock: 1010n, complete: true, missing: [] }], [copy(1012)], { rejectFirst: 2 });
    await h.feed.open(); // resolves: the failure is handled
    expect(h.last().status).toBe("reconnecting");
    expect(h.watches).toHaveLength(0);
    await wait(60); // 5 ms, then 10 ms
    expect(h.watches).toHaveLength(1);
    expect(h.running()).toBe(1);
    expect(h.watches[0]!.fromBlock).toBe(1010n);
    expect(h.last().status).toBe("live");
    expect(h.last().events.map((e) => e.log.blockNumber)).toEqual([1012n]);
  });

  it("a retry pending when the tab is hidden is dropped; the show starts a watcher", async () => {
    const h = harness([{ events: [], toBlock: 1010n, complete: true, missing: [] }], [], { rejectFirst: 1 });
    await h.feed.open();
    h.setHidden(true);
    await h.feed.visibility(true);
    await wait(30);
    expect(h.watches).toHaveLength(0);
    h.setHidden(false);
    await h.feed.visibility(false);
    expect(h.running()).toBe(1);
  });

  it("a stopped watcher's late reports are ignored", async () => {
    const h = harness([{ events: [], toBlock: 1010n, complete: true, missing: [] }], []);
    await h.feed.open();
    h.setHidden(true);
    await h.feed.visibility(true);
    h.watches[0]!.status("reconnecting");
    expect(h.last().status).toBe("paused");
  });
});

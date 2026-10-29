import type { Address, Hex } from "viem";
import { eventKey, type CopybookEvent } from "@copybook/sdk";
import { viaOf, type Contract, type LoggedEvent, type MissingRange } from "../events";

export { viaOf, type Contract, type LoggedEvent, type MissingRange, type Via } from "../events";

export interface HubLogRead {
  /** Chain order, no duplicates. */
  events: LoggedEvent[];
  /** First block the log covers (the requested `fromBlock`, or the hub's deploy block). */
  fromBlock: bigint;
  /** The chain head this read went up to. */
  toBlock: bigint;
  /** False when some ranges could not be read in time or failed; they are listed in `missing`. */
  complete: boolean;
  missing: MissingRange[];
}

export interface HubLogDeps {
  head(): Promise<bigint>;
  /** Every Copybook event one contract logged over [from, to] (the SDK's chunked history). */
  scan(contract: Contract, from: bigint, to: bigint): Promise<CopybookEvent[]>;
  /** The sender of a transaction. */
  senderOf(hash: Hex): Promise<Address>;
  hub: Address;
  gate: Address;
  /** First block worth reading per contract: its deploy block. */
  starts: Record<Contract, bigint>;
  /** Blocks per cached segment. */
  segmentBlocks?: bigint;
  /**
   * Blocks per cumulative checkpoint (a multiple of segmentBlocks). Checkpoint k holds every event from the
   * contract's start to the end of its (k+1)-th span, built from checkpoint k-1 and its own segments and cached for
   * good, so a cold process reads one checkpoint, at most a checkpoint's worth of segments, and the open tail.
   */
  checkpointBlocks?: bigint;
  /** A segment ending at least this far below the head is final and cached for good. */
  sealMargin?: bigint;
  /** Segments read at once. */
  concurrency?: number;
  /** A long-lived store for sealed segments (the Next data cache in production). */
  persist?: (key: string, load: () => Promise<LoggedEvent[]>) => Promise<LoggedEvent[]>;
}

/** Bump when what a cached segment holds changes shape. */
const VERSION = "v1";

const byChain = (a: CopybookEvent, b: CopybookEvent) =>
  Number((a.log.blockNumber ?? 0n) - (b.log.blockNumber ?? 0n)) ||
  (a.log.transactionIndex ?? 0) - (b.log.transactionIndex ?? 0) ||
  (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0);

function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * The hub's (and the risk gate's) event log since deployment, read in fixed block segments. A segment that ends
 * safely below the head is final: it is read once and kept (in memory and in `persist`). The open segment at the
 * head is extended incrementally. Concurrent reads share every scan, a read can answer within a time budget
 * (listing what it has not covered yet while the scans finish), and a failed segment is retried on the next read.
 */
export function createHubLog(deps: HubLogDeps) {
  const SEG = deps.segmentBlocks ?? 10_000n;
  const CP = deps.checkpointBlocks ?? SEG * 10n;
  if (CP % SEG !== 0n) throw new Error("checkpointBlocks must be a multiple of segmentBlocks");
  const MARGIN = deps.sealMargin ?? 64n;
  const run = limiter(deps.concurrency ?? 12);
  const address = (c: Contract) => (c === "hub" ? deps.hub : deps.gate);

  const sealed = new Map<string, LoggedEvent[]>();
  const inflight = new Map<string, Promise<LoggedEvent[]>>();
  const tails = new Map<Contract, { from: bigint; to: bigint; events: LoggedEvent[] }>();
  const tailInflight = new Map<Contract, Promise<void>>();

  async function annotate(c: Contract, events: CopybookEvent[]): Promise<LoggedEvent[]> {
    if (c !== "hub") return events;
    const hashes = [...new Set(events.filter((e) => e.name === "Copied" || e.name === "Refused").map((e) => e.log.transactionHash!))];
    const senders = new Map<string, Address>();
    await Promise.all(hashes.map(async (h) => senders.set(h, await deps.senderOf(h))));
    return events.map((e) => {
      const s = (e.name === "Copied" || e.name === "Refused") && senders.get(e.log.transactionHash!);
      return s ? { ...e, via: viaOf(s, deps.hub) } : e;
    });
  }

  const scanAnnotated = async (c: Contract, from: bigint, to: bigint) => annotate(c, await deps.scan(c, from, to));

  function loadSealed(c: Contract, from: bigint, to: bigint): Promise<LoggedEvent[]> {
    const key = `${c}:${address(c).toLowerCase()}:${from}-${to}:${VERSION}`;
    const have = sealed.get(key);
    if (have) return Promise.resolve(have);
    let p = inflight.get(key);
    if (!p) {
      const load = () => scanAnnotated(c, from, to);
      p = run(() => (deps.persist ? deps.persist(key, load) : load())).then(
        (events) => {
          sealed.set(key, events);
          inflight.delete(key);
          return events;
        },
        (err) => {
          inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, p);
    }
    return p;
  }

  /**
   * Every event of `c` from its start through the end of checkpoint `k`: checkpoint k-1 plus its own segments.
   * Size: a checkpoint holds the contract's whole log up to it, and Vercel's data cache stores an item of at most 2 MB;
   * a larger one is simply not kept, so every cold process rebuilds it from its segments (still cached, but slow).
   * A logged event serialises to about 0.8 KB, so that is roughly 2,500 events per contract (183 in all today). Before
   * the log nears it, store checkpoints as ranges of their own instead of cumulative ones.
   */
  function loadCheckpoint(c: Contract, k: bigint): Promise<LoggedEvent[]> {
    const start = deps.starts[c];
    const from = start + k * CP;
    const end = from + CP - 1n;
    const key = `ckpt:${c}:${address(c).toLowerCase()}:${start}-${end}:${VERSION}`;
    const have = sealed.get(key);
    if (have) return Promise.resolve(have);
    let p = inflight.get(key);
    if (!p) {
      // not inside the limiter: it only waits on loads that are
      const load = async () => {
        const segs: Promise<LoggedEvent[]>[] = [];
        for (let f = from; f <= end; f += SEG) segs.push(loadSealed(c, f, f + SEG - 1n));
        const [prev, own] = await Promise.all([k > 0n ? loadCheckpoint(c, k - 1n) : Promise.resolve([] as LoggedEvent[]), Promise.all(segs)]);
        return [...prev, ...own.flat()];
      };
      p = (deps.persist ? deps.persist(key, load) : load()).then(
        (events) => {
          sealed.set(key, events);
          inflight.delete(key);
          return events;
        },
        (err) => {
          inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, p);
    }
    return p;
  }

  /** Brings the open segment of `c` up to `head`, extending what an earlier read covered. */
  async function extendTail(c: Contract, from: bigint, head: bigint): Promise<LoggedEvent[]> {
    for (;;) {
      const busy = tailInflight.get(c);
      if (busy) {
        await busy.catch(() => undefined);
        continue;
      }
      const t = tails.get(c);
      if (t && t.from === from && t.to >= head) return t.events.filter((e) => e.log.blockNumber! <= head);
      const start = t && t.from === from ? t.to + 1n : from;
      const job = run(() => scanAnnotated(c, start, head)).then((events) => {
        const prev = t && t.from === from ? t.events : [];
        tails.set(c, { from, to: head, events: [...prev, ...events] });
      });
      tailInflight.set(c, job);
      try {
        await job;
      } finally {
        tailInflight.delete(c);
      }
    }
  }

  async function read(opts: { fromBlock?: bigint; budgetMs?: number } = {}): Promise<HubLogRead> {
    const head = await deps.head();
    const lowest = deps.starts.hub < deps.starts.gate ? deps.starts.hub : deps.starts.gate;
    const fromBlock = opts.fromBlock !== undefined && opts.fromBlock > lowest ? opts.fromBlock : lowest;
    const jobs: { range: MissingRange; p: Promise<LoggedEvent[]> }[] = [];

    for (const c of ["hub", "gate"] as const) {
      const start = deps.starts[c];
      if (start > head) continue;
      const sealedUpTo = head - MARGIN;
      let from = start;
      // the newest sealed checkpoint, unless the read starts after it
      const checkpoints = sealedUpTo >= start ? (sealedUpTo - start + 1n) / CP : 0n;
      if (checkpoints > 0n) {
        const end = start + checkpoints * CP - 1n;
        if (end >= fromBlock) jobs.push({ range: { contract: c, from: start, to: end }, p: loadCheckpoint(c, checkpoints - 1n) });
        from = end + 1n;
      }
      for (; from + SEG - 1n <= sealedUpTo; from += SEG) {
        const to = from + SEG - 1n;
        if (to < fromBlock) continue;
        jobs.push({ range: { contract: c, from, to }, p: loadSealed(c, from, to) });
      }
      const tailFrom = from;
      jobs.push({ range: { contract: c, from: tailFrom, to: head }, p: extendTail(c, tailFrom, head) });
    }

    const settled = new Map<number, LoggedEvent[] | Error>();
    const all = Promise.all(
      jobs.map((j, i) =>
        j.p.then(
          (v) => void settled.set(i, v),
          (e: unknown) => void settled.set(i, e instanceof Error ? e : new Error(String(e))),
        ),
      ),
    );
    if (opts.budgetMs === undefined) await all;
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, opts.budgetMs)))]);
      clearTimeout(timer);
    }

    const seen = new Set<string>();
    const events: LoggedEvent[] = [];
    const missing: MissingRange[] = [];
    jobs.forEach((j, i) => {
      const got = settled.get(i);
      if (!got || got instanceof Error) {
        missing.push(j.range);
        return;
      }
      for (const e of got) {
        if (e.log.blockNumber! < fromBlock) continue;
        const k = eventKey(e);
        if (seen.has(k)) continue;
        seen.add(k);
        events.push(e);
      }
    });
    events.sort(byChain);
    return { events, fromBlock, toBlock: head, complete: missing.length === 0, missing };
  }

  return {
    read,
    /** Resolves when every scan started so far has finished (keep a serverless function alive until then). */
    settled: async () => {
      await Promise.allSettled([...inflight.values(), ...tailInflight.values()]);
    },
  };
}

export type HubLog = ReturnType<typeof createHubLog>;

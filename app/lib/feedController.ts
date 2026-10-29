import type { CopybookEvent, WatchHandle, WatchStatus } from "@copybook/sdk";
import type { LoggedEvent, MissingRange } from "./events";
import type { HistorySummary } from "./followers";
import { mergeFeed } from "./tape";

export type FeedStatus = "loading" | WatchStatus | "paused";

export interface FeedState {
  /** Newest first, one entry per txHash:logIndex. */
  events: LoggedEvent[];
  status: FeedStatus;
  /** The last block the feed has read (history route or live watcher). */
  readTo?: bigint;
  /** False while the history route is still reading older ranges. */
  complete: boolean;
  missing: MissingRange[];
  /** What the history route computed over the whole log, and up to which block. */
  summary?: HistorySummary;
  summaryAt?: bigint;
  /** Set when the history route did not answer. */
  error?: string;
  /** True once the first history answer (or failure) is in. */
  loaded: boolean;
}

export interface HistoryAnswer {
  events: LoggedEvent[];
  toBlock: bigint;
  complete: boolean;
  missing: MissingRange[];
  summary?: HistorySummary;
}

export interface FeedDeps {
  /** The history route from a block (or from deployment). Throws when it does not answer. */
  history(fromBlock?: bigint): Promise<HistoryAnswer>;
  /** Starts the live watcher; its first read covers [fromBlock, head]. */
  watch(opts: { fromBlock?: bigint; onEvent: (e: CopybookEvent) => void; onStatus: (s: WatchStatus) => void }): Promise<WatchHandle>;
  /** Copies and refusals learn how they were sent. */
  annotate(e: CopybookEvent): Promise<LoggedEvent>;
  /** Whether a live event belongs on this page. */
  keep(e: CopybookEvent): boolean;
  hidden(): boolean;
  live: boolean;
  cap: number;
}

const firstMissing = (missing: readonly MissingRange[]) => missing.reduce<bigint | undefined>((m, r) => (m === undefined || r.from < m ? r.from : m), undefined);

/**
 * The block the next watcher starts at (inclusive), given where the previous plan stood and a history answer: the
 * answer's end when it is complete, its first unread block when it is not. A complete answer only moves the start
 * forward; a partial one only moves it back, so nothing the history did not read is skipped.
 */
export function resumeAfter(prev: bigint | undefined, a: Pick<HistoryAnswer, "toBlock" | "complete" | "missing">): bigint {
  const gap = a.complete ? undefined : firstMissing(a.missing);
  const at = gap ?? a.toBlock;
  if (prev === undefined) return at;
  if (gap === undefined) return at > prev ? at : prev;
  return at < prev ? at : prev;
}

/**
 * One page's feed: the history route first, then the live watcher started where that read ends (or at its first
 * unread block), merged on txHash:logIndex. After a reconnect the history is read again from the last block seen.
 * Hiding the tab stops the watcher; showing it reads the history from there and starts a new one. Each start and
 * stop is a generation: anything an older watcher reports afterwards (a late "stopped", a late status) is ignored.
 */
export function createFeed(deps: FeedDeps, emit: (s: FeedState) => void) {
  let state: FeedState = { events: [], status: "loading", complete: true, missing: [], loaded: false };
  const set = (patch: Partial<FeedState> | ((s: FeedState) => Partial<FeedState>)) => {
    if (disposed) return;
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    emit(state);
  };

  let disposed = false;
  let handle: WatchHandle | undefined;
  let starting = false;
  let gen = 0;
  let wasDown = false;
  /** Where the next watcher starts (inclusive). */
  let resume: bigint | undefined;
  /** The last block read, for the status line. */
  let readTo: bigint | undefined;
  const bump = (b: bigint | undefined) => {
    if (b !== undefined && (readTo === undefined || b > readTo)) readTo = b;
  };
  const merge = (incoming: LoggedEvent[], extra: Partial<FeedState> = {}) =>
    set((s) => ({ ...extra, events: mergeFeed(s.events, incoming, deps.cap), readTo }));

  async function backfill(fromBlock?: bigint) {
    try {
      const a = await deps.history(fromBlock);
      resume = resumeAfter(resume, a);
      const gap = a.complete ? undefined : firstMissing(a.missing);
      bump(gap === undefined ? a.toBlock : gap - 1n);
      merge(a.events, {
        loaded: true,
        error: undefined,
        // a backfill from a later block says nothing about older ranges or the whole log: keep what the first read said
        ...(fromBlock === undefined ? { complete: a.complete, missing: a.missing, summary: a.summary, summaryAt: a.toBlock } : {}),
      });
    } catch (err) {
      set({ loaded: true, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function start() {
    if (!deps.live || disposed || handle || starting || deps.hidden()) return;
    starting = true;
    const g = ++gen;
    try {
      const h = await deps.watch({
        fromBlock: resume,
        onEvent: (e) => {
          if (g !== gen || !deps.keep(e)) return;
          bump(e.log.blockNumber);
          void deps.annotate(e).then((ev) => g === gen && merge([ev]));
        },
        onStatus: (s) => {
          if (g !== gen || disposed) return;
          if (s === "reconnecting") wasDown = true;
          if (s === "live" && wasDown) {
            wasDown = false;
            void backfill(readTo);
          }
          set({ status: s });
        },
      });
      if (disposed || deps.hidden() || g !== gen) await h.stop();
      else handle = h;
    } finally {
      starting = false;
    }
  }

  /** Stops the watcher; the next one resumes where it had read to. Returns this stop's generation. */
  function stop(): { gen: number; done: Promise<void> } {
    const h = handle;
    handle = undefined;
    const g = ++gen;
    if (!h) return { gen: g, done: Promise.resolve() };
    const last = h.lastBlock;
    bump(last);
    if (last !== undefined && (resume === undefined || last > resume)) resume = last;
    return { gen: g, done: h.stop() };
  }

  // the watcher's own read-to block moves on every tick; show it without asking the node
  const tick = setInterval(() => {
    if (handle?.lastBlock === undefined) return;
    const before = readTo;
    bump(handle.lastBlock);
    if (readTo !== before) set({ readTo });
  }, 3_000);

  return {
    get state() {
      return state;
    },
    /** First history read, then the watcher. */
    async open() {
      await backfill();
      if (deps.live) await start();
      else set({ status: "stopped" });
    },
    /** The tab was hidden or shown. */
    async visibility(hidden: boolean) {
      if (hidden) {
        const s = stop();
        await s.done;
        // a show that came in while this stop was closing the socket owns the status now
        if (s.gen === gen) set({ status: "paused" });
      } else {
        await backfill(resume);
        await start();
      }
    },
    async dispose() {
      clearInterval(tick);
      const s = stop();
      disposed = true;
      await s.done;
    },
  };
}

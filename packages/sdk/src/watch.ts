import { getAddress, webSocket, type Address, type PublicClient } from "viem";
import type { CopybookEvent } from "./events.ts";
import { eventKey, getHubHistory, type Contract } from "./history.ts";
import type { Deployments } from "./types.ts";

export interface WatchTransport {
  /**
   * Opens a `somnia_watch` subscription on `addresses`. A notification is only a tick ("something happened"):
   * the payload is never trusted, so `onTick` takes none. `onClose` fires once when the socket or subscription dies.
   */
  subscribe(params: { addresses: Address[]; onTick: () => void; onClose: (err?: unknown) => void }): Promise<{ close(): Promise<void> }>;
}

export type WatchStatus = "connecting" | "live" | "reconnecting" | "stopped";

export interface WatchOptions {
  publicClient: PublicClient;
  deployments: Deployments;
  /** Defaults to the chain's WebSocket URL. */
  wsUrl?: string;
  /** Only events about this follower. */
  follower?: Address;
  /** Contracts to watch. Default: the hub. */
  contracts?: readonly Contract[];
  /** `live` events were fetched after a tick; `backfill` ones after a (re)connect. */
  onEvent: (event: CopybookEvent, info: { source: "live" | "backfill" }) => void;
  onStatus?: (status: WatchStatus, detail?: string) => void;
  onError?: (err: unknown) => void;
  reconnect?: { minDelayMs?: number; maxDelayMs?: number };
  /** How many delivered event keys to remember. Default 5000. */
  deliveredCapacity?: number;
  /** A subscription that has not answered after this long counts as failed and is retried. Default 15000. */
  subscribeTimeoutMs?: number;
  /**
   * First block to deliver from. The first connect reads [fromBlock, head], so a feed seeded from history up to
   * block N passes N here and nothing between that read and the socket is missed. Default: the head at start.
   */
  fromBlock?: bigint;
  /** Blocks per getLogs request when reading a range (the node's limit, if known). Default: the history default. */
  chunkSize?: bigint;
  /** Replace the WebSocket transport (tests). */
  transport?: WatchTransport;
}

export interface WatchHandle {
  stop(): Promise<void>;
  /** The block up to which the chain has been read (the next fetch starts here, inclusive). */
  readonly lastBlock: bigint | undefined;
}

/** How long the default transport waits for the node to accept a subscription. */
const SUBSCRIBE_TIMEOUT_MS = 10_000;
/** How long closing waits for the node to confirm an unsubscribe before closing the socket anyway. */
const UNSUBSCRIBE_WAIT_MS = 2_000;
let subscriptionSeq = 0;

/** A socket that stays up this long counts as healthy: the retry backoff starts over. */
const HEALTHY_MS = 30_000;

/** The default transport: viem's WebSocket transport speaking Somnia's `somnia_watch` subscription. */
export function somniaWatchTransport(publicClient: PublicClient, wsUrl?: string, opts: { timeoutMs?: number } = {}): WatchTransport {
  const timeoutMs = opts.timeoutMs ?? SUBSCRIBE_TIMEOUT_MS;
  return {
    async subscribe({ addresses, onTick, onClose }) {
      // viem's own reconnect is off: the watcher owns reconnecting so it can read what the gap missed
      // A socket client of its own. viem caches socket clients by URL and by these options (not by transport key),
      // so each subscription gets distinct reconnect options: attempts 0 (viem never reconnects by itself, the watcher
      // does) and a delay that only serves as this subscription's id. No two subscriptions ever share a socket.
      const reconnect = { attempts: 0, delay: ++subscriptionSeq };
      const transport = webSocket(wsUrl, { key: "somniaWatch", reconnect, keepAlive: { interval: 15_000 } })({ chain: publicClient.chain, retryCount: 0 });
      const value = transport.value as unknown as {
        getRpcClient(): Promise<{ close(): void }>;
        subscribe(a: { params: unknown[]; onData: (d: unknown) => void; onError: (e: unknown) => void }): Promise<{ unsubscribe(): Promise<unknown> }>;
      };
      // The socket client this subscription runs on. viem keeps one per URL until it is closed explicitly; a dead one
      // left in that cache would take the next subscription and never answer it, so it is closed (and evicted) the
      // moment its socket dies, and only this one is ever closed here.
      // A socket that never opens would hold this forever: give up after the timeout, and close it if it opens later.
      const opening = value.getRpcClient();
      let openTimer: ReturnType<typeof setTimeout> | undefined;
      const client = await Promise.race([
        opening,
        new Promise<never>((_, reject) => {
          openTimer = setTimeout(() => {
            void opening.then((late) => late.close(), () => undefined);
            reject(new Error(`the somnia_watch socket did not open within ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(openTimer));
      let closed = false;
      let dropped = false;
      const drop = () => {
        if (dropped) return;
        dropped = true;
        try {
          client.close();
        } catch {
          /* already closed */
        }
      };
      const sub = await new Promise<{ unsubscribe(): Promise<unknown> }>((resolve, reject) => {
        // a subscription the socket never answers (a half-dead connection) fails here, and takes its client with it
        const timer = setTimeout(() => {
          closed = true;
          drop();
          reject(new Error(`somnia_watch did not answer within ${timeoutMs} ms`));
        }, timeoutMs);
        value
          .subscribe({
            params: ["somnia_watch", { address: addresses, eth_calls: [], push_changes_only: false }],
            onData: () => onTick(),
            onError: (e) => {
              if (closed) return;
              closed = true;
              drop();
              onClose(e);
            },
          })
          .then(
            (s) => {
              clearTimeout(timer);
              if (closed) {
                void s.unsubscribe().catch(() => undefined);
                reject(new Error("somnia_watch closed while subscribing"));
              } else resolve(s);
            },
            (e: unknown) => {
              clearTimeout(timer);
              closed = true;
              drop();
              reject(e);
            },
          );
      });
      return {
        async close() {
          closed = true;
          if (!dropped) {
            // a socket that stopped answering would hold the unsubscribe until viem's 10 s timeout: give it 2 s
            await Promise.race([sub.unsubscribe().catch(() => undefined), new Promise((r) => setTimeout(r, UNSUBSCRIBE_WAIT_MS))]);
          }
          drop();
        },
      };
    },
  };
}

/**
 * Streams Copybook events live. A somnia_watch notification is only a tick: on every tick, and on every
 * (re)connect, the watcher reads the authoritative logs from the last block it covered up to the head and emits
 * the ones it has not delivered, keyed `txHash:logIndex` in a bounded delivered set. Live delivery and backfill
 * share that one path, so a drop, two quick reconnects or ticks that outrun the reads cannot miss or repeat an event.
 */
export async function watchHub(opts: WatchOptions): Promise<WatchHandle> {
  const { deployments, publicClient } = opts;
  const contracts = opts.contracts ?? ["hub"];
  const addresses = contracts.map((k) => (k === "hub" ? deployments.hub : k === "gate" ? deployments.gate : deployments.themes));
  const follower = opts.follower ? getAddress(opts.follower) : undefined;
  const transport = opts.transport ?? somniaWatchTransport(publicClient, opts.wsUrl);
  const minDelay = opts.reconnect?.minDelayMs ?? 1_000;
  const maxDelay = opts.reconnect?.maxDelayMs ?? 30_000;
  const capacity = opts.deliveredCapacity ?? 5_000;
  const subscribeTimeout = opts.subscribeTimeoutMs ?? 15_000;

  let stopped = false;
  let cursor: bigint | undefined;
  let attempt = 0;
  let current: { close(): Promise<void> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let healthy: ReturnType<typeof setTimeout> | undefined;
  /** Insertion-ordered: oldest key first, evicted past capacity. */
  const delivered = new Set<string>();

  const status = (s: WatchStatus, detail?: string) => opts.onStatus?.(s, detail);

  // one fetch at a time; a tick that lands mid-fetch earns exactly one more fetch afterwards
  let fetching = false;
  let again = false;
  let nextSource: "live" | "backfill" = "live";

  function request(source: "live" | "backfill") {
    if (source === "backfill") nextSource = "backfill";
    if (fetching) {
      again = true;
      return;
    }
    void drain();
  }

  async function drain() {
    fetching = true;
    try {
      do {
        again = false;
        const source = nextSource;
        nextSource = "live";
        await fetchOnce(source);
      } while (again && !stopped);
    } finally {
      fetching = false;
    }
  }

  async function fetchOnce(source: "live" | "backfill") {
    if (stopped) return;
    try {
      const head = await publicClient.getBlockNumber({ cacheTime: 0 });
      const from = cursor ?? head;
      if (head < from) return;
      const history = await getHubHistory({ publicClient, deployments }, { fromBlock: from, toBlock: head, follower, contracts, chunkSize: opts.chunkSize });
      for (const e of history.events) {
        if (stopped) return;
        const k = eventKey(e);
        if (delivered.has(k)) continue;
        delivered.add(k);
        if (delivered.size > capacity) delivered.delete(delivered.values().next().value as string);
        try {
          opts.onEvent(e, { source });
        } catch (err) {
          opts.onError?.(err);
        }
      }
      cursor = head;
    } catch (err) {
      // the cursor stays where it was: the next tick or reconnect reads the same range again
      opts.onError?.(err);
    }
  }

  let attemptSeq = 0;

  async function connect(isReconnect: boolean) {
    if (stopped) return;
    status(isReconnect ? "reconnecting" : "connecting");
    const me = ++attemptSeq;
    const mine = () => me === attemptSeq;
    try {
      const pending = transport.subscribe({
        addresses,
        onTick: () => {
          if (!mine()) return;
          attempt = 0;
          request("live");
        },
        onClose: (err) => {
          if (stopped || !mine()) return;
          const dead = current;
          current = undefined;
          if (healthy) clearTimeout(healthy);
          healthy = undefined;
          if (err) opts.onError?.(err);
          void dead?.close().catch(() => undefined);
          schedule();
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const sub = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            attemptSeq++; // whatever this attempt does later is ignored
            void pending.then((late) => late.close(), () => undefined);
            reject(new Error(`somnia_watch did not answer within ${subscribeTimeout} ms`));
          }, subscribeTimeout);
        }),
      ]).finally(() => clearTimeout(timer));
      if (stopped) {
        await sub.close();
        return;
      }
      current = sub;
      healthy = setTimeout(() => (attempt = 0), HEALTHY_MS);
      status("live");
      request("backfill");
    } catch (err) {
      opts.onError?.(err);
      schedule();
    }
  }

  function schedule() {
    if (stopped || timer) return;
    const delay = Math.min(maxDelay, minDelay * 2 ** attempt++);
    status("reconnecting", `retry in ${delay} ms`);
    timer = setTimeout(() => {
      timer = undefined;
      void connect(true);
    }, delay);
  }

  // Start from fromBlock when the caller already holds history up to there, else from the chain head: only events
  // from here on are the watcher's to deliver. The first connect reads [cursor, head].
  if (opts.fromBlock !== undefined) cursor = opts.fromBlock;
  else {
    try {
      cursor = await publicClient.getBlockNumber({ cacheTime: 0 });
    } catch (err) {
      opts.onError?.(err);
    }
  }
  await connect(false);

  return {
    get lastBlock() {
      return cursor;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (healthy) clearTimeout(healthy);
      timer = undefined;
      healthy = undefined;
      const c = current;
      current = undefined;
      if (c) await c.close();
      status("stopped");
    },
  };
}

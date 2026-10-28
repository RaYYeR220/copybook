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
  /** Replace the WebSocket transport (tests). */
  transport?: WatchTransport;
}

export interface WatchHandle {
  stop(): Promise<void>;
  /** The block up to which the chain has been read (the next fetch starts here, inclusive). */
  readonly lastBlock: bigint | undefined;
}

/** A socket that stays up this long counts as healthy: the retry backoff starts over. */
const HEALTHY_MS = 30_000;

/** The default transport: viem's WebSocket transport speaking Somnia's `somnia_watch` subscription. */
export function somniaWatchTransport(publicClient: PublicClient, wsUrl?: string): WatchTransport {
  return {
    async subscribe({ addresses, onTick, onClose }) {
      // viem's own reconnect is off: the watcher owns reconnecting so it can read what the gap missed
      const transport = webSocket(wsUrl, { reconnect: false, keepAlive: { interval: 15_000 } })({ chain: publicClient.chain, retryCount: 0 });
      const value = transport.value as unknown as {
        getRpcClient(): Promise<{ close(): void }>;
        subscribe(a: { params: unknown[]; onData: (d: unknown) => void; onError: (e: unknown) => void }): Promise<{ unsubscribe(): Promise<unknown> }>;
      };
      let closed = false;
      const sub = await value.subscribe({
        params: ["somnia_watch", { address: addresses, eth_calls: [], push_changes_only: false }],
        onData: () => onTick(),
        onError: (e) => {
          if (closed) return;
          closed = true;
          onClose(e);
        },
      });
      return {
        async close() {
          closed = true;
          try {
            await sub.unsubscribe();
          } catch {
            /* the socket may already be gone */
          }
          try {
            (await value.getRpcClient()).close();
          } catch {
            /* nothing to close */
          }
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
      const history = await getHubHistory({ publicClient, deployments }, { fromBlock: from, toBlock: head, follower, contracts });
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

  async function connect(isReconnect: boolean) {
    if (stopped) return;
    status(isReconnect ? "reconnecting" : "connecting");
    try {
      const sub = await transport.subscribe({
        addresses,
        onTick: () => {
          attempt = 0;
          request("live");
        },
        onClose: (err) => {
          if (stopped) return;
          const dead = current;
          current = undefined;
          if (healthy) clearTimeout(healthy);
          healthy = undefined;
          if (err) opts.onError?.(err);
          void dead?.close().catch(() => undefined);
          schedule();
        },
      });
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

  // Start from the chain head: only events from here on are the watcher's to deliver.
  try {
    cursor = await publicClient.getBlockNumber({ cacheTime: 0 });
  } catch (err) {
    opts.onError?.(err);
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

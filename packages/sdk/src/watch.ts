import { getAddress, hexToBigInt, webSocket, type Address, type Hex, type PublicClient } from "viem";
import { decodeCopybookLog, eventFollower, type CopybookEvent } from "./events.ts";
import { getHubHistory, type Contract } from "./history.ts";
import type { Deployments } from "./types.ts";

/** What a `somnia_watch` notification carries: the matched log, plus the results of the subscription's eth_calls. */
export interface WatchNotification {
  address: Address;
  topics: Hex[];
  data: Hex;
  simulationResults?: Hex[];
}

export interface WatchTransport {
  /** Opens a `somnia_watch` subscription. `onClose` fires once when the socket or the subscription dies. */
  subscribe(params: {
    addresses: Address[];
    ethCalls: { to: Address; data: Hex }[];
    onNotification: (n: WatchNotification) => void;
    onClose: (err?: unknown) => void;
  }): Promise<{ close(): Promise<void> }>;
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
  onEvent: (event: CopybookEvent, info: { source: "live" | "backfill" }) => void;
  onStatus?: (status: WatchStatus, detail?: string) => void;
  onError?: (err: unknown) => void;
  /** Re-read what was missed after a reconnect. Default true. */
  backfill?: boolean;
  reconnect?: { minDelayMs?: number; maxDelayMs?: number };
  /** Replace the WebSocket transport (tests). */
  transport?: WatchTransport;
}

export interface WatchHandle {
  stop(): Promise<void>;
  /** Latest block seen on any delivered event, if any. */
  readonly lastBlock: bigint | undefined;
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
/** Multicall3.getBlockNumber(): rides along with every notification so a live event knows its block. */
const GET_BLOCK_NUMBER: Hex = "0x42cbb15c";
/** On a reconnect the backfill starts this many blocks before the last block seen, to cover delivery lag. */
const OVERLAP_BLOCKS = 30n;

/** The default transport: viem's WebSocket transport speaking Somnia's `somnia_watch` subscription. */
export function somniaWatchTransport(publicClient: PublicClient, wsUrl?: string): WatchTransport {
  return {
    async subscribe({ addresses, ethCalls, onNotification, onClose }) {
      // viem's own reconnect is off: the watcher owns reconnecting so it can backfill what the gap missed
      const transport = webSocket(wsUrl, { reconnect: false, keepAlive: { interval: 15_000 } })({ chain: publicClient.chain, retryCount: 0 });
      const value = transport.value as unknown as {
        getRpcClient(): Promise<{ close(): void }>;
        subscribe(a: { params: unknown[]; onData: (d: unknown) => void; onError: (e: unknown) => void }): Promise<{ unsubscribe(): Promise<unknown> }>;
      };
      let closed = false;
      const closeOnce = (e?: unknown) => {
        if (closed) return;
        closed = true;
        onClose(e);
      };
      const sub = await value.subscribe({
        params: ["somnia_watch", { address: addresses, eth_calls: ethCalls, push_changes_only: false }],
        onData: (d) => {
          const p = d as { result?: WatchNotification; params?: { result?: WatchNotification } };
          const n = p.result ?? p.params?.result;
          if (n?.topics && n.data) onNotification(n);
        },
        onError: (e) => closeOnce(e),
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
 * Streams Copybook events live over Somnia's off-chain reactivity (`somnia_watch`), reconnecting with backoff and
 * backfilling from the chain after a gap so the feed has no hole and no duplicate: every event is identified by its
 * block and content, and a backfilled event the live stream already delivered is dropped.
 */
export async function watchHub(opts: WatchOptions): Promise<WatchHandle> {
  const { deployments, publicClient } = opts;
  const contracts = opts.contracts ?? ["hub"];
  const addresses = contracts.map((k) => (k === "hub" ? deployments.hub : k === "gate" ? deployments.gate : deployments.themes));
  const follower = opts.follower ? getAddress(opts.follower) : undefined;
  const transport = opts.transport ?? somniaWatchTransport(publicClient, opts.wsUrl);
  const minDelay = opts.reconnect?.minDelayMs ?? 1_000;
  const maxDelay = opts.reconnect?.maxDelayMs ?? 30_000;

  let stopped = false;
  let lastBlock: bigint | undefined;
  let attempt = 0;
  let current: { close(): Promise<void> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** content key -> times delivered live at that block; backfill consumes them. Pruned as blocks age out. */
  const liveSeen = new Map<string, number>();

  const keyOf = (e: CopybookEvent) =>
    `${e.log.blockNumber ?? "?"}|${e.log.address.toLowerCase()}|${e.log.topics.join(",")}|${e.log.data}`;

  const wants = (e: CopybookEvent) => !follower || eventFollower(e)?.toLowerCase() === follower.toLowerCase();

  const status = (s: WatchStatus, detail?: string) => opts.onStatus?.(s, detail);

  function onNotification(n: WatchNotification) {
    if (stopped) return;
    const sim = n.simulationResults?.[0];
    const block = sim && sim.length === 66 ? hexToBigInt(sim) : undefined;
    const e = decodeCopybookLog({ address: n.address, topics: n.topics, data: n.data, blockNumber: block ?? null }, deployments);
    if (!e || !wants(e)) return;
    if (block !== undefined && (lastBlock === undefined || block > lastBlock)) lastBlock = block;
    const k = keyOf(e);
    liveSeen.set(k, (liveSeen.get(k) ?? 0) + 1);
    if (liveSeen.size > 4_096) {
      const first = liveSeen.keys().next().value;
      if (first !== undefined) liveSeen.delete(first);
    }
    try {
      opts.onEvent(e, { source: "live" });
    } catch (err) {
      opts.onError?.(err);
    }
  }

  async function backfillFrom(from: bigint) {
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    const history = await getHubHistory(
      { publicClient, deployments },
      { fromBlock: from, toBlock: head, follower, contracts },
    );
    // the live stream may have delivered some of these already (same block, same content)
    for (const e of history.events) {
      if (stopped) return;
      const k = keyOf(e);
      const seen = liveSeen.get(k) ?? 0;
      if (seen > 0) {
        liveSeen.set(k, seen - 1);
        continue;
      }
      try {
        opts.onEvent(e, { source: "backfill" });
      } catch (err) {
        opts.onError?.(err);
      }
    }
    if (head > (lastBlock ?? 0n)) lastBlock = head;
  }

  async function connect(isReconnect: boolean) {
    if (stopped) return;
    status(isReconnect ? "reconnecting" : "connecting");
    try {
      const resumeFrom = lastBlock;
      const sub = await transport.subscribe({
        addresses,
        ethCalls: [{ to: MULTICALL3, data: GET_BLOCK_NUMBER }],
        onNotification,
        onClose: (err) => {
          if (stopped) return;
          current = undefined;
          if (err) opts.onError?.(err);
          schedule();
        },
      });
      if (stopped) {
        await sub.close();
        return;
      }
      current = sub;
      attempt = 0;
      status("live");
      if (opts.backfill !== false && isReconnect) {
        const from = resumeFrom === undefined ? undefined : resumeFrom > OVERLAP_BLOCKS ? resumeFrom - OVERLAP_BLOCKS : 0n;
        if (from !== undefined) await backfillFrom(from).catch((err) => opts.onError?.(err));
      }
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

  // Start from the chain head so a first reconnect knows where the live stream began.
  try {
    lastBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
  } catch (err) {
    opts.onError?.(err);
  }
  await connect(false);

  return {
    get lastBlock() {
      return lastBlock;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      const c = current;
      current = undefined;
      if (c) await c.close();
      status("stopped");
    },
  };
}

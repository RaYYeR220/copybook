import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicClient, http, type PublicClient } from "viem";
import { createCopybook } from "@copybook/sdk";
import { fromJsonSafe, toJsonSafe } from "../json";
import { readThrough } from "../readThrough";
import { hideki } from "../wallet/hideki";
import { config } from "./config";
import { createHubLog, type LoggedEvent } from "./hubLog";

/** The node refuses `eth_getLogs` over more than 1000 blocks; asking for exactly that avoids the SDK's halving retries. */
const LOG_CHUNK = 1_000n;

/**
 * Hideki answers a 1000-block eth_getLogs in about a second, but from Vercel's functions a request sometimes hangs for
 * 30 s or more while the next one answers at once: give up on a request after 8 s and try again, up to four times.
 */
export const publicClient = createPublicClient({
  chain: hideki,
  transport: http(undefined, { retryCount: 4, retryDelay: 300, timeout: 8_000 }),
}) as PublicClient;

export const copybook = createCopybook({ publicClient, deployments: config.deployments });

/**
 * Sealed segments never change: keep them in the data cache for good (JSON-safe, since bigints do not serialise).
 * A missing checkpoint is built outside the cache's loader, so the checkpoint and segments it is made of are read from
 * the cache instead of being rescanned (Next skips the cache for an unstable_cache inside another one's loader).
 */
const persist = (key: string, load: () => Promise<LoggedEvent[]>) =>
  readThrough<LoggedEvent[]>(
    (loader) => unstable_cache(async () => toJsonSafe(await loader()), ["hub-log", "v2", key], { revalidate: false })().then((v) => fromJsonSafe<LoggedEvent[]>(v)),
    load,
  );

/** The hub's and the gate's event log since deployment, shared by every route and page in this process. */
export const hubLog = createHubLog({
  head: () => publicClient.getBlockNumber({ cacheTime: 0 }),
  scan: async (contract, fromBlock, toBlock) =>
    (await copybook.history({ fromBlock, toBlock, contracts: [contract], chunkSize: LOG_CHUNK })).events,
  senderOf: async (hash) => (await publicClient.getTransaction({ hash })).from,
  hub: config.deployments.hub,
  gate: config.deployments.gate,
  starts: { hub: config.deployments.deployBlock, gate: config.gateDeployBlock },
  concurrency: 12,
  persist,
});

let primed: Promise<void> | undefined;

/**
 * Reads the log once at the top of a request, before a cache whose loader reads it too (the trader ranking, a copy's
 * source). Inside a loader Next skips the data cache, so a cold process would rescan the chain there; after this the
 * log is in memory, or its scans are in flight and the loader's read joins them. Read again until one read is complete.
 */
export function primeHubLog(budgetMs: number): Promise<void> {
  primed ??= hubLog.read({ budgetMs }).then((r) => {
    if (!r.complete) primed = undefined;
  });
  return primed.catch(() => {
    primed = undefined;
  });
}

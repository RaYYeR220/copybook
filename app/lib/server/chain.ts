import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicClient, http, type PublicClient } from "viem";
import { createCopybook } from "@copybook/sdk";
import { fromJsonSafe, toJsonSafe } from "../json";
import { hideki } from "../wallet/hideki";
import { config } from "./config";
import { createHubLog, type LoggedEvent } from "./hubLog";

/** The node refuses `eth_getLogs` over more than 1000 blocks; asking for exactly that avoids the SDK's halving retries. */
const LOG_CHUNK = 1_000n;

export const publicClient = createPublicClient({
  chain: hideki,
  transport: http(undefined, { retryCount: 2, retryDelay: 400, timeout: 20_000 }),
}) as PublicClient;

export const copybook = createCopybook({ publicClient, deployments: config.deployments });

/** Sealed segments never change: keep them in the data cache for good (JSON-safe, since bigints do not serialise). */
const persist = (key: string, load: () => Promise<LoggedEvent[]>) =>
  unstable_cache(async () => toJsonSafe(await load()), ["hub-log", key], { revalidate: false })().then((v) => fromJsonSafe<LoggedEvent[]>(v));

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

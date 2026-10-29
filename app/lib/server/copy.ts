import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { TransactionReceiptNotFoundError, getAddress, type Address, type Hex } from "viem";
import type { RawLog } from "@copybook/sdk";
import { loadCopy, type CopyDeps, type CopyView } from "../copy";
import { followedSources } from "../followers";
import { fromJsonSafe, toJsonSafe } from "../json";
import { publicClient, hubLog } from "./chain";
import { config } from "./config";

const toHexNum = (n: bigint) => `0x${n.toString(16)}`;

const deps: CopyDeps = {
  deployments: { hub: config.deployments.hub, gate: config.deployments.gate, themes: config.deployments.themes, marginBank: config.deployments.marginBank },
  receipt: async (hash) => {
    try {
      const r = await publicClient.getTransactionReceipt({ hash });
      return { blockNumber: r.blockNumber, transactionIndex: r.transactionIndex, status: r.status, logs: r.logs };
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    }
  },
  transaction: async (hash) => {
    const t = await publicClient.getTransaction({ hash });
    return { from: t.from, to: t.to, input: t.input };
  },
  blockTime: async (block) => Number((await publicClient.getBlock({ blockNumber: block })).timestamp),
  logs: async ({ block, address, topics }) => {
    const rows = (await publicClient.request({
      method: "eth_getLogs",
      params: [{ address, fromBlock: toHexNum(block), toBlock: toHexNum(block), topics: [...topics] }],
    } as never)) as { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; transactionIndex: Hex; logIndex: Hex }[];
    return rows.map(
      (l): RawLog => ({
        address: getAddress(l.address),
        topics: l.topics,
        data: l.data,
        blockNumber: BigInt(l.blockNumber),
        transactionHash: l.transactionHash,
        transactionIndex: Number(l.transactionIndex),
        logIndex: Number(l.logIndex),
      }),
    );
  },
  sourceOf: async (sourceId) => {
    const log = await hubLog.read({ budgetMs: 8_000 });
    const s = followedSources(log.events).find((x) => x.sourceId.toLowerCase() === sourceId.toLowerCase());
    return s ? { kind: s.kind, ref: s.ref } : null;
  },
};

class NoCopy extends Error {}

/**
 * A landed copy never changes, so a found one is cached for good. "No copy" is not cached: the transaction may
 * still be on its way. A chain error throws.
 */
const cachedCopy = (hash: string, logIndex: number | undefined) =>
  unstable_cache(
    async () => {
      const v = await loadCopy(hash, logIndex, deps);
      if (!v) throw new NoCopy();
      return toJsonSafe(v);
    },
    ["copy", "v1", hash.toLowerCase(), String(logIndex ?? "first")],
    { revalidate: false },
  )().then((v) => fromJsonSafe<CopyView>(v));

/** One copy for the page, its metadata and its card. Null when the transaction holds no such copy. */
export const copyOf = cache(async (hash: string, logIndex: number | undefined): Promise<CopyView | null> => {
  try {
    return await cachedCopy(hash, logIndex);
  } catch (e) {
    if (e instanceof NoCopy) return null;
    throw e;
  }
});

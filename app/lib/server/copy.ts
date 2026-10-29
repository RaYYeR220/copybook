import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { TransactionReceiptNotFoundError, getAddress, type Address, type Hex } from "viem";
import type { RawLog } from "@copybook/sdk";
import { copyReader, type CopyDeps, type CopyView } from "../copy";
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
    return { source: s ? { kind: s.kind, ref: s.ref } : null, complete: log.complete };
  },
};

/** A complete view of a landed copy never changes: kept in the data cache for good (JSON-safe). */
const read = copyReader(deps, (key, load) =>
  unstable_cache(async () => toJsonSafe(await load()), key, { revalidate: false })().then((v) => fromJsonSafe<CopyView>(v)),
);

/** One copy for the page, its metadata and its card. Null when the transaction holds no such copy; throws when the chain could not be read. */
export const copyOf = cache((hash: string, logIndex: number | undefined): Promise<CopyView | null> => read(hash, logIndex));

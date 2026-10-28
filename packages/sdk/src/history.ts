import { getAddress, hexToBigInt, hexToNumber, numberToHex, toEventSelector, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { gateAbi } from "./abi/gate.ts";
import { hubAbi } from "./abi/hub.ts";
import { themesAbi } from "./abi/themes.ts";
import { decodeCopybookLog, type CopybookEvent, type RawLog } from "./events.ts";
import type { ReadContext } from "./reads.ts";

export type Contract = "hub" | "gate" | "themes";

export interface HistoryOptions {
  fromBlock: bigint;
  /** Defaults to the chain head at call time. */
  toBlock?: bigint;
  /** Only events about this follower. Events that name no follower (group, theme and review events) are left out. */
  follower?: Address;
  /** Which contracts to read. Default: the hub only. */
  contracts?: readonly Contract[];
  /** Blocks per request. Default 10_000; halved automatically when the node refuses a range. */
  chunkSize?: bigint;
  onProgress?: (done: bigint, total: bigint) => void;
}

export interface History {
  events: CopybookEvent[];
  fromBlock: bigint;
  toBlock: bigint;
}

interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | null;
  transactionHash: Hex | null;
  transactionIndex: Hex | null;
  logIndex: Hex | null;
}

const MIN_CHUNK = 100n;

const eventsOf = (abi: Abi): AbiEvent[] => abi.filter((x): x is AbiEvent => x.type === "event");

/** Topic0 of every event of an ABI, or only those whose first indexed argument is `follower`. */
export function topicsOf(abi: Abi, followerOnly: boolean): Hex[] {
  return eventsOf(abi)
    .filter((e) => !followerOnly || (e.inputs[0]?.indexed === true && e.inputs[0]?.name === "follower"))
    .map((e) => toEventSelector(e));
}

const pad32 = (a: Address): Hex => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

function toRaw(l: RpcLog): RawLog {
  return {
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: l.blockNumber ? hexToBigInt(l.blockNumber) : null,
    transactionHash: l.transactionHash,
    transactionIndex: l.transactionIndex ? hexToNumber(l.transactionIndex) : null,
    logIndex: l.logIndex ? hexToNumber(l.logIndex) : null,
  };
}

const cmp = (a: CopybookEvent, b: CopybookEvent) =>
  Number((a.log.blockNumber ?? 0n) - (b.log.blockNumber ?? 0n)) ||
  (a.log.transactionIndex ?? 0) - (b.log.transactionIndex ?? 0) ||
  (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0);

/** A stable identity for an on-chain event: block, transaction and log index. */
export const eventKey = (e: CopybookEvent): string => `${e.log.transactionHash ?? ""}:${e.log.logIndex ?? ""}`;

/**
 * Reads Copybook events over a block range in chunks, newest data last, without duplicates. Use it to backfill a
 * feed, to build a follower's activity list, or to catch up after a dropped live connection.
 */
export async function getHubHistory(c: ReadContext, opts: HistoryOptions): Promise<History> {
  const to = opts.toBlock ?? (await c.publicClient.getBlockNumber({ cacheTime: 0 }));
  const from = opts.fromBlock;
  if (from > to) return { events: [], fromBlock: from, toBlock: to };
  const which = opts.contracts ?? ["hub"];
  const follower = opts.follower ? getAddress(opts.follower) : undefined;
  const targets: { address: Address; abi: Abi }[] = [];
  if (which.includes("hub")) targets.push({ address: c.deployments.hub, abi: hubAbi as Abi });
  if (which.includes("gate")) targets.push({ address: c.deployments.gate, abi: gateAbi as Abi });
  if (which.includes("themes") && !follower) targets.push({ address: c.deployments.themes, abi: themesAbi as Abi });

  const seen = new Set<string>();
  const events: CopybookEvent[] = [];
  let chunk = opts.chunkSize ?? 10_000n;
  let cursor = from;
  const total = to - from + 1n;

  while (cursor <= to) {
    const end = cursor + chunk - 1n > to ? to : cursor + chunk - 1n;
    try {
      for (const t of targets) {
        const topic0 = topicsOf(t.abi, follower !== undefined);
        const topics: (Hex | Hex[] | null)[] = follower ? [topic0, pad32(follower)] : [topic0];
        const logs = (await c.publicClient.request({
          method: "eth_getLogs",
          params: [{ address: t.address, fromBlock: numberToHex(cursor), toBlock: numberToHex(end), topics }],
        } as never)) as unknown as RpcLog[];
        for (const l of logs) {
          const e = decodeCopybookLog(toRaw(l), c.deployments);
          if (!e) continue;
          const k = eventKey(e);
          if (seen.has(k)) continue;
          seen.add(k);
          events.push(e);
        }
      }
    } catch (err) {
      // a node that refuses the range: retry the same start with half the span, down to a floor
      if (chunk > MIN_CHUNK) {
        chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
        continue;
      }
      throw err;
    }
    opts.onProgress?.(end - from + 1n, total);
    cursor = end + 1n;
  }
  events.sort(cmp);
  return { events, fromBlock: from, toBlock: to };
}

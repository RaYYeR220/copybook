import { decodeFunctionData, getAddress, hexToBigInt, keccak256, parseAbi, toHex, type Abi, type Address, type Hex } from "viem";
import { decodeCopybookLogs, hubAbi, sourceIdOf, type CopybookEvent, type RawLog, type SourceKindName } from "@copybook/sdk";

/** What the reactive precompile calls on a group relay: the event the subscription matched, as it was logged. */
const handlerAbi = parseAbi(["function onEvent(address emitter, bytes32[] eventTopics, bytes data)"]);
/** The margin bank's position event (topics: trader, pool) and the registry's rebalance event (topic: theme id), as the hub subscribes to them. */
export const POSITION_UPDATED_TOPIC: Hex = "0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de";
export const THEME_REBALANCED_TOPIC: Hex = keccak256(toHex("ThemeRebalanced(uint256,uint32)"));

export const TX_RE = /^0x[0-9a-fA-F]{64}$/;

export interface CopyReceipt {
  blockNumber: bigint;
  transactionIndex: number;
  status: "success" | "reverted";
  logs: RawLog[];
}

/** The chain reads behind a copy's page and card. */
export interface CopyDeps {
  deployments: { hub: Address; gate: Address; themes: Address; marginBank: Address };
  /** Null when the node knows no such transaction (or not yet). */
  receipt(hash: Hex): Promise<CopyReceipt | null>;
  transaction(hash: Hex): Promise<{ from: Address; to: Address | null; input: Hex }>;
  blockTime(block: bigint): Promise<number>;
  /** Logs of one contract in one block; `topics` narrow it where the node honours them, the caller matches exactly either way. */
  logs(q: { block: bigint; address: Address; topics: readonly Hex[] }): Promise<RawLog[]>;
  /** The kind and ref of a followed source, from the hub's Followed events, when the copy's own block does not say. */
  sourceOf?(sourceId: Hex): Promise<{ kind: SourceKindName; ref: bigint } | null>;
}

export type CopySource = { kind: "Trader"; trader: Address } | { kind: "Theme"; themeId: bigint };

export interface CopyView {
  hash: Hex;
  block: bigint;
  /** Unix seconds of the block. */
  time: number;
  txIndex: number;
  logIndex: number;
  /** `handler`: the hub's reactive handler sent it (validators, in the move's block). `call`: someone called the hub. */
  via: "handler" | "call";
  /** For a call: the hub function it ran (follow, catchUp, resync, …), when the input decodes. */
  call?: string;
  follower: Address;
  sourceId: Hex;
  source: CopySource | null;
  pool: Address;
  fromSize: bigint;
  toSize: bigint;
  /** The order's limit price (18 decimals), not the fill. */
  limitPrice: bigint;
  capped: boolean;
  /** The source's move this copy answered, found in the same block before it. */
  leader: { hash: Hex; txIndex: number; logIndex: number } | null;
  /** True only when the hub's handler sent it and the move it answers sits earlier in the same block. */
  sameBlock: boolean;
  /** Other copies in the same transaction (a thesis resizes every leg in one). */
  siblings: { logIndex: number; pool: Address }[];
}

type Copied = Extract<CopybookEvent, { name: "Copied" }>;

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const addressFromTopic = (t: Hex) => getAddress(`0x${t.slice(26)}`);

/** The source a triggering event names, checked against the copy's source id. */
function sourceFromTrigger(emitter: Address, topics: readonly Hex[], d: CopyDeps["deployments"], sourceId: Hex): CopySource | null {
  if (sameHex(emitter, d.marginBank) && sameHex(topics[0] ?? "0x", POSITION_UPDATED_TOPIC) && topics.length >= 3) {
    const trader = addressFromTopic(topics[1]);
    return sameHex(sourceIdOf("Trader", trader), sourceId) ? { kind: "Trader", trader } : null;
  }
  if (sameHex(emitter, d.themes) && sameHex(topics[0] ?? "0x", THEME_REBALANCED_TOPIC) && topics.length >= 2) {
    const themeId = hexToBigInt(topics[1]);
    return sameHex(sourceIdOf("Theme", themeId), sourceId) ? { kind: "Theme", themeId } : null;
  }
  return null;
}

/**
 * One copy, read from the chain: the transaction's `Copied` event (the one at `logIndex`, or its first), how it was
 * sent, and for a handler copy the source's move it answered, matched exactly (emitter, topics and data, as the
 * handler's input carries them) among the logs of the same block. Null when the transaction is unknown, reverted,
 * holds no `Copied`, or none at `logIndex`: there is no copy to show, so nothing is made up.
 */
export async function loadCopy(hash: string, logIndex: number | undefined, deps: CopyDeps): Promise<CopyView | null> {
  if (!TX_RE.test(hash)) return null;
  const h = hash.toLowerCase() as Hex;
  const r = await deps.receipt(h);
  if (!r || r.status !== "success") return null;
  const copies = decodeCopybookLogs(r.logs, deps.deployments).filter((e): e is Copied => e.name === "Copied" && sameHex(e.log.address, deps.deployments.hub));
  if (copies.length === 0) return null;
  const copy = logIndex === undefined ? copies[0] : copies.find((c) => c.log.logIndex === logIndex);
  if (!copy) return null;

  const [tx, time] = await Promise.all([deps.transaction(h), deps.blockTime(r.blockNumber)]);
  const via = sameHex(tx.from, deps.deployments.hub) ? "handler" : "call";
  let source: CopySource | null = null;
  let leader: CopyView["leader"] = null;
  let call: string | undefined;

  if (via === "handler") {
    try {
      const { args } = decodeFunctionData({ abi: handlerAbi, data: tx.input });
      const [emitter, topics, data] = args as unknown as [Address, readonly Hex[], Hex];
      source = sourceFromTrigger(emitter, topics, deps.deployments, copy.sourceId);
      if (source) {
        const logs = await deps.logs({ block: r.blockNumber, address: emitter, topics });
        const match = logs
          .filter(
            (l) =>
              sameHex(l.address, emitter) &&
              l.topics.length === topics.length &&
              l.topics.every((t, i) => sameHex(t, topics[i])) &&
              sameHex(l.data, data) &&
              l.blockNumber === r.blockNumber &&
              (l.transactionIndex ?? Infinity) < r.transactionIndex,
          )
          .sort((a, b) => (b.transactionIndex ?? 0) - (a.transactionIndex ?? 0) || (b.logIndex ?? 0) - (a.logIndex ?? 0))[0];
        if (match?.transactionHash) leader = { hash: match.transactionHash, txIndex: match.transactionIndex!, logIndex: match.logIndex! };
      }
    } catch {
      /* not a relay call this page understands: no leader is claimed */
    }
  } else {
    try {
      const d = decodeFunctionData({ abi: hubAbi as Abi, data: tx.input });
      call = d.functionName;
      if (d.functionName === "follow" && Array.isArray(d.args)) {
        const kind = Number(d.args[0]) === 1 ? "Theme" : "Trader";
        const ref = BigInt(d.args[1] as bigint);
        if (sameHex(sourceIdOf(kind, ref), copy.sourceId))
          source = kind === "Theme" ? { kind, themeId: ref } : { kind, trader: getAddress(`0x${ref.toString(16).padStart(40, "0")}`) };
      }
    } catch {
      /* a contract called the hub: the function stays unnamed */
    }
  }
  if (!source && deps.sourceOf) {
    const s = await deps.sourceOf(copy.sourceId).catch(() => null);
    if (s) source = s.kind === "Theme" ? { kind: "Theme", themeId: s.ref } : { kind: "Trader", trader: getAddress(`0x${s.ref.toString(16).padStart(40, "0")}`) };
  }

  return {
    hash: h,
    block: r.blockNumber,
    time,
    txIndex: r.transactionIndex,
    logIndex: copy.log.logIndex!,
    via,
    ...(call ? { call } : {}),
    follower: getAddress(copy.follower),
    sourceId: copy.sourceId,
    source,
    pool: getAddress(copy.pool),
    fromSize: copy.fromSize,
    toSize: copy.toSize,
    limitPrice: copy.limitPrice,
    capped: copy.capped,
    leader,
    sameBlock: via === "handler" && leader !== null,
    siblings: copies.filter((c) => c !== copy).map((c) => ({ logIndex: c.log.logIndex!, pool: getAddress(c.pool) })),
  };
}

/** `?log=` as a log index, or undefined when absent or not a plain integer. */
export function parseLogIndex(v: string | string[] | undefined | null): number | undefined | "invalid" {
  if (v === undefined || v === null) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return /^[0-9]{1,6}$/.test(s) ? Number(s) : "invalid";
}

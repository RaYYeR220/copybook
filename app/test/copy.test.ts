import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import type { RawLog } from "@copybook/sdk";
import { loadCopy, parseLogIndex, type CopyDeps, type CopyReceipt } from "@/lib/copy";
import { fromJsonSafe } from "@/lib/json";
import { bandRefusal, sameBlockOpen, thesisRebalance, LEADER } from "@/content/proof";
import raw from "./fixtures/copies.json";

interface Entry {
  hash: Hex;
  receipt: CopyReceipt;
  tx: { from: Address; to: Address | null; input: Hex };
  blockTime: number;
  logs: { query: { block: bigint; address: Address; topics: Hex[] }; result: RawLog[] }[];
}
const fx = fromJsonSafe<{ deployments: { hub: Address; themes: Address; marginBank: Address }; txs: Record<string, Entry> }>(raw);
const GATE = "0xEe5400000000000000000000000000000000020f" as Address;

/** The chain as recorded from Hideki2 (scripts/record-copy-fixtures.mjs); anything not recorded is unknown. */
function replay(extra: Partial<CopyDeps> = {}): CopyDeps & { calls: string[] } {
  const calls: string[] = [];
  const byHash = new Map(Object.values(fx.txs).map((e) => [e.hash.toLowerCase(), e]));
  return {
    calls,
    deployments: { ...fx.deployments, gate: GATE },
    receipt: async (h) => (calls.push(`receipt ${h.slice(0, 10)}`), byHash.get(h.toLowerCase())?.receipt ?? null),
    transaction: async (h) => {
      const e = byHash.get(h.toLowerCase());
      if (!e) throw new Error("unknown tx");
      return e.tx;
    },
    blockTime: async (b) => {
      const e = Object.values(fx.txs).find((x) => x.receipt.blockNumber === b);
      if (!e) throw new Error("unknown block");
      return e.blockTime;
    },
    logs: async (q) => {
      calls.push(`logs ${q.block} ${q.address.slice(0, 8)}`);
      for (const e of Object.values(fx.txs)) for (const l of e.logs) if (l.query.block === q.block && l.query.address.toLowerCase() === q.address.toLowerCase()) return l.result;
      throw new Error("logs not recorded");
    },
    ...extra,
  };
}

describe("a copy, read from the chain", () => {
  it("the landing's same-block pair: copy tx #22 answers the leader's tx #0 in block 35,025,602", async () => {
    const v = await loadCopy(sameBlockOpen.copy.hash, undefined, replay());
    expect(v).not.toBeNull();
    expect(v!.block).toBe(BigInt(sameBlockOpen.block));
    expect(v!.txIndex).toBe(sameBlockOpen.copy.index);
    expect(v!.via).toBe("handler");
    expect(v!.sameBlock).toBe(true);
    expect(v!.leader).toEqual({ hash: sameBlockOpen.leader.hash, txIndex: sameBlockOpen.leader.index, logIndex: 3 });
    expect(v!.source).toEqual({ kind: "Trader", trader: getAddress(LEADER) });
    expect(v!.fromSize).toBe(0n);
    expect(v!.toSize).toBe(50_000n); // 0.0005 BTC in venue units
    expect(v!.pool).toBe(getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0"));
    expect(v!.siblings).toEqual([]);
  });

  it("matches the leader's own log, not its counterparty's or another trade in the block", async () => {
    // the block holds the counterparty's PositionUpdated in tx #0 and another trade's in tx #1; only the leader's
    // log carries the handler's topics and data
    const v = await loadCopy(sameBlockOpen.copy.hash, undefined, replay());
    expect(v!.leader!.logIndex).toBe(3);
  });

  it("thesis #1's rebalance copy: two legs in one transaction, each its own card via ?log", async () => {
    const first = await loadCopy(thesisRebalance.copy.hash, undefined, replay());
    expect(first!.source).toEqual({ kind: "Theme", themeId: 1n });
    expect(first!.leader).toMatchObject({ hash: thesisRebalance.rebalance.hash, txIndex: thesisRebalance.rebalance.index });
    expect(first!.sameBlock).toBe(true);
    expect(first!.siblings.map((s) => s.logIndex)).toEqual([52]);
    const second = await loadCopy(thesisRebalance.copy.hash, 52, replay());
    expect(second!.logIndex).toBe(52);
    expect(second!.pool).toBe(getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0"));
    expect(second!.siblings.map((s) => s.logIndex)).toEqual([first!.logIndex]);
  });

  it("a copy made by the follow call: no leader and no same-block claim, the function named", async () => {
    const v = await loadCopy(fx.txs.followCopy.hash, undefined, replay());
    expect(v!.via).toBe("call");
    expect(v!.call).toBe("follow");
    expect(v!.sameBlock).toBe(false);
    expect(v!.leader).toBeNull();
    expect(v!.source).toEqual({ kind: "Theme", themeId: 1n });
  });

  it("null (a 404) for a transaction without Copied, an unknown one, a bad hash or a log that is not a copy", async () => {
    expect(await loadCopy(sameBlockOpen.leader.hash, undefined, replay())).toBeNull();
    expect(await loadCopy(bandRefusal.copy.hash, undefined, replay())).toBeNull(); // not recorded: unknown to the node
    expect(await loadCopy("0x1234", undefined, replay())).toBeNull();
    expect(await loadCopy(sameBlockOpen.copy.hash, 999, replay())).toBeNull();
  });

  it("never reads logs for a call copy or a bad hash", async () => {
    const d = replay();
    await loadCopy("nope", undefined, d);
    await loadCopy(fx.txs.followCopy.hash, undefined, d);
    expect(d.calls.filter((c) => c.startsWith("logs"))).toEqual([]);
  });

  it("claims no leader when the trigger is not in the block", async () => {
    const v = await loadCopy(sameBlockOpen.copy.hash, undefined, replay({ logs: async () => [] }));
    expect(v!.via).toBe("handler");
    expect(v!.leader).toBeNull();
    expect(v!.sameBlock).toBe(false);
  });

  it("reads ?log strictly", () => {
    expect(parseLogIndex(undefined)).toBeUndefined();
    expect(parseLogIndex("52")).toBe(52);
    expect(parseLogIndex(["7", "8"])).toBe(7);
    expect(parseLogIndex("5x")).toBe("invalid");
    expect(parseLogIndex("-1")).toBe("invalid");
  });
});

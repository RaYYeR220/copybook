import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import type { RawLog } from "@copybook/sdk";
import { copyReader, loadCopy, parseLogIndex, type CopyDeps, type CopyReceipt, type CopyView, type Persist } from "@/lib/copy";
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

  it("a log read that fails throws: it is never shown as a move missing from the block", async () => {
    const down = replay({
      logs: async () => {
        throw new Error("node did not answer");
      },
    });
    await expect(loadCopy(sameBlockOpen.copy.hash, undefined, down)).rejects.toThrow("node did not answer");
  });

  it("names no move when the trigger is not matched in the block, and still places a handler copy in its block", async () => {
    const v = await loadCopy(sameBlockOpen.copy.hash, undefined, replay({ logs: async () => [] }));
    expect(v!.via).toBe("handler");
    expect(v!.leader).toBeNull();
    // the platform runs a handler in its trigger's block: the claim rests on that, the move is named when found
    expect(v!.sameBlock).toBe(true);
  });

  it("a call copy whose source the partial hub log does not name is returned but marked incomplete", async () => {
    // a catchUp-like call: the input does not decode as follow, so the source comes from the hub's log
    const notFollow = (complete: boolean, found: boolean) =>
      replay({
        transaction: async (h) => ({ ...fx.txs.followCopy.tx, ...(h.toLowerCase() === fx.txs.followCopy.hash.toLowerCase() ? { input: "0xdeadbeef" as Hex } : {}) }),
        sourceOf: async () => ({ source: found ? { kind: "Theme", ref: 1n } : null, complete }),
      });
    const partial = await loadCopy(fx.txs.followCopy.hash, undefined, notFollow(false, false));
    expect(partial!.source).toBeNull();
    expect(partial!.complete).toBe(false);
    const whole = await loadCopy(fx.txs.followCopy.hash, undefined, notFollow(true, false));
    expect(whole!.complete).toBe(true); // the whole log read and no follow names it: final
    const named = await loadCopy(fx.txs.followCopy.hash, undefined, notFollow(false, true));
    expect(named!.source).toEqual({ kind: "Theme", themeId: 1n });
    expect(named!.complete).toBe(true);
  });

  it("reads ?log strictly", () => {
    expect(parseLogIndex(undefined)).toBeUndefined();
    expect(parseLogIndex("52")).toBe(52);
    expect(parseLogIndex(["7", "8"])).toBe(7);
    expect(parseLogIndex("5x")).toBe("invalid");
    expect(parseLogIndex("-1")).toBe("invalid");
  });
});

describe("the copy cache keeps only what will never change", () => {
  const memory = () => {
    const kept = new Map<string, CopyView>();
    const persist: Persist = async (key, load) => {
      const k = key.join("|");
      if (kept.has(k)) return kept.get(k)!;
      const v = await load();
      kept.set(k, v);
      return v;
    };
    return { kept, persist };
  };

  it("a failed log read throws and keeps nothing; the next read renders the same-block copy and keeps it", async () => {
    const { kept, persist } = memory();
    let fail = true;
    const base = replay();
    const deps: CopyDeps = {
      ...base,
      logs: async (q) => {
        if (fail) {
          fail = false;
          throw new Error("timeout");
        }
        return base.logs(q);
      },
    };
    const read = copyReader(deps, persist);
    await expect(read(sameBlockOpen.copy.hash, undefined)).rejects.toThrow("timeout");
    expect(kept.size).toBe(0);
    const v = await read(sameBlockOpen.copy.hash, undefined);
    expect(v!.sameBlock).toBe(true);
    expect(v!.leader!.txIndex).toBe(0);
    expect(kept.size).toBe(1);
    // served from the cache from now on, even with the node down
    const again = await copyReader({ ...deps, receipt: async () => Promise.reject(new Error("down")) }, persist)(sameBlockOpen.copy.hash, undefined);
    expect(again!.sameBlock).toBe(true);
  });

  it("keeps neither 'no copy' nor an incomplete view", async () => {
    const { kept, persist } = memory();
    expect(await copyReader(replay(), persist)(sameBlockOpen.leader.hash, undefined)).toBeNull();
    const partial = copyReader(
      replay({
        transaction: async () => ({ ...fx.txs.followCopy.tx, input: "0xdeadbeef" as Hex }),
        sourceOf: async () => ({ source: null, complete: false }),
      }),
      persist,
    );
    const v = await partial(fx.txs.followCopy.hash, undefined);
    expect(v!.complete).toBe(false);
    expect(kept.size).toBe(0);
  });
});

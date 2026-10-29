import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import type { Market } from "@copybook/sdk";
import { basketMinimum, decodeThemeWord, readRegistryRules, readUpdatedAt, themeSlot, type MarketRead } from "@/lib/builder/registry";

const THEMES = getAddress("0xbca03a20eaf337b7bb35dbd76512af5bc61f6c79");
const OWNER = getAddress("0x5397812d66f3233e0972b7aeb5e195a945504632");
const BTC = getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0");
const ETH = getAddress("0xd6cb1dd58580b84d76068ac21594219ce03aeddf");

/** Read from Hideki2 at block 35,903,213. */
const btc: Market = { pool: BTC, mark: 79807505291418272500000n, tick: 10n ** 17n, minQty: 13000n, lot: 1000n, oneBase: 10n ** 8n };
const eth: Market = { pool: ETH, mark: 2305861551003002500000n, tick: 10n ** 16n, minQty: 4n * 10n ** 15n, lot: 10n ** 14n, oneBase: 10n ** 18n };
/** `_themes[1]`'s first word, read with eth_getStorageAt: thesis #1 after its rebalance in block 35,026,714 (timestamp 1793155832). */
const THESIS_1_WORD = "0x000000006ae162f8000000025397812d66f3233e0972b7aeb5e195a945504632" as Hex;

const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;

describe("the registry's clock, read from storage", () => {
  it("is slot keccak(id, 1), the slot the live thesis #1 word was read from", () => {
    expect(themeSlot(1n)).toBe("0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f");
  });

  it("unpacks creator, version and updatedAt from thesis #1's word", () => {
    expect(decodeThemeWord(THESIS_1_WORD)).toEqual({ creator: OWNER, version: 2, updatedAt: 1793155832 });
  });

  it("is trusted only when the word agrees with themeOf", async () => {
    const client = { getStorageAt: async () => THESIS_1_WORD };
    expect(await readUpdatedAt(client, THEMES, 1n, { creator: OWNER, version: 2 })).toBe(1793155832);
    expect(await readUpdatedAt(client, THEMES, 1n, { creator: OWNER, version: 3 })).toBeNull();
    expect(await readUpdatedAt(client, THEMES, 1n, { creator: BTC, version: 2 })).toBeNull();
    expect(await readUpdatedAt({ getStorageAt: async () => undefined }, THEMES, 1n, { creator: OWNER, version: 2 })).toBeNull();
    expect(await readUpdatedAt({ getStorageAt: async () => "0x" }, THEMES, 1n, { creator: OWNER, version: 2 })).toBeNull();
    expect(await readUpdatedAt({ getStorageAt: async () => `0x${"0".repeat(64)}` as Hex }, THEMES, 1n, { creator: OWNER, version: 2 })).toBeNull();
  });

  it("reads the four limits from the registry's constants", async () => {
    const values: Record<string, bigint> = { MAX_LEGS: 8n, MAX_GROSS_BPS: 30_000n, MIN_LEG_WEIGHT_BPS: 500n, MIN_REBALANCE_INTERVAL: 60n };
    const client = { readContract: async ({ functionName }: { functionName: string }) => values[functionName] };
    expect(await readRegistryRules(client as never, THEMES)).toEqual({ maxLegs: 8, maxGrossBps: 30_000, minLegWeightBps: 500, minRebalanceInterval: 60 });
  });
});

describe("the live minimum while a basket is edited", () => {
  const ok = (m: Market): MarketRead => ({ status: "ok", market: m });
  const reads = { [BTC.toLowerCase()]: ok(btc), [ETH.toLowerCase()]: ok(eth) };

  it("BTC 70 long / ETH 30 short opens from the larger leg minimum, ETH's", () => {
    const r = basketMinimum([{ pool: BTC, weightBps: 7000 }, { pool: ETH, weightBps: -3000 }], reads);
    if (r.status !== "ok") throw new Error(r.status);
    // one minimum order per leg (minQty rounded up to a lot), at the mark, divided by the leg's weight
    const btcMin = ceil(13000n * 10_000n * btc.mark, 7000n * btc.oneBase);
    const ethMin = ceil(4n * 10n ** 15n * 10_000n * eth.mark, 3000n * eth.oneBase);
    expect(r.minimum.perLeg.map((p) => p.minAllocation)).toEqual([btcMin, ethMin]);
    expect(r.minimum.allocation).toBe(ethMin);
    expect(r.minimum.bindingPool).toBe(ETH);
    expect(r.recommended).toBe(ceil(ethMin * 11_000n, 10_000n));
    // $30.75: 0.004 ETH at $2,305.86 is $9.22, a 30% leg
    expect(Number(r.minimum.allocation / 10n ** 16n) / 100).toBeCloseTo(30.75, 1);
  });

  it("moving weight onto ETH lowers it", () => {
    const a = basketMinimum([{ pool: BTC, weightBps: 7000 }, { pool: ETH, weightBps: -3000 }], reads);
    const b = basketMinimum([{ pool: BTC, weightBps: 5000 }, { pool: ETH, weightBps: -5000 }], reads);
    if (a.status !== "ok" || b.status !== "ok") throw new Error("not ok");
    expect(b.minimum.allocation < a.minimum.allocation).toBe(true);
  });

  it("says what it is waiting for, and never prints a figure without every market", () => {
    expect(basketMinimum([], reads).status).toBe("empty");
    expect(basketMinimum([{ pool: BTC, weightBps: 0 }], reads).status).toBe("empty");
    expect(basketMinimum([{ pool: BTC, weightBps: 7000 }, { pool: ETH, weightBps: 3000 }], { [BTC.toLowerCase()]: ok(btc) })).toEqual({ status: "reading", pools: [ETH] });
    expect(basketMinimum([{ pool: BTC, weightBps: 7000 }], { [BTC.toLowerCase()]: { status: "error" } })).toEqual({ status: "unavailable", pools: [BTC], why: "unreadable" });
    expect(basketMinimum([{ pool: BTC, weightBps: 7000 }], { [BTC.toLowerCase()]: ok({ ...btc, mark: 0n }) })).toEqual({ status: "unavailable", pools: [BTC], why: "untradeable" });
  });

  it("matches the SDK's figure for the same legs (the one /thesis/[id] shows once published)", async () => {
    const { minThemeAllocation } = await import("@copybook/sdk");
    const legs = [{ pool: BTC as Address, weightBps: 7000 }, { pool: ETH as Address, weightBps: -3000 }];
    const r = basketMinimum(legs, reads);
    expect(r.status === "ok" && r.minimum).toEqual(minThemeAllocation(legs, new Map([[BTC.toLowerCase(), btc], [ETH.toLowerCase(), eth]])));
  });
});

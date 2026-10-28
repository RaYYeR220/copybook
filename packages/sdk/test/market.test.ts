import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { minOrderQty, minThemeAllocation, notionalOf, simulateLeg, themeTarget, tradableQty, withHeadroom } from "../src/market.ts";
import type { Market } from "../src/types.ts";

const E = 10n ** 18n;
const BTC = "0x00000000000000000000000000000000000000b1" as Address;
const ETH = "0x00000000000000000000000000000000000000e1" as Address;

// BTC: 0.00013 minimum (the live figure), lot 0.00001; ETH: 0.004 minimum, lot 0.001
const btc: Market = { pool: BTC, mark: 60_000n * E, tick: E / 10n, minQty: 13n * 10n ** 13n, lot: 10n ** 13n, oneBase: E };
const eth: Market = { pool: ETH, mark: 3_000n * E, tick: E / 100n, minQty: 4n * 10n ** 15n, lot: 10n ** 15n, oneBase: E };

describe("market math", () => {
  it("rounds sizes to lots and drops anything under the venue minimum", () => {
    expect(tradableQty(25n * 10n ** 13n + 7n, btc)).toBe(25n * 10n ** 13n);
    expect(tradableQty(12n * 10n ** 13n, btc)).toBe(0n);
    expect(tradableQty(13n * 10n ** 13n, btc)).toBe(13n * 10n ** 13n);
  });

  it("takes one order as the minimum rounded up to a lot", () => {
    expect(minOrderQty(btc)).toBe(13n * 10n ** 13n);
    expect(minOrderQty({ lot: 10n, minQty: 25n })).toBe(30n);
    expect(minOrderQty({ lot: 10n, minQty: 0n })).toBe(10n);
  });

  it("sizes a theme leg like the contract: magnitude rounded down, sign kept", () => {
    expect(themeTarget(80n * E, 2_500, eth)).toBe((80n * E * 2_500n * E) / (10_000n * 3_000n * E));
    expect(themeTarget(80n * E, -2_500, eth)).toBe(-themeTarget(80n * E, 2_500, eth));
    expect(themeTarget(80n * E, 0, eth)).toBe(0n);
  });

  it("finds the smallest allocation that opens every leg, and that one wei less does not", () => {
    const legs = [
      { pool: BTC, weightBps: 4_000 },
      { pool: ETH, weightBps: -2_000 },
    ];
    const map = new Map([[BTC.toLowerCase(), btc], [ETH.toLowerCase(), eth]]);
    const min = minThemeAllocation(legs, map);
    for (const leg of legs) {
      const m = leg.pool === BTC ? btc : eth;
      expect(simulateLeg(min.allocation, leg, 2n ** 200n, m).opens).toBe(true);
    }
    const binding = legs.find((l) => l.pool === min.bindingPool)!;
    const bm = binding.pool === BTC ? btc : eth;
    expect(simulateLeg(min.allocation - 1n, binding, 2n ** 200n, bm).opens).toBe(false);
    // ETH 20% short needs 0.004 ETH = 12 USD, so allocation 60 USD; BTC 40% needs 0.00013 BTC = 7.8 USD, so 19.5 USD
    expect(min.allocation).toBe(60n * E);
    expect(min.bindingPool).toBe(ETH);
  });

  it("reports the smallest per-position cap that keeps every leg openable", () => {
    const legs = [{ pool: ETH, weightBps: 5_000 }];
    const min = minThemeAllocation(legs, new Map([[ETH.toLowerCase(), eth]]));
    expect(min.maxNotional).toBe(12n * E);
    expect(simulateLeg(1_000n * E, legs[0]!, min.maxNotional, eth)).toMatchObject({ opens: true, capped: true });
    expect(simulateLeg(1_000n * E, legs[0]!, min.maxNotional - 1n, eth).opens).toBe(false);
  });

  it("rejects a market it has no data for", () => {
    expect(() => minThemeAllocation([{ pool: BTC, weightBps: 1_000 }], new Map())).toThrow(/no market data/);
    expect(() => minThemeAllocation([{ pool: BTC, weightBps: 1_000 }], new Map([[BTC.toLowerCase(), { ...btc, mark: 0n }]]))).toThrow(/no usable/);
  });

  it("clamps a leg at maxNotional and reports it", () => {
    const sim = simulateLeg(10_000n * E, { pool: ETH, weightBps: 10_000 }, 300n * E, eth);
    expect(sim.capped).toBe(true);
    expect(notionalOf(sim.target, eth)).toBeLessThanOrEqual(300n * E);
    expect(sim.tradable).toBe(10n ** 17n);
  });

  it("adds headroom rounded up", () => {
    expect(withHeadroom(100n, 1_000)).toBe(110n);
    expect(withHeadroom(101n, 1)).toBe(102n);
  });
});

import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import type { Leg } from "@copybook/sdk";
import {
  REGISTRY_SOURCE_RULES,
  checkBasket,
  checkName,
  checkRebalance,
  checkUri,
  legDiff,
  parseRows,
  parseWeight,
  rebalanceWait,
  sameLegs,
  type BasketRow,
} from "@/lib/builder/basket";

const BTC = getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0");
const ETH = getAddress("0xd6cb1dd58580b84d76068ac21594219ce03aeddf");
const SOL = getAddress("0xb483ec1fb34996638677c20ab087b16f1896fa53");
const FOREIGN = "0x000000000000000000000000000000000000dEaD" as Address;
const rules = REGISTRY_SOURCE_RULES;
const registered = (pools: Address[]) => Object.fromEntries(pools.map((p) => [p.toLowerCase(), true]));
const all = { ...registered([BTC, ETH, SOL]), [FOREIGN.toLowerCase()]: false };

const row = (pool: Address | "", side: "long" | "short", weight: string, key = Math.random().toString()): BasketRow => ({ key, pool, side, weight });
const codes = (legs: Leg[], reg: Record<string, boolean | undefined> = all) => checkBasket(legs, rules, reg).map((i) => i.code);

describe("weights as typed", () => {
  it("reads a percentage with up to two decimals as whole bps", () => {
    expect(parseWeight("50")).toBe(5000);
    expect(parseWeight("12.5")).toBe(1250);
    expect(parseWeight(" 5.00 % ")).toBe(500);
    expect(parseWeight("4.99")).toBe(499);
    expect(parseWeight("0")).toBe(0);
  });

  it("refuses what is not a share in bps", () => {
    expect(parseWeight("")).toBe("missing");
    expect(parseWeight("1.234")).toBe("invalid"); // bps are whole numbers
    expect(parseWeight("-5")).toBe("invalid"); // the side carries the sign
    expect(parseWeight("1e3")).toBe("invalid");
    expect(parseWeight("abc")).toBe("invalid");
  });

  it("turns rows into signed legs and reports the incomplete ones by row", () => {
    const p = parseRows([row(BTC, "long", "70"), row(ETH, "short", "30"), row("", "long", "10"), row(SOL, "long", "x")]);
    expect(p.legs).toEqual([
      { pool: BTC, weightBps: 7000 },
      { pool: ETH, weightBps: -3000 },
    ]);
    expect(p.issues.map((i) => [i.code, i.row])).toEqual([
      ["PickMarket", 2],
      ["WeightInvalid", 3],
    ]);
    expect(p.issues.every((i) => i.by === "app")).toBe(true);
  });
});

describe("the ThemeRegistry's rules, mirrored before signing", () => {
  it("passes the live thesis #1 basket (BTC 70 long, ETH 30 short)", () => {
    expect(codes([{ pool: BTC, weightBps: 7000 }, { pool: ETH, weightBps: -3000 }])).toEqual([]);
  });

  it("NoLegs: an empty basket", () => {
    expect(codes([])).toEqual(["NoLegs"]);
  });

  it("TooManyLegs: one more than MAX_LEGS", () => {
    const legs = Array.from({ length: rules.maxLegs + 1 }, (_, i) => ({ pool: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, weightBps: 1000 }));
    const reg = Object.fromEntries(legs.map((l) => [l.pool.toLowerCase(), true]));
    expect(codes(legs, reg)).toEqual(["TooManyLegs"]);
    expect(codes(legs.slice(0, rules.maxLegs), reg)).toEqual([]);
  });

  it("ZeroWeight: a leg at 0", () => {
    expect(codes([{ pool: BTC, weightBps: 0 }])).toEqual(["ZeroWeight"]);
  });

  it("WeightTooSmall: 499 bps either side refused, 500 accepted", () => {
    expect(codes([{ pool: BTC, weightBps: 499 }])).toEqual(["WeightTooSmall"]);
    expect(codes([{ pool: BTC, weightBps: -499 }])).toEqual(["WeightTooSmall"]);
    expect(codes([{ pool: BTC, weightBps: 500 }])).toEqual([]);
    expect(codes([{ pool: BTC, weightBps: -500 }])).toEqual([]);
    const issue = checkBasket([{ pool: BTC, weightBps: 499 }], rules, all)[0];
    expect(issue.fix).toEqual({ row: 0, weight: "5" });
  });

  it("DuplicatePool: the same market twice, any case, flagged on the later leg", () => {
    const issues = checkBasket([{ pool: BTC, weightBps: 5000 }, { pool: ETH, weightBps: -2000 }, { pool: BTC.toLowerCase() as Address, weightBps: -1000 }], rules, all);
    expect(issues.map((i) => [i.code, i.row])).toEqual([["DuplicatePool", 2]]);
  });

  it("ForeignPool: a pool the margin bank has not registered", () => {
    expect(codes([{ pool: FOREIGN, weightBps: 5000 }])).toEqual(["ForeignPool"]);
  });

  it("an unread registration holds signing back until it is known", () => {
    const issues = checkBasket([{ pool: SOL, weightBps: 5000 }], rules, {});
    expect(issues.map((i) => [i.code, i.severity])).toEqual([["RegistrationUnknown", "checking"]]);
  });

  it("GrossTooHigh: 30,000 bps gross passes, 30,001 is refused", () => {
    const at = [{ pool: BTC, weightBps: 15000 }, { pool: ETH, weightBps: -10000 }, { pool: SOL, weightBps: 5000 }];
    expect(codes(at)).toEqual([]);
    const over = [{ pool: BTC, weightBps: 15000 }, { pool: ETH, weightBps: -10000 }, { pool: SOL, weightBps: 5001 }];
    expect(codes(over)).toEqual(["GrossTooHigh"]);
    expect(checkBasket(over, rules, all)[0].message).toMatch(/300\.01%/);
  });

  it("every issue names the contract error it mirrors", () => {
    const issues = checkBasket([{ pool: BTC, weightBps: 0 }, { pool: FOREIGN, weightBps: 100 }], rules, all);
    expect(issues.map((i) => i.code)).toEqual(["ZeroWeight", "WeightTooSmall", "ForeignPool"]);
    expect(issues.every((i) => i.by === "registry" && i.message.includes(`(${i.code})`))).toBe(true);
  });

  it("reads the limits it is given (the live constants), not its own", () => {
    const tighter = { ...rules, maxLegs: 1, minLegWeightBps: 1000 };
    expect(checkBasket([{ pool: BTC, weightBps: 900 }, { pool: ETH, weightBps: 1000 }], tighter, all).map((i) => i.code)).toEqual(["TooManyLegs", "WeightTooSmall"]);
  });
});

describe("name and link (the registry takes any string; these are the app's limits)", () => {
  it("needs a name of 1 to 48 characters without control characters", () => {
    expect(checkName("BTC vs ETH")).toEqual([]);
    expect(checkName("   ").map((i) => i.code)).toEqual(["NameMissing"]);
    expect(checkName("x".repeat(49)).map((i) => i.code)).toEqual(["NameTooLong"]);
    expect(checkName("a\u0000b").map((i) => i.code)).toEqual(["NameInvalid"]);
    expect(checkName("x".repeat(48))).toEqual([]);
  });

  it("takes no link, or an https or ipfs link", () => {
    expect(checkUri("")).toEqual([]);
    expect(checkUri("https://example.org/why")).toEqual([]);
    expect(checkUri("ipfs://bafy")).toEqual([]);
    expect(checkUri("javascript:alert(1)").map((i) => i.code)).toEqual(["UriInvalid"]);
    expect(checkUri("not a link").map((i) => i.code)).toEqual(["UriInvalid"]);
    expect(checkUri(`https://e.org/${"a".repeat(300)}`).map((i) => i.code)).toEqual(["UriTooLong"]);
  });
});

describe("rebalance", () => {
  const creator = "0x5397812d66F3233E0972b7AEB5e195a945504632" as Address;
  const current: Leg[] = [{ pool: BTC, weightBps: 7000 }, { pool: ETH, weightBps: -3000 }];
  const base = { creator, account: creator, current, updatedAt: 1_000, rules, registered: all };

  it("NoChange mirrors _same: the same pairs in any order", () => {
    expect(sameLegs(current, [{ pool: ETH, weightBps: -3000 }, { pool: BTC.toLowerCase() as Address, weightBps: 7000 }])).toBe(true);
    expect(sameLegs(current, [{ pool: BTC, weightBps: 7000 }])).toBe(false);
    expect(sameLegs(current, [{ pool: BTC, weightBps: 7000 }, { pool: ETH, weightBps: 3000 }])).toBe(false);
    expect(checkRebalance({ ...base, next: [...current].reverse(), chainNow: 2_000 }).map((i) => i.code)).toEqual(["NoChange"]);
  });

  it("RebalanceTooSoon until updatedAt + MIN_REBALANCE_INTERVAL, in chain seconds", () => {
    const next = [{ pool: BTC, weightBps: 5000 }, { pool: ETH, weightBps: -5000 }];
    expect(rebalanceWait(1_000, 1_059, 60)).toBe(1);
    expect(rebalanceWait(1_000, 1_060, 60)).toBe(0);
    const early = checkRebalance({ ...base, next, chainNow: 1_059 });
    expect(early.map((i) => [i.code, i.severity])).toEqual([["RebalanceTooSoon", "wait"]]);
    expect(checkRebalance({ ...base, next, chainNow: 1_060 })).toEqual([]);
  });

  it("leaves the interval to the gas estimate while the clock is unread", () => {
    const next = [{ pool: BTC, weightBps: 5000 }, { pool: ETH, weightBps: -5000 }];
    expect(checkRebalance({ ...base, next, updatedAt: null, chainNow: 1_001 })).toEqual([]);
    expect(checkRebalance({ ...base, next, updatedAt: 1_000, chainNow: null })).toEqual([]);
  });

  it("NotCreator for any other wallet, before anything else", () => {
    const other = "0x7d7300000000000000000000000000000000193a" as Address;
    expect(checkRebalance({ ...base, account: other, next: [], chainNow: 1_000 }).map((i) => i.code)).toEqual(["NotCreator"]);
  });

  it("runs the basket rules on the new legs too", () => {
    expect(checkRebalance({ ...base, next: [{ pool: BTC, weightBps: 499 }], chainNow: 9_999 }).map((i) => i.code)).toEqual(["WeightTooSmall"]);
  });

  it("names what changes per market", () => {
    const d = legDiff(current, [{ pool: BTC, weightBps: 5000 }, { pool: ETH, weightBps: 3000 }, { pool: SOL, weightBps: -2000 }]);
    expect(d.map((x) => [x.pool, x.change, x.from, x.to])).toEqual([
      [BTC, "resized", 7000, 5000],
      [ETH, "flipped", -3000, 3000],
      [SOL, "added", 0, -2000],
    ]);
    expect(legDiff(current, [{ pool: BTC, weightBps: 7000 }]).map((x) => [x.pool, x.change])).toEqual([
      [BTC, "same"],
      [ETH, "dropped"],
    ]);
  });
});

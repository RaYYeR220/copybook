import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { preflightFollow, type PreflightInput } from "../src/preflight.ts";
import { MIN_TANK } from "../src/constants.ts";
import { BTC, E, ETH, ME, TRADER, followed, policy, world } from "./world.ts";
import { deployments } from "./fake.ts";

const run = (c: ReturnType<typeof world>, input: Partial<PreflightInput>) =>
  preflightFollow(
    { publicClient: c.publicClient, deployments },
    {
      account: ME,
      kind: "Theme",
      source: 1n,
      policy: policy({ allocation: 200n * E }),
      tank: 1n * E,
      walletChainId: 50383,
      ...input,
    },
  );
const codes = (r: Awaited<ReturnType<typeof run>>) => r.reasons.filter((x) => x.severity === "error").map((x) => x.code);

describe("preflightFollow (thesis)", () => {
  it("passes a healthy follow and reports the minimums", async () => {
    const r = await run(world(), {});
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual([]);
    // BTC leg needs 0.00013 BTC = 7.8 USD at 40% -> 19.5 USD; ETH leg needs 0.004 ETH = 12 USD at 20% -> 60 USD
    expect(r.themeMinimum?.allocation).toBe(60n * E);
    expect(r.themeMinimum?.recommendedAllocation).toBe(66n * E);
    expect(r.steps).toEqual([
      { id: "approveOperator", done: true },
      { id: "follow", done: false },
    ]);
  });

  it("catches an allocation below a leg's minimum before signing, naming the leg and the figure", async () => {
    const r = await run(world(), { policy: policy({ allocation: 50n * E }) });
    expect(r.ok).toBe(false);
    const bad = r.reasons.find((x) => x.code === "ALLOCATION_BELOW_MINIMUM")!;
    expect(bad).toMatchObject({ severity: "error", field: "allocation", pool: ETH, required: 60n * E });
    expect(bad.message).toContain("60");
    expect(r.reasons.some((x) => x.pool === BTC && x.code === "ALLOCATION_BELOW_MINIMUM")).toBe(false);
  });

  it("catches a per-position cap below one order", async () => {
    const r = await run(world(), { policy: policy({ allocation: 200n * E, maxNotional: 10n * E }) });
    expect(codes(r)).toContain("CAP_BELOW_ONE_ORDER");
    expect(r.reasons.find((x) => x.code === "CAP_BELOW_ONE_ORDER")).toMatchObject({ pool: ETH, field: "maxNotional", required: 12n * E });
  });

  it("catches a whole-book cap below the basket", async () => {
    const r = await run(world(), { policy: policy({ allocation: 200n * E, maxTotalNotional: 50n * E }) });
    expect(codes(r)).toContain("TOTAL_CAP_BELOW_BASKET");
  });

  it("catches a tank below the minimum", async () => {
    const r = await run(world(), { tank: MIN_TANK - 1n });
    expect(r.reasons.find((x) => x.code === "TANK_TOO_LOW")).toMatchObject({ severity: "error", field: "tank", required: MIN_TANK });
    expect((await run(world(), { tank: MIN_TANK })).ok).toBe(true);
  });

  it("catches the wrong chain and a missing wallet", async () => {
    expect(codes(await run(world(), { walletChainId: 1 }))).toContain("WRONG_CHAIN");
    const none = await run(world(), { account: undefined, walletChainId: undefined });
    expect(codes(none)).toContain("NO_ACCOUNT");
  });

  it("catches a wallet that already follows", async () => {
    const c = world();
    c.on(deployments.hub, "followOf", followed(1, 1n));
    const r = await run(c, {});
    expect(codes(r)).toContain("ALREADY_FOLLOWING");
    expect(r.steps.find((s) => s.id === "follow")?.done).toBe(true);
  });

  it("catches paused follows, an unknown thesis and a short wallet", async () => {
    const c = world();
    c.on(deployments.hub, "followsPaused", true);
    expect(codes(await run(c, {}))).toContain("FOLLOWS_PAUSED");
    expect(codes(await run(world(), { source: 9n }))).toContain("INVALID_SOURCE");
    const poor = world();
    poor.balance = 5n * 10n ** 17n;
    expect(codes(await run(poor, { tank: 1n * E }))).toContain("INSUFFICIENT_BALANCE");
  });

  it("flags a missing operator approval as the first step to run, not as a blocker", async () => {
    const c = world();
    c.on(deployments.operatorRegistry, "isGloballyApproved", false);
    const r = await run(c, {});
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toEqual({ id: "approveOperator", done: false });
    expect(r.reasons.find((x) => x.code === "OPERATOR_NOT_APPROVED")?.severity).toBe("info");
  });

  it("reports a leg whose market cannot be read", async () => {
    const c = world();
    c.on(ETH, "getMarkPrice", 0n);
    const r = await run(c, {});
    expect(r.reasons.find((x) => x.code === "UNKNOWN_MARKET")).toMatchObject({ pool: ETH, severity: "error" });
  });

  it("rejects invalid policy fields like the contract does", async () => {
    const r = await run(world(), { policy: policy({ allocation: 0n, maxNotional: 0n, bandBps: 501 }) });
    expect(r.reasons.filter((x) => x.code === "INVALID_POLICY").map((x) => x.field).sort()).toEqual(["allocation", "bandBps", "maxNotional"]);
  });

  it("flags an equity already below the floor", async () => {
    const r = await run(world(), { policy: policy({ allocation: 200n * E, equityFloor: 5_000n * E }) });
    expect(r.reasons.find((x) => x.code === "EQUITY_BELOW_FLOOR")).toMatchObject({ severity: "error", field: "equityFloor" });
  });
});

describe("preflightFollow (trader)", () => {
  const trader = { kind: "Trader" as const, source: TRADER, joinPools: [ETH] };

  it("passes and says allowAll mirrors the open book when no markets are named", async () => {
    const r = await run(world(), { ...trader, joinPools: [] });
    expect(r.ok).toBe(true);
    expect(r.reasons.find((x) => x.code === "ALLOW_ALL_MIRRORS_OPEN_BOOK")?.severity).toBe("info");
  });

  it("rejects following yourself and a zero address", async () => {
    expect(codes(await run(world(), { ...trader, source: ME }))).toContain("INVALID_SOURCE");
    expect(codes(await run(world(), { ...trader, source: "0x0000000000000000000000000000000000000000" }))).toContain("INVALID_SOURCE");
  });

  it("rejects a cap below one order in a named market", async () => {
    const r = await run(world(), { ...trader, policy: policy({ maxNotional: 5n * E }) });
    expect(r.reasons.find((x) => x.code === "CAP_BELOW_ONE_ORDER")).toMatchObject({ pool: ETH, required: 12n * E });
  });

  it("warns when the trader's position scales below the minimum order", async () => {
    const c = world();
    c.on(deployments.marginBank, "getPosition", (args: readonly unknown[]) => ({
      size: args[0] === TRADER ? 5n * 10n ** 15n : 0n,
      avgEntryPrice: 0n,
      entryFundingIndex: 0n,
      lastUpdatedTimestampNs: 0n,
    }));
    const r = await run(c, { ...trader, policy: policy({ scaleBps: 5_000 }) });
    expect(r.ok).toBe(true);
    expect(r.reasons.find((x) => x.code === "SCALED_BELOW_MINIMUM")).toMatchObject({ severity: "warning", pool: ETH });
  });

  it("warns when the AI guard will refuse increases from a blocked trader", async () => {
    const c = world();
    const now = Math.floor(Date.now() / 1000);
    c.on(deployments.gate, "verdictOf", { tier: 3, reviewedAt: BigInt(now - 60), shannonRequestId: 1n, summaryHash: `0x${"00".repeat(32)}` });
    expect((await run(c, trader)).reasons.find((x) => x.code === "TRADER_BLOCKED")?.severity).toBe("warning");
    c.on(deployments.gate, "guardOf", false);
    expect((await run(c, trader)).reasons.some((x) => x.code === "TRADER_BLOCKED")).toBe(false);
  });

  it("rejects a market list on a theme follow and too many pools", async () => {
    expect(codes(await run(world(), { joinPools: [ETH] }))).toContain("JOIN_POOLS_NOT_ALLOWED");
    const many = Array.from({ length: 33 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
    expect(codes(await run(world(), { ...trader, joinPools: many }))).toContain("TOO_MANY_POOLS");
  });
});

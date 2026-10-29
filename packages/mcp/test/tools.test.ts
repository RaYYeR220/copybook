import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CopybookError, type PreflightResult } from "@copybook/sdk";
import { depsFromEnv, banner } from "../src/config.ts";
import { parseDecimal, InputError } from "../src/units.ts";
import { buildTools } from "../src/tools.ts";
import { createServer, runTool } from "../src/server.ts";
import type { Deps, ToolDef } from "../src/types.ts";

const HUB = "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154";
const AGENT = "0x1111111111111111111111111111111111111111";
const TRADER = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const DEMO = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932";
const COPIER = "0x4444444444444444444444444444444444444444";
const E18 = 10n ** 18n;

const okPre: PreflightResult = {
  ok: true,
  reasons: [{ code: "OPERATOR_NOT_APPROVED", severity: "info", message: "needs approval" }],
  steps: [
    { id: "approveOperator", done: false },
    { id: "follow", done: false },
  ],
};

const tx = (hash: string, events: unknown[] = []) => ({ hash, wait: vi.fn(async () => ({ hash, receipt: {}, events })) });

function fakeDeps(over: { agent?: boolean; pre?: PreflightResult; copybook?: Record<string, unknown> } = {}) {
  const copybook = {
    deployments: {
      chainId: 50383,
      hub: HUB,
      engine: "0xE37F735b8E43e63E56f7E550e732Ab808257D56A",
      themes: "0xbcA03A20eaf337b7bb35DBD76512Af5BC61f6c79",
      gate: "0xEe54000000000000000000000000000000000001",
      operatorRegistry: "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a",
      deployBlock: 100n,
      demoWallets: [{ address: DEMO, role: "demo follower" }],
    },
    ctx: { publicClient: { getBlockNumber: vi.fn(async () => 1_000_000n) } },
    preflightFollow: vi.fn(async () => over.pre ?? okPre),
    encode: { follow: vi.fn(() => "0xdeadbeef") },
    approveOperator: vi.fn(async () => tx("0xaaa")),
    follow: vi.fn(async () => tx("0xbbb", [{ name: "Followed" }])),
    unfollow: vi.fn(async () => tx("0xccc")),
    withdrawTank: vi.fn(async () => tx("0xfff")),
    tankOf: vi.fn(async () => E18 / 2n),
    requestReview: vi.fn(async () => tx("0xddd")),
    createTheme: vi.fn(async () => tx("0xeee", [{ name: "ThemeCreated", themeId: 7n }])),
    followOf: vi.fn(async () => null),
    isOperatorApproved: vi.fn(async () => true),
    market: vi.fn(async (pool: string) => ({ pool, mark: E18, tick: 1n, lot: 1n, minQty: 1n, oneBase: E18 })),
    verdictOf: vi.fn(async () => ({ tier: "Block", reviewedAt: 1_700_000_000, shannonRequestId: 1n, summaryHash: "0x", blocking: true, blockExpiresAt: 1_700_086_400 })),
    reviewPendingOf: vi.fn(async () => null),
    reviewFee: vi.fn(async () => E18 / 10n),
    themeCount: vi.fn(async () => 2n),
    theme: vi.fn(async (id: bigint) => ({ id, creator: AGENT, name: "Majors", uri: "", version: 3, legs: [{ pool: POOL, weightBps: 5000 }, { pool: TRADER, weightBps: -2500 }] })),
    themes: vi.fn(async () => [{ id: 1n, creator: AGENT, name: "Majors", uri: "", version: 1, legs: [{ pool: POOL, weightBps: 5000 }] }]),
    themeMinimum: vi.fn(async () => ({ allocation: 120n * E18, recommendedAllocation: 132n * E18, maxNotional: 15n * E18, bindingPool: POOL, perLeg: [{ pool: POOL, weightBps: 5000, minAllocation: 120n * E18, minMaxNotional: 15n * E18 }] })),
    status: vi.fn(async () => ({
      follower: AGENT,
      follow: { follower: AGENT, kind: "Trader", trader: TRADER, policy: { scaleBps: 10000, allocation: 0n, maxNotional: 50n * E18, maxTotalNotional: 0n, bandBps: 50, equityFloor: 0n }, paused: true },
      tank: E18 / 100n,
      pending: { exitPending: false, flattenPending: false },
      synced: [POOL],
      guardOn: true,
      issues: [
        { code: "STOPPED", severity: "error", message: "stopped", action: { method: "resume" } },
        { code: "TANK_EMPTY", severity: "error", message: "empty", action: { method: "fundTank", args: [200_000_000_000_000_000n] } },
      ],
    })),
    history: vi.fn(async () => ({
      fromBlock: 999_999n,
      toBlock: 1_000_000n,
      events: [{ name: "Copied", follower: AGENT, pool: POOL, fromSize: 0n, toSize: 5n, limitPrice: E18, capped: false, log: { blockNumber: 12n, transactionHash: "0xabc", logIndex: 0 } }],
    })),
    ...over.copybook,
  };
  const stats = {
    getTraderStats: vi.fn(async () => ({ trader: TRADER, windowDays: 30, trades30d: 40, hasHistory: true, truncated: false, realizedPnl30d: 12.5 })),
    topTraders: vi.fn(async () => ({
      traders: [{ rank: 1, trader: TRADER, realizedPnl30d: 12.5, riskAdjusted: 2, stats: { windowDays: 30 } }],
      skipped: [{ account: POOL, reason: "indexer error" }],
      candidateShortfall: true,
    })),
    riskSummary: vi.fn(() => "trades30d=40"),
    openPositionPools: vi.fn(async (): Promise<string[]> => []),
  };
  const deps = { copybook, stats, ...(over.agent === false ? {} : { agent: AGENT }) } as unknown as Deps;
  return { deps, copybook, stats };
}

const find = (tools: ToolDef[], name: string) => tools.find((t) => t.name === name)!;
const call = async (deps: Deps, name: string, args: Record<string, unknown> = {}) => {
  const r = await runTool(find(buildTools(deps), name), args, deps.secrets);
  return { isError: r.isError ?? false, body: JSON.parse(r.content[0]!.text) };
};

const policyArgs = { maxNotionalUsdso: "50", tankStt: "0.5" };

describe("read tools", () => {
  it("list_top_traders ranks with the app's options, leaves out our wallets, and surfaces skipped/shortfall", async () => {
    const { deps, stats } = fakeDeps();
    const { body } = await call(deps, "list_top_traders", { n: 5, windowDays: 14 });
    const [n, window, opts] = stats.topTraders.mock.calls[0] as unknown as [number, number, Record<string, unknown> & { exclude: string[] }];
    expect([n, window]).toEqual([8, 14]);
    expect(opts).toMatchObject({ minTrades: 20, minActiveDays: 5, maxLiquidations: 1, maxRows: 2000, candidateLimit: 20 });
    expect(opts.exclude).toEqual(expect.arrayContaining([HUB, DEMO, AGENT]));
    expect(body.traders[0]).toMatchObject({ rank: 1, trader: TRADER, summary: "trades30d=40" });
    expect(body.candidateShortfall).toBe(true);
    expect(body.skipped).toHaveLength(1);
  });

  it("list_top_traders drops a wallet that follows through the hub now, and renumbers", async () => {
    const { deps, stats, copybook } = fakeDeps();
    stats.topTraders.mockResolvedValue({
      traders: [
        { rank: 1, trader: COPIER, realizedPnl30d: 99, riskAdjusted: 1, stats: { windowDays: 30 } },
        { rank: 2, trader: TRADER, realizedPnl30d: 12.5, riskAdjusted: 2, stats: { windowDays: 30 } },
      ],
      skipped: [],
      candidateShortfall: false,
    } as never);
    copybook.followOf.mockImplementation((async (a: string) => (a === COPIER ? { kind: "Trader" } : null)) as never);
    const { body } = await call(deps, "list_top_traders", { n: 5 });
    expect(body.traders.map((t: { rank: number; trader: string }) => [t.rank, t.trader])).toEqual([[1, TRADER]]);
    expect(body.leftOutAsCopyWallets).toEqual([COPIER]);
  });

  it("get_trader_stats returns stats with the summary and rejects a bad address", async () => {
    const { deps, stats } = fakeDeps();
    const ok = await call(deps, "get_trader_stats", { trader: TRADER });
    expect(stats.getTraderStats).toHaveBeenCalledWith(TRADER, { windowDays: 30 });
    expect(ok.body.summary).toBe("trades30d=40");
    const bad = await call(deps, "get_trader_stats", { trader: "nope" });
    expect(bad.isError).toBe(true);
    expect(bad.body.reason).toMatch(/0x address/);
  });

  it("get_verdict reports tier, review time and the active Block hold", async () => {
    const { deps } = fakeDeps();
    const { body } = await call(deps, "get_verdict", { trader: TRADER });
    expect(body).toMatchObject({ tier: "Block", blockHoldActive: true, reviewPending: null, reviewFeeStt: "0.1" });
    expect(body.reviewedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(body.blockHoldExpiresAt).toBe("2023-11-15T22:13:20.000Z");
  });

  it("list_theses and get_thesis show legs, version and the minimum allocation", async () => {
    const { deps } = fakeDeps();
    const list = await call(deps, "list_theses");
    expect(list.body.theses[0]).toMatchObject({ id: "1", name: "Majors", version: 1 });
    const one = await call(deps, "get_thesis", { id: 2 });
    expect(one.body.version).toBe(3);
    expect(one.body.legs[1]).toMatchObject({ weightBps: -2500, side: "short" });
    expect(one.body.minimum).toMatchObject({ minAllocationUsdso: "120", recommendedAllocationUsdso: "132", minPerPositionCapUsdso: "15" });
    const missing = await call(deps, "get_thesis", { id: 9 });
    expect(missing.isError).toBe(true);
  });

  it("get_thesis keeps the thesis when a market cannot be priced", async () => {
    const { deps } = fakeDeps({ copybook: { themeMinimum: vi.fn(async () => { throw new Error("no mark"); }) } });
    const { body, isError } = await call(deps, "get_thesis", { id: 1 });
    expect(isError).toBe(false);
    expect(body.minimum).toBeNull();
    expect(body.note).toMatch(/Minimum unavailable/);
  });

  it("get_follow lists issues with the call that clears each, and defaults to the agent wallet", async () => {
    const { deps, copybook } = fakeDeps();
    const { body } = await call(deps, "get_follow");
    expect(copybook.status).toHaveBeenCalledWith(AGENT);
    expect(body.following).toMatchObject({ kind: "Trader", stopped: true, policy: { maxNotionalUsdso: "50" } });
    expect(body.tankStt).toBe("0.01");
    expect(body.issues[0].clearWith).toEqual({ method: "resume" });
    expect(body.issues[1].clearWith).toEqual({ method: "fundTank", args: ["200000000000000000"] });
  });

  it("get_follow without a follower and without a key asks for one", async () => {
    const { deps } = fakeDeps({ agent: false });
    expect((await call(deps, "get_follow")).isError).toBe(true);
  });

  it("get_copy_history reads from a default look-back and from an explicit block", async () => {
    const { deps, copybook } = fakeDeps();
    const a = await call(deps, "get_copy_history", { follower: AGENT });
    expect(copybook.history).toHaveBeenLastCalledWith({ fromBlock: 950_000n, follower: AGENT });
    expect(a.body.events[0]).toMatchObject({ name: "Copied", toSize: "5", block: "12", txHash: "0xabc" });
    await call(deps, "get_copy_history", { follower: AGENT, fromBlock: 500 });
    expect(copybook.history).toHaveBeenLastCalledWith({ fromBlock: 500n, follower: AGENT });
  });
});

describe("write tools without a key", () => {
  const writes = [
    ["follow_trader", { trader: TRADER, ...policyArgs }],
    ["follow_thesis", { themeId: 1, allocationUsdso: "200", ...policyArgs }],
    ["unfollow", { flatten: true }],
    ["revoke_operator", {}],
    ["withdraw_tank", {}],
    ["request_review", { trader: TRADER }],
    ["create_thesis", { name: "x", legs: [{ pool: POOL, weightBps: 5000 }] }],
  ] as const;

  it.each(writes)("%s refuses and touches nothing", async (name, args) => {
    const { deps, copybook } = fakeDeps({ agent: false });
    const { isError, body } = await call(deps, name, { ...args, dryRun: false });
    expect(isError).toBe(true);
    expect(body.reason).toMatch(/COPYBOOK_AGENT_KEY/);
    for (const m of ["approveOperator", "follow", "unfollow", "withdrawTank", "requestReview", "createTheme"] as const) {
      expect(copybook[m]).not.toHaveBeenCalled();
    }
    expect(copybook.preflightFollow).not.toHaveBeenCalled();
  });

  it("the server registers no write tools without a key, and all of them with one", async () => {
    const names = async (agent: boolean) => {
      const { deps } = fakeDeps({ agent });
      const server = createServer(deps);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const list = await client.listTools();
      await client.close();
      return list.tools.map((t) => t.name).sort();
    };
    const readOnly = await names(false);
    expect(readOnly).toEqual(["get_copy_history", "get_follow", "get_thesis", "get_trader_stats", "get_verdict", "list_theses", "list_top_traders"]);
    const all = await names(true);
    expect(all).toEqual(expect.arrayContaining(["follow_trader", "follow_thesis", "unfollow", "request_review", "create_thesis", ...readOnly]));
    expect(all).toContain("revoke_operator");
    expect(all).toContain("withdraw_tank");
    expect(all).toHaveLength(14);
  });
});

describe("follow_trader / follow_thesis", () => {
  it("dry-runs by default: returns preflight and calls, sends nothing", async () => {
    const { deps, copybook } = fakeDeps();
    const { isError, body } = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ dryRun: true, sent: false });
    expect(body.calls.map((c: { step: string }) => c.step)).toEqual(["approveOperator", "follow"]);
    expect(body.calls[0].args[1]).toEqual(["0x80054449"]);
    expect(body.calls[1]).toMatchObject({ valueStt: "0.5", calldata: "0xdeadbeef", policy: { scaleBps: 10000, maxNotionalUsdso: "50", bandBps: 50 } });
    expect(copybook.approveOperator).not.toHaveBeenCalled();
    expect(copybook.follow).not.toHaveBeenCalled();
    expect(copybook.preflightFollow).toHaveBeenCalledWith(expect.objectContaining({ account: AGENT, kind: "Trader", source: TRADER, tank: E18 / 2n }));
  });

  it("a whole-book trader follow checks the caps in the markets the trader holds now", async () => {
    const BTC = "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0";
    const refused: PreflightResult = {
      ok: false,
      reasons: [{ code: "CAP_BELOW_ONE_ORDER", severity: "error", field: "maxNotional", pool: BTC, required: 11n * E18, message: "The per-position cap is below the size of one order in this market." }],
      steps: okPre.steps,
    } as PreflightResult;
    const { deps, copybook, stats } = fakeDeps();
    stats.openPositionPools.mockResolvedValue([BTC]);
    // the preflight refuses exactly when it is told to check BTC, as the SDK does for a cap below one BTC order
    copybook.preflightFollow.mockImplementation((async (i: { checkPools?: string[] }) => (i.checkPools?.includes(BTC) ? refused : okPre)) as never);
    const r = await call(deps, "follow_trader", { trader: TRADER, maxNotionalUsdso: "5", tankStt: "0.5", dryRun: false });
    expect(stats.openPositionPools).toHaveBeenCalledWith(TRADER);
    expect(copybook.preflightFollow).toHaveBeenCalledWith(expect.objectContaining({ checkPools: [BTC] }));
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain("CAP_BELOW_ONE_ORDER");
    expect(copybook.follow).not.toHaveBeenCalled();
    expect(copybook.approveOperator).not.toHaveBeenCalled();
  });

  it("says so when the trader's open markets could not be read, and checks a market list as given", async () => {
    const { deps, copybook, stats } = fakeDeps();
    stats.openPositionPools.mockRejectedValue(new Error("indexer HTTP 502"));
    const dry = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs });
    expect(dry.body.notes[0]).toMatch(/could not be read/);
    expect(copybook.preflightFollow).toHaveBeenCalledWith(expect.not.objectContaining({ checkPools: expect.anything() }));
    stats.openPositionPools.mockClear();
    await call(deps, "follow_trader", { trader: TRADER, ...policyArgs, markets: [POOL] });
    expect(stats.openPositionPools).not.toHaveBeenCalled();
  });

  it("skips the approval call in the plan when it is already granted", async () => {
    const pre = { ...okPre, steps: [{ id: "approveOperator", done: true }, { id: "follow", done: false }] } as PreflightResult;
    const { deps } = fakeDeps({ pre });
    const { body } = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs });
    expect(body.calls.map((c: { step: string }) => c.step)).toEqual(["follow"]);
  });

  it("dryRun=false approves first, then follows, in order", async () => {
    const { deps, copybook } = fakeDeps();
    const order: string[] = [];
    copybook.approveOperator.mockImplementation(async () => { order.push("approve"); return tx("0xaaa"); });
    copybook.follow.mockImplementation(async () => { order.push("follow"); return tx("0xbbb", [{ name: "Followed" }]); });
    const { body } = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs, scaleBps: 5000, dryRun: false });
    expect(order).toEqual(["approve", "follow"]);
    expect(body).toMatchObject({ sent: true, followed: true });
    expect(copybook.follow).toHaveBeenCalledWith({
      target: { kind: "Trader", trader: TRADER, joinPools: undefined },
      policy: { scaleBps: 5000, allocation: 0n, maxNotional: 50n * E18, maxTotalNotional: 0n, bandBps: 50, equityFloor: 0n },
      tank: E18 / 2n,
    });
  });

  it("does not repeat an approval that is already on chain", async () => {
    const pre = { ...okPre, steps: [{ id: "approveOperator", done: true }, { id: "follow", done: false }] } as PreflightResult;
    const { deps, copybook } = fakeDeps({ pre });
    await call(deps, "follow_thesis", { themeId: "1", allocationUsdso: 200, ...policyArgs, dryRun: false });
    expect(copybook.approveOperator).not.toHaveBeenCalled();
    expect(copybook.follow).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "Theme", themeId: 1n }, policy: expect.objectContaining({ allocation: 200n * E18, scaleBps: 10000 }) }));
  });

  it("refuses with the preflight's reasons and sends nothing, even with dryRun=false", async () => {
    const pre: PreflightResult = {
      ok: false,
      reasons: [
        { code: "ALLOCATION_BELOW_MINIMUM", severity: "error", field: "allocation", pool: POOL, required: 120n * E18, message: "too small" },
        { code: "ALREADY_FOLLOWING", severity: "error", message: "one source per wallet" },
        { code: "OPERATOR_NOT_APPROVED", severity: "info", message: "needs approval" },
      ],
      steps: okPre.steps,
    };
    const { deps, copybook } = fakeDeps({ pre });
    const { isError, body } = await call(deps, "follow_thesis", { themeId: 1, allocationUsdso: "5", ...policyArgs, dryRun: false });
    expect(isError).toBe(true);
    expect(body.refused).toBe(true);
    expect(body.preflight.reasons).toEqual([
      { code: "ALLOCATION_BELOW_MINIMUM", severity: "error", field: "allocation", pool: POOL, leastValue: "120", unit: "USDso", message: "too small" },
      { code: "ALREADY_FOLLOWING", severity: "error", message: "one source per wallet" },
    ]);
    expect(copybook.approveOperator).not.toHaveBeenCalled();
    expect(copybook.follow).not.toHaveBeenCalled();
  });

  it("a failure after the approval names what was sent and how to resume", async () => {
    const { deps, copybook } = fakeDeps();
    copybook.follow.mockRejectedValue(new CopybookError("REVERTED", "The gas tank must be funded with at least 0.2 STT to follow.", { revert: "TankTooLow" } as never));
    const { isError, body } = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs, dryRun: false });
    expect(isError).toBe(true);
    expect(body.alreadySent).toEqual(["approveOperator 0xaaa"]);
    expect(body.resume).toMatch(/resumes/);
    expect(body.reason).toMatch(/gas tank/);
  });

  it("rejects malformed money before any chain call", async () => {
    const { deps, copybook } = fakeDeps();
    const r = await call(deps, "follow_trader", { trader: TRADER, maxNotionalUsdso: "1e3", tankStt: "0.5" });
    expect(r.isError).toBe(true);
    expect(r.body.reason).toMatch(/plain decimal/);
    expect(copybook.preflightFollow).not.toHaveBeenCalled();
  });
});

describe("unfollow", () => {
  const following = { follower: AGENT, kind: "Trader", trader: TRADER, policy: { scaleBps: 1, allocation: 0n, maxNotional: E18, maxTotalNotional: 0n, bandBps: 1, equityFloor: 0n }, paused: false };

  it("refuses when nothing is followed", async () => {
    const { deps, copybook } = fakeDeps();
    const r = await call(deps, "unfollow", { flatten: true, dryRun: false });
    expect(r.isError).toBe(true);
    expect(copybook.unfollow).not.toHaveBeenCalled();
  });

  it("requires an explicit flatten", async () => {
    const { deps } = fakeDeps({ copybook: { followOf: vi.fn(async () => following) } });
    expect((await call(deps, "unfollow", {})).isError).toBe(true);
  });

  it("dry-runs by default and sends with dryRun=false", async () => {
    const { deps, copybook } = fakeDeps({ copybook: { followOf: vi.fn(async () => following) } });
    const dry = await call(deps, "unfollow", { flatten: true });
    expect(dry.body).toMatchObject({ dryRun: true, sent: false, calls: [{ function: "unfollow", args: [true] }] });
    expect(copybook.unfollow).not.toHaveBeenCalled();
    const live = await call(deps, "unfollow", { flatten: false, dryRun: false });
    expect(copybook.unfollow).toHaveBeenCalledWith(false);
    expect(live.body.sent).toBe(true);
  });
});

describe("withdraw_tank", () => {
  const following = { follower: AGENT, kind: "Trader", trader: TRADER, policy: { scaleBps: 1, allocation: 0n, maxNotional: E18, maxTotalNotional: 0n, bandBps: 1, equityFloor: 0n }, paused: false };

  it("takes the whole tank once the wallet follows nothing, dry-run first", async () => {
    const { deps, copybook } = fakeDeps();
    const dry = await call(deps, "withdraw_tank", {});
    expect(dry.body).toMatchObject({ dryRun: true, sent: false, tankStt: "0.5", calls: [{ function: "withdrawTank", amountStt: "0.5" }] });
    expect(copybook.withdrawTank).not.toHaveBeenCalled();
    const live = await call(deps, "withdraw_tank", { dryRun: false });
    expect(copybook.withdrawTank).toHaveBeenCalledWith(E18 / 2n);
    expect(live.body).toMatchObject({ sent: true, withdrawnStt: "0.5", tankLeftStt: "0" });
  });

  it("keeps the floor while following and refuses more than can come out", async () => {
    const { deps, copybook } = fakeDeps({ copybook: { followOf: vi.fn(async () => following) } });
    const dry = await call(deps, "withdraw_tank", {});
    expect(dry.body.calls[0].amountStt).toBe("0.3");
    const over = await call(deps, "withdraw_tank", { amountStt: "0.31", dryRun: false });
    expect(over.isError).toBe(true);
    expect(over.body.reason).toMatch(/At most 0.3 STT/);
    expect(copybook.withdrawTank).not.toHaveBeenCalled();
  });

  it("refuses an empty tank", async () => {
    const { deps, copybook } = fakeDeps({ copybook: { tankOf: vi.fn(async () => 0n) } });
    const r = await call(deps, "withdraw_tank", { dryRun: false });
    expect(r.isError).toBe(true);
    expect(r.body.reason).toMatch(/empty/);
    expect(copybook.withdrawTank).not.toHaveBeenCalled();
  });
});

describe("request_review", () => {
  it("refuses while a review is pending", async () => {
    const { deps, copybook } = fakeDeps({ copybook: { reviewPendingOf: vi.fn(async () => ({ nonce: 1n, requestedAt: 1_700_000_000, replaceable: false })) } });
    const r = await call(deps, "request_review", { trader: TRADER, dryRun: false });
    expect(r.isError).toBe(true);
    expect(r.body.reason).toMatch(/already pending/);
    expect(copybook.requestReview).not.toHaveBeenCalled();
  });

  it("dry-runs with the fee, then pays exactly that fee", async () => {
    const { deps, copybook } = fakeDeps();
    const dry = await call(deps, "request_review", { trader: TRADER });
    expect(dry.body).toMatchObject({ dryRun: true, calls: [{ function: "requestReview", valueStt: "0.1" }] });
    expect(copybook.requestReview).not.toHaveBeenCalled();
    await call(deps, "request_review", { trader: TRADER, dryRun: false });
    expect(copybook.requestReview).toHaveBeenCalledWith(TRADER, E18 / 10n);
  });
});

describe("create_thesis", () => {
  const legs = [{ pool: POOL, weightBps: 5000 }, { pool: TRADER, weightBps: -3000 }];

  it("dry-runs by default", async () => {
    const { deps, copybook } = fakeDeps();
    const r = await call(deps, "create_thesis", { name: "Rotation", legs });
    expect(r.body).toMatchObject({ dryRun: true, sent: false, calls: [{ function: "createTheme" }] });
    expect(copybook.createTheme).not.toHaveBeenCalled();
  });

  it("sends with dryRun=false and returns the new id", async () => {
    const { deps, copybook } = fakeDeps();
    const r = await call(deps, "create_thesis", { name: "Rotation", legs, dryRun: false });
    expect(copybook.createTheme).toHaveBeenCalledWith("Rotation", "", legs);
    expect(r.body.themeId).toBe("7");
  });

  it("refuses legs the registry would refuse, listing each reason", async () => {
    const { deps, copybook } = fakeDeps();
    const r = await call(deps, "create_thesis", {
      name: "Bad",
      legs: [{ pool: POOL, weightBps: 100 }, { pool: POOL, weightBps: 20_000 }, { pool: TRADER, weightBps: -20_000 }],
      dryRun: false,
    });
    expect(r.isError).toBe(true);
    expect(r.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/listed twice/), expect.stringMatching(/under the 500 bps/), expect.stringMatching(/exceeds 30000/)]));
    expect(copybook.createTheme).not.toHaveBeenCalled();
  });

  it("refuses a leg that is not a readable market", async () => {
    const { deps } = fakeDeps({ copybook: { market: vi.fn(async () => { throw new Error("no code"); }) } });
    const r = await call(deps, "create_thesis", { name: "x", legs: [{ pool: POOL, weightBps: 5000 }] });
    expect(r.body.errors[0]).toMatch(/not a readable dreamDEX perp market/);
  });
});

describe("parseDecimal", () => {
  it.each([["-1"], ["abc"], ["0." + "1".repeat(19)], [""], ["1e3"], [-5]])("rejects %j", (v) => {
    expect(() => parseDecimal(v as string, "x")).toThrow(InputError);
  });
  it("accepts 0, 18 decimals and numbers", () => {
    expect(parseDecimal("0", "x")).toBe(0n);
    expect(parseDecimal("0." + "1".repeat(18), "x")).toBe(111111111111111111n);
    expect(parseDecimal(2.5, "x")).toBe((25n * E18) / 10n);
  });
});

describe("zero cap", () => {
  it("rejects maxNotionalUsdso 0 before any chain call", async () => {
    const { deps, copybook } = fakeDeps();
    const r = await call(deps, "follow_trader", { trader: TRADER, maxNotionalUsdso: "0", tankStt: "0.5" });
    expect(r.isError).toBe(true);
    expect(r.body.reason).toMatch(/above 0/);
    expect(copybook.preflightFollow).not.toHaveBeenCalled();
  });
});

describe("zero cap, thesis", () => {
  it("rejects maxNotionalUsdso 0 for follow_thesis before any chain call", async () => {
    const { deps, copybook } = fakeDeps();
    const r = await call(deps, "follow_thesis", { themeId: 1, allocationUsdso: "200", maxNotionalUsdso: "0", tankStt: "0.5" });
    expect(r.isError).toBe(true);
    expect(r.body.reason).toMatch(/above 0/);
    expect(copybook.preflightFollow).not.toHaveBeenCalled();
  });
});

describe("partial failures", () => {
  it("approve succeeds, follow rejects with a non-SDK error: alreadySent carries the approve hash and a resume hint", async () => {
    const { deps, copybook } = fakeDeps();
    copybook.follow.mockRejectedValue(new Error("socket hang up"));
    const { isError, body } = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs, dryRun: false });
    expect(isError).toBe(true);
    expect(body.alreadySent).toEqual(["approveOperator 0xaaa"]);
    expect(body.resume).toMatch(/Re-run the same call: steps already on chain are skipped/);
  });

  it("a timeout while waiting still reports the hash that was sent", async () => {
    const { deps, copybook } = fakeDeps();
    copybook.follow.mockResolvedValue({ hash: "0xbbb", wait: vi.fn(async () => { throw new Error("timed out"); }) });
    const { body } = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs, dryRun: false });
    expect(body.alreadySent).toEqual(["approveOperator 0xaaa", "follow 0xbbb"]);
  });

  it("single-tx writes report their hash when the wait fails", async () => {
    const { deps, copybook } = fakeDeps();
    copybook.createTheme.mockResolvedValue({ hash: "0xeee", wait: vi.fn(async () => { throw new Error("rpc down"); }) });
    const { body } = await call(deps, "create_thesis", { name: "x", legs: [{ pool: POOL, weightBps: 5000 }], dryRun: false });
    expect(body.alreadySent).toEqual(["createTheme 0xeee"]);
    expect(body.resume).toMatch(/Check alreadySent on the explorer before retrying/);
    expect(body.resume).toMatch(/second thesis/);
    expect(body.resume).not.toMatch(/skipped/);
  });
});

describe("approval scope disclosure and revoke_operator", () => {
  it("follow descriptions and the dry-run note say the grant is global, persists and cannot withdraw", async () => {
    const { deps } = fakeDeps();
    for (const name of ["follow_trader", "follow_thesis"]) {
      const d = find(buildTools(deps), name).description;
      expect(d).toMatch(/GLOBAL/);
      expect(d).toMatch(/PERSISTS after unfollow/);
      expect(d).toMatch(/place orders for this wallet's perps account/);
      expect(d).toMatch(/cannot cancel orders/);
      expect(d).toMatch(/cannot withdraw or move funds/);
    }
    const { body } = await call(deps, "follow_trader", { trader: TRADER, ...policyArgs });
    expect(body.note).toMatch(/GLOBAL/);
    expect(body.note).toMatch(/PERSISTS/);
  });

  it("dry-runs, then revokes with approveOperator(false)", async () => {
    const { deps, copybook } = fakeDeps();
    const dry = await call(deps, "revoke_operator", {});
    expect(dry.body).toMatchObject({ dryRun: true, calls: [{ function: "setOperatorApprovalGlobal", args: [HUB, ["0x80054449"], false] }] });
    expect(copybook.approveOperator).not.toHaveBeenCalled();
    await call(deps, "revoke_operator", { dryRun: false });
    expect(copybook.approveOperator).toHaveBeenCalledWith(false);
  });

  it("refuses while following, and when there is nothing to revoke", async () => {
    const f = fakeDeps({ copybook: { followOf: vi.fn(async () => ({ kind: "Trader" })) } });
    expect((await call(f.deps, "revoke_operator", { dryRun: false })).isError).toBe(true);
    expect(f.copybook.approveOperator).not.toHaveBeenCalled();
    const n = fakeDeps({ copybook: { isOperatorApproved: vi.fn(async () => false) } });
    expect((await call(n.deps, "revoke_operator", { dryRun: false })).body.reason).toMatch(/nothing to revoke/);
  });
});

describe("secrets never reach tool output, logs or the banner", () => {
  const KEY = "0x" + "ab".repeat(32);
  const URL_ = "https://rpc.example.com/v1?apikey=SECRET";

  it("an RPC error carrying the RPC URL and a 64-hex string is scrubbed (unexpected and sent-then-failed paths)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const leaky = Object.assign(new Error(`request to ${URL_} failed with ${KEY}`), { shortMessage: `HTTP request failed. URL: ${URL_} key ${KEY}` });
    const { deps, copybook } = fakeDeps({ copybook: { verdictOf: vi.fn(async () => { throw leaky; }) } });
    (deps as { secrets?: string[] }).secrets = [URL_];
    const a = await runTool(find(buildTools(deps), "get_verdict"), { trader: TRADER }, deps.secrets);
    copybook.follow.mockRejectedValue(leaky);
    const b = await runTool(find(buildTools(deps), "follow_trader"), { trader: TRADER, ...policyArgs, dryRun: false }, deps.secrets);
    const out = a.content[0]!.text + b.content[0]!.text + errSpy.mock.calls.flat().join("\n");
    for (const bad of ["SECRET", "apikey", "rpc.example.com", KEY, "ab".repeat(32)]) expect(out).not.toContain(bad);
    expect(a.isError).toBe(true);
    expect(JSON.parse(b.content[0]!.text).alreadySent).toEqual(["approveOperator 0xaaa"]);
    errSpy.mockRestore();
  });

  it("a plain unexpected error gives a generic message, not the raw one", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fakeDeps({ copybook: { verdictOf: vi.fn(async () => { throw new Error("internal detail xyzzy"); }) } });
    const { body } = await call(deps, "get_verdict", { trader: TRADER });
    expect(JSON.stringify(body)).not.toContain("xyzzy");
    expect(body.error).toMatch(/Unexpected error/);
    errSpy.mockRestore();
  });

  it("an invalid key config error does not echo the key; the banner shows only the address", () => {
    const bad = "0x" + "zz".repeat(32);
    let msg = "";
    try {
      depsFromEnv({ COPYBOOK_AGENT_KEY: bad });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not a 32-byte hex private key/);
    expect(msg).not.toContain("zz");
    expect(banner({ agent: AGENT })).toBe(`copybook-mcp ready: read + write tools (dry-run by default) for agent wallet ${AGENT}`);
    expect(banner({})).toMatch(/read tools only/);
    const real = depsFromEnv({ COPYBOOK_AGENT_KEY: KEY, COPYBOOK_RPC_URL: URL_ });
    expect(banner(real)).not.toContain("ab".repeat(32));
    expect(real.secrets).toEqual(expect.arrayContaining([URL_, KEY]));
  });
});

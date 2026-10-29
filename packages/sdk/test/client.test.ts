import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeErrorResult, keccak256, toHex, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCopybook } from "../src/client.ts";
import { hubAbi } from "../src/abi/hub.ts";
import { themesAbi } from "../src/abi/themes.ts";
import { gateAbi } from "../src/abi/gate.ts";
import { CopybookError, decodeRevert, revertAbi } from "../src/errors.ts";
import { MIN_TANK } from "../src/constants.ts";
import { sourceIdOf } from "../src/reads.ts";
import { BTC, E, ETH, ME, TRADER, followed, policy, world } from "./world.ts";
import { deployments } from "./fake.ts";

const make = (c: ReturnType<typeof world>, account = ME) => createCopybook({ publicClient: c.publicClient, walletClient: c.wallet(account), deployments });
const read = (c: ReturnType<typeof world>) => createCopybook({ publicClient: c.publicClient, deployments });

describe("reads", () => {
  it("computes the source id like the hub does", () => {
    const expected = keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [1, 7n]));
    expect(sourceIdOf("Theme", 7n)).toBe(expected);
    expect(sourceIdOf("Trader", TRADER)).toBe(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [0, BigInt(TRADER)])));
  });

  it("returns null for a wallet that follows nothing and a typed follow for one that does", async () => {
    const c = world();
    const cb = read(c);
    expect(await cb.followOf(ME)).toBeNull();
    c.on(deployments.hub, "followOf", followed(0, BigInt(TRADER), { scaleBps: 5_000 }, true));
    const f = (await cb.followOf(ME))!;
    expect(f).toMatchObject({ kind: "Trader", trader: TRADER, paused: true, group: 0 });
    expect(f.policy.scaleBps).toBe(5_000);
    c.on(deployments.hub, "followOf", followed(1, 1n));
    expect(await cb.followOf(ME)).toMatchObject({ kind: "Theme", themeId: 1n });
  });

  it("reads themes with their legs", async () => {
    const t = await read(world()).theme(1n);
    expect(t).toMatchObject({ id: 1n, name: "AI majors", version: 1 });
    expect(t.legs).toEqual([
      { pool: BTC, weightBps: 4_000 },
      { pool: ETH, weightBps: -2_000 },
    ]);
    expect(await read(world()).themes()).toHaveLength(1);
  });

  it("derives a verdict's expiry and whether it still blocks", async () => {
    const c = world();
    const now = Math.floor(Date.now() / 1000);
    c.on(deployments.gate, "verdictOf", { tier: 3, reviewedAt: BigInt(now - 3600), shannonRequestId: 1n, summaryHash: `0x${"00".repeat(32)}` });
    const v = await read(c).verdictOf(TRADER);
    expect(v).toMatchObject({ tier: "Block", blocking: true, blockExpiresAt: now - 3600 + 7 * 86_400 });
    c.on(deployments.gate, "verdictOf", { tier: 3, reviewedAt: BigInt(now - 8 * 86_400), shannonRequestId: 1n, summaryHash: `0x${"00".repeat(32)}` });
    expect((await read(c).verdictOf(TRADER)).blocking).toBe(false);
    c.on(deployments.gate, "verdictOf", { tier: 2, reviewedAt: BigInt(now), shannonRequestId: 1n, summaryHash: `0x${"00".repeat(32)}` });
    expect(await read(c).verdictOf(TRADER)).toMatchObject({ tier: "Caution", blocking: false });
  });

  it("reads a perp position with its entry price, and the account's equity", async () => {
    const c = world();
    c.on(deployments.marginBank, "getPosition", (args: readonly unknown[]) => ({
      size: args[1] === BTC ? -5n * 10n ** 14n : 0n,
      avgEntryPrice: args[1] === BTC ? 61_000n * E : 0n,
      entryFundingIndex: 0n,
      lastUpdatedTimestampNs: 0n,
    }));
    expect(await read(c).position(ME, BTC)).toEqual({ size: -5n * 10n ** 14n, avgEntryPrice: 61_000n * E });
    expect(await read(c).position(ME, ETH)).toEqual({ size: 0n, avgEntryPrice: 0n });
    expect(await read(c).accountEquity(ME)).toBe(1_000n * E);
  });

  it("reads gas params and review state", async () => {
    const c = world();
    c.on(deployments.hub, "gasParams", [8_000_000n, 20_000_000n, 90_000_000n, 1_200_000n, 30_000n, 300_000n, 2_000_000n]);
    expect((await read(c).gasParams()).riskGateGas).toBe(2_000_000n);
    expect(await read(c).reviewPendingOf(TRADER)).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    c.on(deployments.gate, "pendingOf", { nonce: 4n, requestedAt: BigInt(now - 3_600) });
    expect(await read(c).reviewPendingOf(TRADER)).toMatchObject({ nonce: 4n, replaceable: true });
  });

  it("reads a follower's seat: its group and its index in that group", async () => {
    const c = world();
    c.on(deployments.hub, "seatOf", [1, 6]);
    expect(await read(c).seatOf(ME)).toEqual({ group: 1, index: 6 });
  });
});

describe("status: every stuck state names the call that clears it", () => {
  const issue = async (c: ReturnType<typeof world>, code: string) => (await read(c).status(ME)).issues.find((i) => i.code === code);

  it("is empty for a healthy trader follow", async () => {
    const c = world();
    c.on(deployments.hub, "followOf", followed(0, BigInt(TRADER)));
    c.on(deployments.hub, "tankOf", 1n * E);
    expect((await read(c).status(ME)).issues).toEqual([]);
  });

  it("returns no issues and no follow for an idle wallet", async () => {
    const s = await read(world()).status(ME);
    expect(s.follow).toBeNull();
    expect(s.issues).toEqual([]);
  });

  it("stopped: resume, unless equity is still under the floor", async () => {
    const c = world();
    c.on(deployments.hub, "followOf", followed(0, BigInt(TRADER), { equityFloor: 500n * E }, true));
    c.on(deployments.hub, "tankOf", 1n * E);
    expect(await issue(c, "STOPPED")).toMatchObject({ action: { method: "resume" } });
    c.on(deployments.marginBank, "getAccountHealth", [100n * E, 0n, 0n, 0n]);
    const low = (await issue(c, "STOPPED"))!;
    expect(low.action).toBeUndefined();
    expect(low.message).toMatch(/margin/);
  });

  it("latched exits: catchUp; latched stop closes: poke", async () => {
    const c = world();
    c.on(deployments.hub, "followOf", followed(0, BigInt(TRADER)));
    c.on(deployments.hub, "tankOf", 1n * E);
    c.on(deployments.hub, "pendingOf", [true, false]);
    expect(await issue(c, "EXITS_PENDING")).toMatchObject({ action: { method: "catchUp", args: [ME, []] } });
    c.on(deployments.hub, "pendingOf", [false, true]);
    expect(await issue(c, "STOP_CLOSES_PENDING")).toMatchObject({ action: { method: "poke", args: [ME] } });
  });

  it("tank: fund it when empty or under the floor", async () => {
    const c = world();
    c.on(deployments.hub, "followOf", followed(0, BigInt(TRADER)));
    c.on(deployments.hub, "tankOf", 0n);
    expect(await issue(c, "TANK_EMPTY")).toMatchObject({ severity: "error", action: { method: "fundTank" } });
    c.on(deployments.hub, "tankOf", MIN_TANK - 1n);
    expect(await issue(c, "TANK_LOW")).toMatchObject({ severity: "warning", action: { method: "fundTank", args: [1n] } });
  });

  it("theme: behind a version, incomplete sync, and drift past 5%", async () => {
    const c = world();
    c.on(deployments.hub, "followOf", followed(1, 1n, { allocation: 200n * E }));
    c.on(deployments.hub, "tankOf", 1n * E);
    c.on(deployments.themes, "themeOf", [TRADER, "AI majors", "", 2]);
    c.on(deployments.hub, "themeSyncOf", [1, true]);
    expect(await issue(c, "THEME_BEHIND")).toMatchObject({ action: { method: "catchUp" } });
    c.on(deployments.themes, "themeOf", [TRADER, "AI majors", "", 1]);
    c.on(deployments.hub, "themeSyncOf", [1, false]);
    expect(await issue(c, "THEME_SYNC_INCOMPLETE")).toBeDefined();
    c.on(deployments.hub, "themeSyncOf", [1, true]);
    // targets: BTC +0.0013 (80 USD / 60k), ETH -0.01333.. (40 USD / 3k); hold BTC exactly, ETH 10% over
    c.on(deployments.marginBank, "getPosition", (args: readonly unknown[]) => {
      const size = args[1] === BTC ? 1_333_333_333_333_333n : args[1] === ETH ? -14_666_666_666_666_667n : 0n;
      return { size, avgEntryPrice: 0n, entryFundingIndex: 0n, lastUpdatedTimestampNs: 0n };
    });
    const s = await read(c).status(ME);
    const drift = s.issues.find((i) => i.code === "THEME_DRIFT");
    expect(drift).toMatchObject({ action: { method: "resync" } });
    expect(s.drift?.find((d) => d.pool === ETH)?.driftBps).toBeGreaterThanOrEqual(500);
    expect(s.drift?.find((d) => d.pool === BTC)?.driftBps).toBeLessThan(500);
  });
});

describe("writes", () => {
  it("sends follow with the encoded policy, the tank as value and gas headroom over the estimate", async () => {
    const c = world();
    const cb = make(c);
    const tx = await cb.follow({ target: { kind: "Trader", trader: TRADER, joinPools: [ETH] }, policy: policy(), tank: 1n * E });
    expect(tx.hash).toMatch(/^0x/);
    const sent = c.sent[0]!;
    expect(sent.to.toLowerCase()).toBe(deployments.hub.toLowerCase());
    expect(sent.value).toBe(toHex(1n * E));
    expect(BigInt(sent.gas!)).toBe((2_000_000n * 3n) / 2n);
    const d = decodeFunctionData({ abi: hubAbi, data: sent.data });
    expect(d.functionName).toBe("follow");
    expect(d.args![0]).toBe(0);
    expect(d.args![1]).toBe(BigInt(TRADER));
    expect(d.args![3]).toEqual([ETH]);
  });

  it("signs with a local key itself and sends the raw transaction, never asking the node to sign", async () => {
    const c = world();
    const key = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const cb = createCopybook({ publicClient: c.publicClient, walletClient: c.localWallet(key), deployments });
    await cb.follow({ target: { kind: "Theme", themeId: 1n }, policy: policy({ allocation: 200n * E }), tank: MIN_TANK });
    const sent = c.sent[0]!;
    expect(sent.raw).toBe(true);
    expect(sent.from).toBe(key.address);
    expect(sent.to.toLowerCase()).toBe(deployments.hub.toLowerCase());
    expect(BigInt(sent.value!)).toBe(MIN_TANK);
    expect(decodeFunctionData({ abi: hubAbi, data: sent.data }).functionName).toBe("follow");
    expect(c.rpc.some((r) => r.method === "eth_sendTransaction")).toBe(false);
  });

  it("sends a theme follow with kind 1, the theme id and no markets", async () => {
    const c = world();
    await make(c).follow({ target: { kind: "Theme", themeId: 1n }, policy: policy({ allocation: 200n * E }), tank: MIN_TANK });
    const d = decodeFunctionData({ abi: hubAbi, data: c.sent[0]!.data });
    expect(d.args![0]).toBe(1);
    expect(d.args![1]).toBe(1n);
    expect(d.args![3]).toEqual([]);
  });

  it("approveOperator grants the hub the global placeOrderFor selector on the venue registry", async () => {
    const c = world();
    await make(c).approveOperator();
    const sent = c.sent[0]!;
    expect(sent.to.toLowerCase()).toBe(deployments.operatorRegistry.toLowerCase());
    expect(sent.data.startsWith("0x")).toBe(true);
    expect(sent.data.toLowerCase()).toContain(deployments.hub.slice(2).toLowerCase());
    expect(sent.data.toLowerCase()).toContain("80054449");
  });

  it("encodes the rest of the write surface", async () => {
    const c = world();
    const cb = make(c);
    await cb.unfollow(true);
    await cb.updatePolicy(policy({ bandBps: 100 }));
    await cb.fundTank(5n);
    await cb.withdrawTank(3n);
    await cb.catchUp(TRADER, [ETH]);
    await cb.poke(TRADER);
    await cb.resume();
    await cb.resync();
    await cb.setGuard(false);
    await cb.requestReview(TRADER);
    await cb.createTheme("AI majors", "ipfs://x", [{ pool: BTC, weightBps: 4_000 }]);
    await cb.rebalance(1n, [{ pool: BTC, weightBps: 5_000 }]);
    const names = c.sent.map((s) => {
      const abi = ([deployments.hub, deployments.themes, deployments.gate].find((a) => a.toLowerCase() === s.to.toLowerCase()) === deployments.hub
        ? hubAbi
        : s.to.toLowerCase() === deployments.themes.toLowerCase()
          ? themesAbi
          : gateAbi) as Abi;
      return decodeFunctionData({ abi, data: s.data }).functionName;
    });
    expect(names).toEqual(["unfollow", "updatePolicy", "fundTank", "withdrawTank", "catchUp", "poke", "resume", "resync", "setGuard", "requestReview", "createTheme", "rebalance"]);
    expect(c.sent[2]!.value).toBe(toHex(5n));
    // requestReview pays the gate's current fee unless told otherwise
    expect(c.sent[9]!.value).toBe(toHex(E / 2n));
  });

  it("refuses to send from a wallet on another chain, before anything is signed", async () => {
    const c = world();
    c.chainId = 1;
    const e = await make(c).resume().catch((x) => x);
    expect(e).toBeInstanceOf(CopybookError);
    expect(e.code).toBe("WRONG_CHAIN");
    expect(c.sent).toHaveLength(0);
  });

  it("refuses writes without a wallet", async () => {
    const e = await read(world()).resume().catch((x) => x);
    expect(e).toMatchObject({ code: "NO_WALLET" });
  });

  it("turns a reverting estimate into the contract's reason, before the user signs", async () => {
    const c = world();
    c.revertEstimateWith = encodeErrorResult({ abi: revertAbi, errorName: "TankTooLow" });
    const e = await make(c).follow({ target: { kind: "Trader", trader: TRADER }, policy: policy(), tank: 1n }).catch((x) => x);
    expect(e).toBeInstanceOf(CopybookError);
    expect(e).toMatchObject({ code: "REVERTED", revert: "TankTooLow" });
    expect(e.message).toMatch(/0\.2 STT/);
    expect(c.sent).toHaveLength(0);
  });

  it("waits for the receipt and decodes this transaction's events", async () => {
    const c = world();
    const log = {
      address: deployments.hub,
      topics: encodeEventTopics({ abi: hubAbi, eventName: "Resumed", args: { follower: ME } }),
      data: "0x" as Hex,
      blockNumber: toHex(1000),
      transactionHash: `0x${"ab".repeat(32)}`,
      transactionIndex: "0x0",
      blockHash: `0x${"cd".repeat(32)}`,
      logIndex: "0x0",
      removed: false,
    };
    c.receiptLogs = [log];
    const tx = await make(c).resume();
    const out = await tx.wait();
    expect(out.events).toMatchObject([{ name: "Resumed", follower: ME }]);
  });

  it("throws a CopybookError when the transaction reverts on chain", async () => {
    const c = world();
    c.receiptStatus = "0x0";
    const tx = await make(c).resume();
    await expect(tx.wait()).rejects.toMatchObject({ code: "TX_FAILED" });
  });
});

describe("revert decoding", () => {
  it("reads revert data several causes deep and maps InvalidPolicy to its field", () => {
    const data = encodeErrorResult({ abi: revertAbi, errorName: "InvalidPolicy", args: [4] });
    const wrapped = new Error("outer", { cause: new Error("mid", { cause: Object.assign(new Error("rpc"), { data }) }) });
    expect(decodeRevert(wrapped)).toMatchObject({ name: "InvalidPolicy" });
    expect(decodeRevert(wrapped)!.message).toContain("bandBps");
    expect(decodeRevert(new Error("plain"))).toBeUndefined();
    // viem may already have decoded the error and dropped the hex
    const named = new Error("outer", { cause: Object.assign(new Error("reverted"), { data: { errorName: "TankTooLow", args: [] } }) });
    expect(decodeRevert(named)).toMatchObject({ name: "TankTooLow" });
  });
});

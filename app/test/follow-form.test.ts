import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { CopybookError } from "@copybook/sdk";
import { defaultPolicyForm, errorFor, parseAmount18, parseFixed, parsePolicyForm, type PolicyFormValues } from "@/lib/follow/policyForm";
import { IDLE, PENDING_MAX_AGE_S, forgetTx, recallTx, rememberTx, runTx, txErrorText, txFor, type TxPhase } from "@/lib/follow/tx";

const E = 10n ** 18n;
const BTC = "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0" as Address;
const form = (over: Partial<PolicyFormValues> = {}): PolicyFormValues => ({ ...defaultPolicyForm("Trader"), ...over });

describe("policy form", () => {
  it("parses a trader policy into the hub's units", () => {
    const r = parsePolicyForm("Trader", form({ scale: "0.5", maxNotional: "$1,250.5", maxTotalNotional: "", band: "0.25", equityFloor: "20" }));
    expect(r.errors).toEqual([]);
    expect(r.policy).toEqual({ scaleBps: 5_000, allocation: 0n, maxNotional: 1_250_500_000_000_000_000_000n, maxTotalNotional: 0n, bandBps: 25, equityFloor: 20n * E });
    expect(r.joinPools).toEqual([]);
  });

  it("parses a thesis policy and ignores the scale", () => {
    const r = parsePolicyForm("Theme", form({ scale: "nonsense", allocation: "80", maxNotional: "100" }));
    expect(r.errors).toEqual([]);
    expect(r.policy).toMatchObject({ scaleBps: 0, allocation: 80n * E, maxNotional: 100n * E, bandBps: 50 });
  });

  it("rejects what PolicyLib.validate rejects, field by field", () => {
    const r = parsePolicyForm("Trader", form({ scale: "0", maxNotional: "0", band: "6" }));
    expect(r.policy).toBeUndefined();
    expect(r.errors.map((e) => e.field)).toEqual(["scale", "maxNotional", "band"]);
    expect(errorFor(parsePolicyForm("Trader", form({ scale: "10.5" })).errors, "scale")).toMatch(/10x/);
    expect(errorFor(parsePolicyForm("Trader", form({ band: "0.001" })).errors, "band")).toMatch(/two decimals/);
    expect(errorFor(parsePolicyForm("Theme", form({ allocation: "0" })).errors, "allocation")).toMatch(/above zero/);
    expect(errorFor(parsePolicyForm("Theme", form({ allocation: "" })).errors, "allocation")).toMatch(/dollars/);
  });

  it("takes the band and the multiplier at the edges of their ranges", () => {
    expect(parsePolicyForm("Trader", form({ scale: "10", band: "5" })).policy).toMatchObject({ scaleBps: 100_000, bandBps: 500 });
    expect(parsePolicyForm("Trader", form({ scale: "0.0001", band: "0.01" })).policy).toMatchObject({ scaleBps: 1, bandBps: 1 });
  });

  it("never sends an empty market list by accident: the hub would read it as every market", () => {
    const r = parsePolicyForm("Trader", form({ allowAll: false, pools: [] }));
    expect(errorFor(r.errors, "markets")).toMatch(/at least one market/);
    const ok = parsePolicyForm("Trader", form({ allowAll: false, pools: [BTC, BTC.toLowerCase() as Address] }));
    expect(ok.joinPools).toEqual([BTC]);
    expect(parsePolicyForm("Trader", form({ allowAll: true, pools: [BTC] })).joinPools).toEqual([]);
  });

  it("starts a thesis at its minimum with headroom, and a cap that does not clamp the heaviest leg", () => {
    // recommended 87.12 → 88; heaviest leg 70% → 61.6 → 62
    const v = defaultPolicyForm("Theme", { recommendedAllocation: 87_120_000_000_000_000_000n, maxWeightBps: 7_000, minMaxNotional: 11n * E });
    expect(v).toMatchObject({ allocation: "88", maxNotional: "62", band: "0.5" });
    // a leg minimum above the heaviest leg wins
    expect(defaultPolicyForm("Theme", { recommendedAllocation: 10n * E, maxWeightBps: 1_000, minMaxNotional: 12_300_000_000_000_000_000n }).maxNotional).toBe("13");
    expect(defaultPolicyForm("Theme", { maxWeightBps: 7_000 }).allocation).toBe("");
  });

  it("parses decimals strictly", () => {
    expect(parseFixed("1.", 4)).toBe(10_000n);
    expect(parseFixed(".5", 4)).toBe(5_000n);
    expect(parseFixed("1.23456", 4)).toBeNull();
    expect(parseFixed("-1", 4)).toBeNull();
    expect(parseFixed("1e3", 4)).toBeNull();
    expect(parseAmount18("0.2")).toBe(2n * 10n ** 17n);
    expect(parseAmount18("abc")).toBeNull();
  });
});

const HASH = `0x${"ab".repeat(32)}` as Hex;

describe("transactions", () => {
  const run = async (send: () => Promise<{ hash: Hex; wait(): Promise<{ receipt: { blockNumber: bigint } }> }>) => {
    const phases: TxPhase["phase"][] = [];
    const sent: Hex[] = [];
    const last = await runTx("approve", send, (p) => phases.push(p.phase), (h) => sent.push(h));
    return { phases, last, sent };
  };

  it("reports signing, pending with the hash, then the block", async () => {
    const { phases, last, sent } = await run(async () => ({ hash: HASH, wait: async () => ({ receipt: { blockNumber: 35_900_000n } }) }));
    expect(phases).toEqual(["signing", "pending", "confirmed"]);
    expect(last).toEqual({ phase: "confirmed", action: "approve", hash: HASH, block: 35_900_000n });
    expect(sent).toEqual([HASH]);
  });

  it("a decline in the wallet is `rejected`, with nothing sent", async () => {
    const { last, sent } = await run(async () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    expect(last).toEqual({ phase: "rejected", action: "approve" });
    expect(sent).toEqual([]);
  });

  it("a revert caught by the gas estimate says nothing was sent", async () => {
    const { last } = await run(async () => {
      throw new CopybookError("REVERTED", "This wallet already follows a source. Unfollow first, or use a dedicated wallet per source.", { revert: "AlreadyFollowing" });
    });
    expect(last.phase).toBe("failed");
    expect("hash" in last).toBe(false);
    expect((last as { message: string }).message).toMatch(/already follows.*nothing was sent/);
  });

  it("a revert on chain keeps the hash", async () => {
    const { last } = await run(async () => ({
      hash: HASH,
      wait: async () => {
        throw new CopybookError("TX_FAILED", `Transaction ${HASH} reverted on chain.`);
      },
    }));
    expect(last).toMatchObject({ phase: "failed", hash: HASH });
    expect(txErrorText(new CopybookError("WRONG_CHAIN", "The wallet is on chain 1"))).toBe("The wallet is on chain 1");
  });

  it("remembers a sent transaction per wallet across a reload, and drops it when stale or malformed", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const ME = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932";
    rememberTx(store, { address: ME, action: "follow", hash: HASH, at: 1_000 });
    expect(recallTx(store, ME.toLowerCase(), 1_060)).toMatchObject({ action: "follow", hash: HASH });
    expect(recallTx(store, "0x00000000000000000000000000000000000000aa", 1_060)).toBeUndefined();
    expect(recallTx(store, ME, 1_000 + PENDING_MAX_AGE_S + 1)).toBeUndefined();
    expect(m.size).toBe(0);
    m.set(`copybook:pending:${ME.toLowerCase()}`, "{not json");
    expect(recallTx(store, ME, 1_000)).toBeUndefined();
    rememberTx(store, { address: ME, action: "follow", hash: HASH, at: 1_000 });
    forgetTx(store, ME);
    expect(recallTx(store, ME, 1_000)).toBeUndefined();
    expect(recallTx(undefined, ME, 1_000)).toBeUndefined();
  });
});

describe("editing a policy on chain", () => {
  it("round-trips through the form", async () => {
    const { policyToForm } = await import("@/lib/follow/policyForm");
    const trader = { scaleBps: 12_500, allocation: 0n, maxNotional: 1_250_500_000_000_000_000_000n, maxTotalNotional: 0n, bandBps: 25, equityFloor: 20n * E };
    const v = policyToForm("Trader", trader);
    expect(v).toMatchObject({ scale: "1.25", maxNotional: "1250.5", maxTotalNotional: "", band: "0.25", equityFloor: "20" });
    expect(parsePolicyForm("Trader", v).policy).toEqual(trader);
    const theme = { scaleBps: 0, allocation: 80n * E, maxNotional: 100n * E, maxTotalNotional: 300n * E, bandBps: 50, equityFloor: 0n };
    expect(parsePolicyForm("Theme", policyToForm("Theme", theme)).policy).toEqual(theme);
  });
});

describe("which transaction a control shows", () => {
  const pending: TxPhase = { phase: "pending", action: "follow", hash: HASH };
  it("a live transaction belongs to its own action only", () => {
    expect(txFor({ tx: pending, recalled: false }, ["follow"])).toBe(pending);
    expect(txFor({ tx: pending, recalled: false }, ["approve"])).toBe(IDLE);
    expect(txFor({ tx: IDLE, recalled: false }, ["follow"])).toBe(IDLE);
  });
  it("one recalled after a reload shows only where the page asks for it, whatever its action", () => {
    expect(txFor({ tx: pending, recalled: true }, ["follow"])).toBe(IDLE);
    expect(txFor({ tx: pending, recalled: true }, ["review"], true)).toBe(pending);
  });
});

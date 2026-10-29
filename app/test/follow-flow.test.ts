import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { sourceIdOf } from "@copybook/sdk";
import { NO_CHOICES, deriveFlow, reviewNeed, type ChainReads, type FlowInput, type LocalChoices, type ReadsState, type WalletView } from "@/lib/follow/flow";

const RISK = { verdictTtlSeconds: 604800, blockHoldSeconds: 86400, reviewCooldownSeconds: 600, pendingTimeoutSeconds: 1800 };
const NOW = 1_800_000_000;
const ME = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932" as Address;
const OTHER = "0x00000000000000000000000000000000000000aa" as Address;
const LEADER = "0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d" as Address;
const SID = sourceIdOf("Trader", LEADER);
const THESIS = sourceIdOf("Theme", 1n);
const E = 10n ** 18n;
const NONE = { tier: "None" as const, reviewedAt: 0, shannonRequestId: 0n, summaryHash: `0x${"00".repeat(32)}` as Hex };

const wallet = (over: Partial<WalletView> = {}): WalletView => ({ installed: true, status: "connected", address: ME, chainId: 50383, ...over });
const chain = (over: Partial<ChainReads> = {}): ChainReads => ({
  address: ME,
  approved: false,
  follow: null,
  equity: 30n * E,
  balance: 3n * E,
  guardOn: true,
  tank: 0n,
  verdict: NONE,
  reviewPending: null,
  ...over,
});
const ready = (over: Partial<ChainReads> = {}): ReadsState => ({ status: "ready", data: chain(over) });

const flow = (over: Partial<Omit<FlowInput, "local">> & { local?: Partial<LocalChoices> } = {}) =>
  deriveFlow({
    kind: "Trader",
    sourceId: SID,
    expectedChainId: 50383,
    wallet: wallet(),
    reads: ready(),
    now: NOW,
    risk: RISK,
    ...over,
    local: { ...NO_CHOICES, ...over.local },
  });

const states = (v: ReturnType<typeof flow>) => Object.fromEntries(v.steps.map((s) => [s.id, s.state]));

describe("follow flow: wallet and network", () => {
  it("starts at connect, and says when the browser has no wallet at all", () => {
    expect(flow({ wallet: { installed: true, status: "disconnected" } }).step).toBe("connect");
    expect(flow({ wallet: { installed: true, status: "disconnected" } }).blocker).toBeUndefined();
    expect(flow({ wallet: { installed: false, status: "disconnected" } })).toMatchObject({ step: "connect", blocker: "no-wallet" });
    expect(flow({ wallet: { installed: true, status: "connecting" } }).step).toBe("connect");
  });

  it("asks to switch on the wrong chain, whatever the chain reads say", () => {
    const v = flow({ wallet: wallet({ chainId: 1 }), reads: ready({ approved: true }) });
    expect(v.step).toBe("network");
    expect(states(v)).toMatchObject({ connect: "done", network: "current", approve: "todo" });
  });

  it("treats a wallet reconnecting from the cookie as connected", () => {
    expect(flow({ wallet: wallet({ status: "reconnecting" }) }).step).toBe("approve");
    expect(flow({ wallet: { installed: true, status: "reconnecting" } }).step).toBe("connect");
  });

  it("waits for the chain reads, and reports a failed read for this wallet", () => {
    expect(flow({ reads: { status: "loading", address: ME } })).toMatchObject({ step: "source", blocker: "reading" });
    expect(flow({ reads: { status: "error", address: ME, error: "timeout" } })).toMatchObject({ step: "source", blocker: "read-failed" });
  });

  it("never decides a step from another account's reads (account switched mid-flow)", () => {
    // reads finished for the old account, the wallet now shows another one
    const switched = flow({ wallet: wallet({ address: OTHER }), reads: ready({ approved: true, follow: { sourceId: SID, kind: "Trader", ref: BigInt(LEADER) } }) });
    expect(switched).toMatchObject({ step: "source", blocker: "reading", followingThis: false });
    // an error for the old account is not this account's error
    expect(flow({ wallet: wallet({ address: OTHER }), reads: { status: "error", address: ME, error: "x" } }).blocker).toBe("reading");
    // once the new account's reads land, its own state decides
    expect(flow({ wallet: wallet({ address: OTHER }), reads: { status: "ready", data: chain({ address: OTHER, approved: true }) } }).step).toBe("policy");
  });
});

describe("follow flow: what the chain already holds", () => {
  it("one source per wallet: a wallet following something else stops at the source step", () => {
    const v = flow({ reads: ready({ approved: true, follow: { sourceId: THESIS, kind: "Theme", ref: 1n } }) });
    expect(v).toMatchObject({ step: "source", blocker: "following-other", followingThis: false });
  });

  it("stops at margin when the perps account is empty, and when it cannot be read; both can be waived", () => {
    expect(flow({ reads: ready({ equity: 0n }) })).toMatchObject({ step: "margin", blocker: "no-margin" });
    expect(flow({ reads: ready({ equity: -5n }) })).toMatchObject({ step: "margin", blocker: "no-margin" });
    expect(flow({ reads: ready({ equity: null }) })).toMatchObject({ step: "margin", blocker: "margin-unreadable" });
    expect(flow({ reads: ready({ equity: 0n }), local: { marginWaived: true } }).step).toBe("approve");
  });

  it("asks for the operator approval before the policy, and skips it once the chain has it", () => {
    expect(flow().step).toBe("approve");
    expect(flow({ reads: ready({ approved: true }) }).step).toBe("policy");
  });

  it("walks policy, tank and follow from the person's choices", () => {
    const r = ready({ approved: true });
    expect(flow({ reads: r }).step).toBe("policy");
    expect(flow({ reads: r, local: { policyDone: true } }).step).toBe("tank");
    const v = flow({ reads: r, local: { policyDone: true, tankDone: true } });
    expect(v.step).toBe("follow");
    expect(states(v)).toMatchObject({ connect: "done", network: "done", source: "done", margin: "done", approve: "done", policy: "done", tank: "done", follow: "current", review: "todo", done: "todo" });
    expect(v.steps.some((s) => s.id === "guard")).toBe(false);
  });

  it("adds a guard step only when the person changes the guard, and passes it once the gate agrees", () => {
    const off = flow({ reads: ready({ approved: true, guardOn: true }), local: { policyDone: true, guardWanted: false } });
    expect(off.step).toBe("guard");
    const landed = flow({ reads: ready({ approved: true, guardOn: false }), local: { policyDone: true, guardWanted: false } });
    expect(landed.step).toBe("tank");
    expect(states(landed).guard).toBe("done");
    // theses are never gated: no guard step
    expect(flow({ kind: "Theme", sourceId: THESIS, reads: ready({ approved: true }), local: { policyDone: true, guardWanted: false } }).step).toBe("tank");
  });

  it("theses have no review step", () => {
    const v = flow({ kind: "Theme", sourceId: THESIS, reads: ready({ approved: true }) });
    expect(v.steps.map((s) => s.id)).not.toContain("review");
  });
});

describe("follow flow: after the follow lands", () => {
  const following = { approved: true, follow: { sourceId: SID, kind: "Trader" as const, ref: BigInt(LEADER) }, tank: E };

  it("a trader with no verdict asks for a review; skipping it finishes the flow and marks the step skipped", () => {
    const v = flow({ reads: ready(following) });
    expect(v).toMatchObject({ step: "review", followingThis: true, review: "needed" });
    const skipped = flow({ reads: ready(following), local: { reviewSkipped: true } });
    expect(skipped.step).toBe("done");
    expect(states(skipped).review).toBe("skipped");
  });

  it("skips the review silently when a verdict is fresh, a review is pending, or the trader was just reviewed", () => {
    const fresh = flow({ reads: ready({ ...following, verdict: { ...NONE, tier: "Ok", reviewedAt: NOW - 86_400 } }) });
    expect(fresh).toMatchObject({ step: "done", review: "fresh" });
    expect(states(fresh).review).toBe("skipped");
    const held = flow({ reads: ready({ ...following, verdict: { ...NONE, tier: "Block", reviewedAt: NOW - 3_600 } }) });
    expect(held).toMatchObject({ step: "done", review: "fresh" });
    const pending = flow({ reads: ready({ ...following, reviewPending: { nonce: 3n, requestedAt: NOW - 60 } }) });
    expect(pending).toMatchObject({ step: "done", review: "pending" });
    expect(states(pending).review).toBe("done");
  });

  it("a stale verdict needs a review again", () => {
    const stale = flow({ reads: ready({ ...following, verdict: { ...NONE, tier: "Ok", reviewedAt: NOW - 8 * 86_400 } }) });
    expect(stale).toMatchObject({ step: "review", review: "needed" });
  });

  it("a thesis follow is done as soon as the chain shows it", () => {
    const v = flow({ kind: "Theme", sourceId: THESIS, reads: ready({ approved: true, follow: { sourceId: THESIS, kind: "Theme", ref: 1n } }) });
    expect(v).toMatchObject({ step: "done", followingThis: true });
  });
});

describe("follow flow: reloads, rejections and reverts", () => {
  // A transaction that was declined or reverted changes nothing on chain, so the step it belongs to stays
  // current. A reload clears the page's choices; the chain reads alone put the flow back on the right step.
  it("approval sent, follow not: a reload resumes at the policy, never at the approval", () => {
    expect(flow({ reads: ready({ approved: true }), local: NO_CHOICES }).step).toBe("policy");
  });

  it("approval declined or reverted: the chain still says not approved, so the approval stays current", () => {
    expect(flow({ reads: ready({ approved: false }), local: NO_CHOICES }).step).toBe("approve");
  });

  it("follow declined or reverted: policy and tank stay confirmed and the follow step stays current", () => {
    expect(flow({ reads: ready({ approved: true }), local: { policyDone: true, tankDone: true } }).step).toBe("follow");
  });

  it("guard turned off, then a reload: the toggle starts from the gate, so there is no guard step left", () => {
    expect(flow({ reads: ready({ approved: true, guardOn: false }), local: { policyDone: true } }).steps.some((s) => s.id === "guard")).toBe(false);
  });

  it("follow landed, then a reload before the review: the review step comes back from the chain", () => {
    expect(flow({ reads: ready({ approved: true, follow: { sourceId: SID, kind: "Trader", ref: BigInt(LEADER) } }), local: NO_CHOICES }).step).toBe("review");
  });

  it("review requested, then a reload: the gate's pending review finishes the flow", () => {
    const v = flow({ reads: ready({ approved: true, follow: { sourceId: SID, kind: "Trader", ref: BigInt(LEADER) }, reviewPending: { nonce: 9n, requestedAt: NOW - 30 } }) });
    expect(v.step).toBe("done");
  });

  it("an empty account that was waived comes back to the margin step after a reload", () => {
    expect(flow({ reads: ready({ equity: 0n }), local: NO_CHOICES }).step).toBe("margin");
  });
});

describe("reviewNeed", () => {
  it("follows the gate's own order: pending, cooldown, fresh, needed", () => {
    expect(reviewNeed(undefined, null, NOW, RISK)).toBe("needed");
    expect(reviewNeed({ ...NONE, tier: "Ok", reviewedAt: NOW - 60 }, null, NOW, RISK)).toBe("cooldown");
    expect(reviewNeed({ ...NONE, tier: "Caution", reviewedAt: NOW - 3_600 }, null, NOW, RISK)).toBe("fresh");
    expect(reviewNeed({ ...NONE, tier: "Caution", reviewedAt: NOW - 3_600 }, { nonce: 1n, requestedAt: NOW - 10 }, NOW, RISK)).toBe("pending");
    // a pending review past its timeout can be replaced
    expect(reviewNeed(undefined, { nonce: 1n, requestedAt: NOW - 3_600 }, NOW, RISK)).toBe("needed");
  });
});

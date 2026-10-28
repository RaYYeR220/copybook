import { describe, expect, it } from "vitest";
import { CopybookError } from "@copybook/sdk";
import { askErrorText, askState, verdictView } from "@/lib/verdict";

const RISK = { verdictTtlSeconds: 604800, blockHoldSeconds: 86400, reviewCooldownSeconds: 600, pendingTimeoutSeconds: 1800 };
const AT = 1793194591; // the demo leader's BLOCK: 28 Oct 2026, 13:36:31 UTC
const block = { tier: "Block" as const, reviewedAt: AT, shannonRequestId: 18072906n, summaryHash: `0x${"69".repeat(32)}` as `0x${string}` };

describe("verdict view", () => {
  it("a fresh BLOCK is blocking and held: no milder verdict can replace it for 24 h", () => {
    const v = verdictView(block, AT + 3600, RISK);
    expect(v).toMatchObject({ tier: "Block", reviewed: true, blocking: true, held: true, heldUntil: AT + 86400, expiresAt: AT + 604800, expired: false });
  });

  it("the demo leader's BLOCK: held until 29 Oct 13:36:31 UTC, expiring 4 Nov unless re-reviewed", () => {
    const v = verdictView(block, Date.UTC(2026, 9, 28, 23, 0) / 1000, RISK);
    expect(v.heldUntil).toBe(Date.UTC(2026, 9, 29, 13, 36, 31) / 1000);
    expect(v.expiresAt).toBe(Date.UTC(2026, 10, 4, 13, 36, 31) / 1000);
    expect(v.held).toBe(true);
  });

  it("after the hold, a BLOCK still blocks until its TTL, and a review can replace it", () => {
    const v = verdictView(block, AT + 86400 + 1, RISK);
    expect(v).toMatchObject({ blocking: true, held: false });
  });

  it("an expired BLOCK no longer blocks", () => {
    const v = verdictView(block, AT + 604800 + 1, RISK);
    expect(v).toMatchObject({ blocking: false, expired: true, held: false });
  });

  it("OK and CAUTION never block and have no hold", () => {
    for (const tier of ["Ok", "Caution"] as const) {
      const v = verdictView({ ...block, tier }, AT + 10, RISK);
      expect(v).toMatchObject({ tier, blocking: false, held: false });
      expect(v.heldUntil).toBeUndefined();
    }
  });

  it("a trader never reviewed reads as not reviewed", () => {
    const v = verdictView({ tier: "None", reviewedAt: 0, shannonRequestId: 0n, summaryHash: `0x${"0".repeat(64)}` }, AT, RISK);
    expect(v).toMatchObject({ tier: "None", reviewed: false, blocking: false });
    expect(v.expiresAt).toBeUndefined();
  });
});

describe("ask the validators: pre-checks in the gate's own order", () => {
  it("a pending review blocks a new one until it can be replaced", () => {
    const s = askState(verdictView(block, AT + 4000, RISK), { nonce: 44n, requestedAt: AT + 3600 }, AT + 4000, RISK);
    expect(s).toEqual({ kind: "pending", nonce: 44n, requestedAt: AT + 3600, replaceableAt: AT + 3600 + 1800 });
  });

  it("an unanswered review past its timeout can be replaced", () => {
    const s = askState(verdictView(block, AT + 90000, RISK), { nonce: 44n, requestedAt: AT + 3600 }, AT + 90000, RISK);
    expect(s).toMatchObject({ kind: "ready", replaces: 44n });
  });

  it("cooldown for ten minutes after a stored verdict", () => {
    const s = askState(verdictView({ ...block, tier: "Ok" }, AT + 60, RISK), null, AT + 60, RISK);
    expect(s).toEqual({ kind: "cooldown", readyAt: AT + 600 });
  });

  it("during a BLOCK hold a review can be asked, but it says it cannot lift the BLOCK before the hold ends", () => {
    const s = askState(verdictView(block, AT + 3600, RISK), null, AT + 3600, RISK);
    expect(s).toEqual({ kind: "ready", holdUntil: AT + 86400 });
  });

  it("ready, plainly, when nothing stands in the way", () => {
    expect(askState(verdictView(block, AT + 90000, RISK), null, AT + 90000, RISK)).toEqual({ kind: "ready" });
    const never = verdictView({ tier: "None", reviewedAt: 0, shannonRequestId: 0n, summaryHash: `0x${"0".repeat(64)}` }, AT, RISK);
    expect(askState(never, null, AT, RISK)).toEqual({ kind: "ready" });
  });
});

describe("ask errors", () => {
  it("explains the gate's Pending and Cooldown reverts with their times", () => {
    const pending = new CopybookError("REVERTED", "x", { revert: "Pending", revertArgs: [44n, BigInt(AT + 1800)] });
    expect(askErrorText(pending)).toBe("A review of this trader is already pending (request #44). It can be replaced after 28 Oct 2026, 14:06:31 UTC.");
    const cooldown = new CopybookError("REVERTED", "x", { revert: "Cooldown", revertArgs: [BigInt(AT + 600)] });
    expect(askErrorText(cooldown)).toBe("This trader was reviewed a moment ago. A new review can be asked after 28 Oct 2026, 13:46:31 UTC.");
  });

  it("passes the SDK's message through for other failures and says nothing when the wallet declined", () => {
    expect(askErrorText(new CopybookError("WRONG_CHAIN", "The wallet is on chain 1; Copybook runs on chain 50383 (Somnia Hideki2 testnet)."))).toMatch(/chain 1/);
    expect(askErrorText(Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" }))).toBeNull();
    expect(askErrorText({ shortMessage: "insufficient funds for gas * price + value" })).toBe("insufficient funds for gas * price + value");
  });
});

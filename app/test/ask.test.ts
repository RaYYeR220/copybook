import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { CopybookError, type CopybookEvent } from "@copybook/sdk";
import { askValidators, type AskDeps, type AskPhase } from "@/lib/ask";

const RISK = { verdictTtlSeconds: 604800, blockHoldSeconds: 86400, reviewCooldownSeconds: 600, pendingTimeoutSeconds: 1800 };
const AT = 1793194591;
const FEE = 500000000000000000n;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const TRADER = "0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d";
const block = { tier: "Block" as const, reviewedAt: AT, shannonRequestId: 18072906n, summaryHash: `0x${"69".repeat(32)}` as Hex };

function deps(over: Partial<AskDeps> = {}) {
  const sent: bigint[] = [];
  const d: AskDeps = {
    verdict: async () => block,
    pending: async () => null,
    fee: async () => FEE,
    balance: async () => 3n * FEE,
    send: async (value) => {
      sent.push(value);
      return {
        hash: HASH,
        wait: async () => ({
          receipt: { blockNumber: 35800000n },
          events: [{ name: "ReviewRequested", trader: TRADER, nonce: 44n, requester: TRADER, log: { address: TRADER, topics: [], data: "0x" } } as unknown as CopybookEvent],
        }),
      };
    },
    now: () => AT + 3600,
    risk: RISK,
    ...over,
  };
  return { d, sent };
}

const run = async (d: AskDeps) => {
  const phases: AskPhase["phase"][] = [];
  const last = await askValidators(d, (p) => phases.push(p.phase));
  return { phases, last };
};

describe("ask the validators", () => {
  it("pays exactly the gate's current fee and reports the request's nonce and block", async () => {
    const { d, sent } = deps({ fee: async () => 777n });
    const { phases, last } = await run(d);
    expect(sent).toEqual([777n]);
    expect(phases).toEqual(["checking", "signing", "sent", "requested"]);
    expect(last).toEqual({ phase: "requested", hash: HASH, nonce: 44n, block: 35800000n });
  });

  it("during the demo leader's BLOCK hold it can still ask, and says the BLOCK stands until the hold ends", async () => {
    const seen: AskPhase[] = [];
    const { d } = deps();
    await askValidators(d, (p) => seen.push(p));
    const signing = seen.find((p) => p.phase === "signing");
    expect(signing).toEqual({ phase: "signing", fee: FEE, state: { kind: "ready", holdUntil: AT + 86400 } });
  });

  it("does not ask the wallet to sign when it cannot pay the fee and gas", async () => {
    const { d, sent } = deps({ balance: async () => FEE });
    const { phases, last } = await run(d);
    expect(sent).toEqual([]);
    expect(phases).toEqual(["checking", "failed"]);
    expect(last).toEqual({ phase: "failed", message: "This wallet holds 0.5 STT; a review costs 0.5 STT plus gas. Nothing was sent." });
  });

  it("does not send while a review is pending", async () => {
    const { d, sent } = deps({ pending: async () => ({ nonce: 43n, requestedAt: AT + 3000 }) });
    const { last } = await run(d);
    expect(sent).toEqual([]);
    expect(last).toEqual({ phase: "blocked", state: { kind: "pending", nonce: 43n, requestedAt: AT + 3000, replaceableAt: AT + 4800 } });
  });

  it("does not send during the cooldown after a verdict", async () => {
    const { d, sent } = deps({ verdict: async () => ({ ...block, tier: "Ok" }), now: () => AT + 100 });
    const { last } = await run(d);
    expect(sent).toEqual([]);
    expect(last).toEqual({ phase: "blocked", state: { kind: "cooldown", readyAt: AT + 600 } });
  });

  it("explains a Pending revert when another review got in first", async () => {
    const { d } = deps({
      send: async () => {
        throw new CopybookError("REVERTED", "A review of this trader is already pending.", { revert: "Pending", revertArgs: [45n, BigInt(AT + 5400)] });
      },
    });
    const { last } = await run(d);
    expect(last).toEqual({ phase: "failed", message: "A review of this trader is already pending (request #45). It can be replaced after 28 Oct 2026, 15:06:31 UTC." });
  });

  it("explains a Cooldown revert", async () => {
    const { d } = deps({
      send: async () => {
        throw new CopybookError("REVERTED", "x", { revert: "Cooldown", revertArgs: [BigInt(AT + 600)] });
      },
    });
    expect((await run(d)).last).toMatchObject({ phase: "failed", message: expect.stringMatching(/^This trader was reviewed a moment ago/) });
  });

  it("goes back to idle when the wallet declines", async () => {
    const { d } = deps({
      send: async () => {
        throw Object.assign(new Error("User rejected"), { code: 4001 });
      },
    });
    expect((await run(d)).last).toEqual({ phase: "idle" });
  });

  it("reports a transaction that reverted on chain", async () => {
    const { d } = deps({
      send: async () => ({
        hash: HASH,
        wait: async () => {
          throw new CopybookError("TX_FAILED", `Transaction ${HASH} reverted on chain.`);
        },
      }),
    });
    const { phases, last } = await run(d);
    expect(phases).toEqual(["checking", "signing", "sent", "failed"]);
    expect(last).toEqual({ phase: "failed", message: `Transaction ${HASH} reverted on chain.` });
  });

  it("reports a failed read without sending", async () => {
    const send = vi.fn();
    const { d } = deps({ fee: async () => Promise.reject(new Error("HTTP request failed")), send });
    expect((await run(d)).last).toEqual({ phase: "failed", message: "HTTP request failed" });
    expect(send).not.toHaveBeenCalled();
  });
});

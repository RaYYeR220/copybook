import type { Hex } from "viem";
import type { CopybookEvent, Verdict } from "@copybook/sdk";
import type { RiskParams } from "./publicConfig";
import { fmtStt } from "./units";
import { askErrorText, askState, verdictView, type AskState } from "./verdict";

export type AskPhase =
  | { phase: "idle" }
  | { phase: "checking" }
  /** The gate would refuse it now: a review is pending, or the trader was reviewed minutes ago. Nothing was sent. */
  | { phase: "blocked"; state: Exclude<AskState, { kind: "ready" }> }
  /** Waiting for the wallet to sign a payment of exactly `fee`. */
  | { phase: "signing"; fee: bigint; state: Extract<AskState, { kind: "ready" }> }
  | { phase: "sent"; hash: Hex }
  | { phase: "requested"; hash: Hex; nonce?: bigint; block: bigint }
  | { phase: "failed"; message: string };

export interface AskDeps {
  verdict(): Promise<Pick<Verdict, "tier" | "reviewedAt" | "shannonRequestId" | "summaryHash">>;
  pending(): Promise<{ nonce: bigint; requestedAt: number } | null>;
  /** The gate's current `reviewFee()`. */
  fee(): Promise<bigint>;
  /** The asking wallet's STT balance. */
  balance(): Promise<bigint>;
  /** `requestReview(trader)` paying `value`. */
  send(value: bigint): Promise<{ hash: Hex; wait(): Promise<{ events: CopybookEvent[]; receipt: { blockNumber: bigint } }> }>;
  /** Unix seconds. */
  now(): number;
  risk: RiskParams;
}

/**
 * Asks the validators to review a trader: reads the gate's state fresh, explains instead of sending when the gate
 * would refuse (pending review, cooldown), and otherwise pays exactly the gate's current fee. A wallet that
 * declines returns to idle; any revert (the gate moved between the check and the send) is explained.
 */
export async function askValidators(deps: AskDeps, onPhase: (p: AskPhase) => void = () => {}): Promise<AskPhase> {
  const set = (p: AskPhase) => {
    onPhase(p);
    return p;
  };
  set({ phase: "checking" });
  try {
    const [verdict, pending, fee, balance] = await Promise.all([deps.verdict(), deps.pending(), deps.fee(), deps.balance()]);
    const now = deps.now();
    const state = askState(verdictView(verdict, now, deps.risk), pending, now, deps.risk);
    if (state.kind !== "ready") return set({ phase: "blocked", state });
    if (balance <= fee) return set({ phase: "failed", message: `This wallet holds ${fmtStt(balance)}; a review costs ${fmtStt(fee)} plus gas. Nothing was sent.` });
    set({ phase: "signing", fee, state });
    const tx = await deps.send(fee);
    set({ phase: "sent", hash: tx.hash });
    const out = await tx.wait();
    const req = out.events.find((e) => e.name === "ReviewRequested");
    return set({ phase: "requested", hash: tx.hash, nonce: req?.name === "ReviewRequested" ? req.nonce : undefined, block: out.receipt.blockNumber });
  } catch (err) {
    const message = askErrorText(err);
    return set(message === null ? { phase: "idle" } : { phase: "failed", message });
  }
}

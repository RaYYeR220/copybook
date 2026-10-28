import { CopybookError, type TierName, type Verdict } from "@copybook/sdk";
import type { RiskParams } from "./publicConfig";
import { fmtUtc } from "./units";
import { isUserRejection } from "./wallet/addNetwork";

export interface VerdictView {
  tier: TierName;
  reviewed: boolean;
  reviewedAt?: number;
  /** A BLOCK inside its TTL: guarded followers get no new size from this trader (exits still run). */
  blocking: boolean;
  /** A BLOCK past its TTL. */
  expired: boolean;
  /** BLOCK only: until then a milder verdict cannot replace it (a new BLOCK can refresh it). */
  heldUntil?: number;
  held: boolean;
  /** BLOCK only: when it stops blocking unless a new BLOCK refreshes it. */
  expiresAt?: number;
  /** A new review of this trader can be asked from then on. */
  cooldownUntil?: number;
}

type StoredVerdict = Pick<Verdict, "tier" | "reviewedAt" | "shannonRequestId" | "summaryHash">;

/** What a stored verdict means at `now`, with the gate's timing rules from `deployments/risk.json`. */
export function verdictView(v: StoredVerdict, now: number, risk: RiskParams): VerdictView {
  const reviewed = v.tier !== "None" && v.reviewedAt > 0;
  if (!reviewed) return { tier: "None", reviewed: false, blocking: false, expired: false, held: false };
  const base = { tier: v.tier, reviewed: true, reviewedAt: v.reviewedAt, cooldownUntil: v.reviewedAt + risk.reviewCooldownSeconds };
  if (v.tier !== "Block") return { ...base, blocking: false, expired: false, held: false };
  const expiresAt = v.reviewedAt + risk.verdictTtlSeconds;
  const heldUntil = v.reviewedAt + risk.blockHoldSeconds;
  const expired = now > expiresAt;
  return { ...base, blocking: !expired, expired, held: !expired && now < heldUntil, heldUntil, expiresAt };
}

export type AskState =
  /** `replaces`: an unanswered review past its timeout that this one replaces. `holdUntil`: the BLOCK stands until then whatever this review finds. */
  | { kind: "ready"; replaces?: bigint; holdUntil?: number }
  | { kind: "pending"; nonce: bigint; requestedAt: number; replaceableAt: number }
  | { kind: "cooldown"; readyAt: number };

/** The gate's checks on `requestReview`, in its order, so the page can explain instead of sending a call that reverts. */
export function askState(view: VerdictView, pending: { nonce: bigint; requestedAt: number } | null, now: number, risk: RiskParams): AskState {
  let replaces: bigint | undefined;
  if (pending && pending.nonce !== 0n) {
    const replaceableAt = pending.requestedAt + risk.pendingTimeoutSeconds;
    if (now < replaceableAt) return { kind: "pending", nonce: pending.nonce, requestedAt: pending.requestedAt, replaceableAt };
    replaces = pending.nonce;
  }
  if (view.cooldownUntil !== undefined && now < view.cooldownUntil) return { kind: "cooldown", readyAt: view.cooldownUntil };
  const out: AskState = { kind: "ready" };
  if (replaces !== undefined) out.replaces = replaces;
  if (view.held && view.heldUntil !== undefined) out.holdUntil = view.heldUntil;
  return out;
}

/** Plain words for a failed review request; null when the person declined in their wallet. */
export function askErrorText(err: unknown): string | null {
  if (isUserRejection(err)) return null;
  if (err instanceof CopybookError) {
    const args = err.revertArgs ?? [];
    if (err.revert === "Pending") {
      return `A review of this trader is already pending (request #${String(args[0])}). It can be replaced after ${fmtUtc(Number(args[1]))}.`;
    }
    if (err.revert === "Cooldown") return `This trader was reviewed a moment ago. A new review can be asked after ${fmtUtc(Number(args[0]))}.`;
    return err.message;
  }
  const e = err as { shortMessage?: string; message?: string } | undefined;
  return e?.shortMessage ?? e?.message ?? "The request failed.";
}

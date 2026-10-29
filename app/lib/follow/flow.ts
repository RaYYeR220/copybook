import type { Address, Hex } from "viem";
import type { SourceKindName, Verdict } from "@copybook/sdk";
import type { RiskParams } from "../publicConfig";
import { askState, verdictView } from "../verdict";

/**
 * The follow flow as a pure function of what the chain says now, plus the few choices the person made on this
 * page (their policy, their tank, a skipped review). Everything that a transaction changes is read back from the
 * chain, so a reload, a second tab or another account always lands on the right step.
 */

export type StepId = "connect" | "network" | "source" | "margin" | "approve" | "policy" | "guard" | "tank" | "follow" | "review" | "done";

export const STEP_LABEL: Record<StepId, string> = {
  connect: "Connect a wallet",
  network: "Network",
  source: "One source per wallet",
  margin: "Perps margin",
  approve: "Operator approval",
  policy: "Your policy",
  guard: "AI guard",
  tank: "Gas tank",
  follow: "Follow",
  review: "AI review",
  done: "Done",
};

export interface WalletView {
  /** An injected wallet exists in this browser. */
  installed: boolean;
  status: "disconnected" | "connecting" | "reconnecting" | "connected";
  address?: Address;
  chainId?: number;
}

type StoredVerdict = Pick<Verdict, "tier" | "reviewedAt" | "shannonRequestId" | "summaryHash">;

/** What the flow reads from the chain for one wallet. */
export interface ChainReads {
  /** The wallet these reads are for: reads for another account never decide this one's step. */
  address: Address;
  /** The global `placeOrderFor` grant to the hub. */
  approved: boolean;
  follow: { sourceId: Hex; kind: SourceKindName; ref: bigint } | null;
  /** Perps account equity (18-decimal USD); null when the margin bank could not be read. */
  equity: bigint | null;
  /** USDso in the wallet itself, outside the perps account; null when it could not be read. */
  spot: bigint | null;
  /** How much USDso the margin bank may pull for a deposit; null when it could not be read. */
  marginAllowance: bigint | null;
  /** STT in the wallet, wei. */
  balance: bigint;
  guardOn: boolean;
  tank: bigint;
  /** Trader follows: the gate's stored verdict and pending review. */
  verdict?: StoredVerdict;
  reviewPending?: { nonce: bigint; requestedAt: number } | null;
}

export type ReadsState = { status: "idle" } | { status: "loading"; address?: Address } | { status: "error"; address?: Address; error: string } | { status: "ready"; data: ChainReads };

/** The person's choices on this page. A reload clears them; everything else comes back from the chain. */
export interface LocalChoices {
  /** Continue although the perps account shows no equity, less than suggested, or could not be read. */
  marginWaived: boolean;
  /** The policy step was confirmed with a preflight that had no error. */
  policyDone: boolean;
  /** Trader follows: the guard the person wants; undefined means "as the gate has it". */
  guardWanted?: boolean;
  tankDone: boolean;
  /** Trader follows: the review was skipped on purpose. */
  reviewSkipped: boolean;
}

export const NO_CHOICES: LocalChoices = { marginWaived: false, policyDone: false, tankDone: false, reviewSkipped: false };

export interface FlowInput {
  kind: SourceKindName;
  sourceId: Hex;
  expectedChainId: number;
  wallet: WalletView;
  reads: ReadsState;
  local: LocalChoices;
  now: number;
  risk: RiskParams;
  /** The margin the follow should start with (see `marginTarget`); undefined when unknown. */
  marginTarget?: bigint;
}

export type Blocker =
  | "no-wallet"
  | "reading"
  | "read-failed"
  /** The wallet follows a different source. */
  | "following-other"
  | "no-margin"
  /** Equity below the suggested margin while the wallet holds USDso on spot that could cover more of it. */
  | "low-margin"
  | "margin-unreadable";

export type StepState = "done" | "current" | "todo" | "skipped";

export interface FlowView {
  step: StepId;
  /** Why the current step cannot move on by itself. */
  blocker?: Blocker;
  /** The steps to show, in order, each with its state. `guard` appears only when the person changes the guard. */
  steps: { id: StepId; state: StepState }[];
  /** The wallet already follows this very source. */
  followingThis: boolean;
  /** Trader follows: what the review step does (or why it is skipped). */
  review?: ReviewNeed;
  /** Done: the wallet follows but holds no operator grant, so the hub can place no copy until it grants again. */
  noGrant?: boolean;
  /** Done, trader follows: the wallet's AI guard as the gate has it. */
  guardOn?: boolean;
}

export type ReviewNeed =
  /** No verdict within its TTL, and the gate would take a request now. */
  | "needed"
  /** A verdict within its TTL: the guard has something to go on. */
  | "fresh"
  /** A review is already on its way. */
  | "pending"
  /** The trader was reviewed minutes ago. */
  | "cooldown";

/** Whether a review is worth asking for after a trader follow, by the gate's own rules. */
export function reviewNeed(verdict: StoredVerdict | undefined, pending: { nonce: bigint; requestedAt: number } | null | undefined, now: number, risk: RiskParams): ReviewNeed {
  const stored = verdict ?? { tier: "None", reviewedAt: 0, shannonRequestId: 0n, summaryHash: `0x${"0".repeat(64)}` as Hex };
  const view = verdictView(stored, now, risk);
  const ask = askState(view, pending ?? null, now, risk);
  if (ask.kind === "pending") return "pending";
  if (ask.kind === "cooldown") return "cooldown";
  // a BLOCK in its hold is fresh by definition; any other verdict is fresh inside its TTL
  if (view.reviewed && view.reviewedAt !== undefined && now <= view.reviewedAt + risk.verdictTtlSeconds) return "fresh";
  return "needed";
}

const ORDER: StepId[] = ["connect", "network", "source", "margin", "approve", "policy", "guard", "tank", "follow", "review", "done"];

const sameAddress = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function deriveFlow(input: FlowInput): FlowView {
  const { kind, wallet, reads, local } = input;
  const trader = kind === "Trader";
  const connected = (wallet.status === "connected" || wallet.status === "reconnecting") && !!wallet.address;
  const data = reads.status === "ready" && sameAddress(reads.data.address, wallet.address) ? reads.data : undefined;

  // the guard step shows once the person changes the guard (the page drops the choice when it matches the gate again)
  const guardChosen = trader && data !== undefined && local.guardWanted !== undefined;
  const guardPending = guardChosen && local.guardWanted !== data!.guardOn;
  const ids = ORDER.filter((id) => (id === "guard" ? guardChosen : id === "review" ? trader : true));
  const view = (step: StepId, extra: Partial<FlowView> = {}): FlowView => {
    const at = ids.indexOf(step);
    const passed = (id: StepId): StepState => {
      // the grant is read from the chain, not assumed: a wallet that follows without it (revoked elsewhere) shows it to do
      if (id === "approve" && data && !data.approved) return "todo";
      if (id !== "review") return "done";
      // a review on its way counts as done; a fresh verdict, a cooldown or a skip leave the step skipped
      return extra.review === "pending" ? "done" : "skipped";
    };
    return {
      step,
      followingThis: false,
      ...extra,
      steps: ids.map((id, i) => ({ id, state: i < at ? passed(id) : i === at ? "current" : "todo" })),
    };
  };

  if (!connected) return view("connect", wallet.installed ? {} : { blocker: "no-wallet" });
  if (wallet.chainId !== input.expectedChainId) return view("network");
  if (!data) {
    const forThis = reads.status !== "idle" && reads.status !== "ready" && sameAddress(reads.address, wallet.address);
    return view("source", { blocker: reads.status === "error" && forThis ? "read-failed" : "reading" });
  }

  if (data.follow) {
    if (data.follow.sourceId.toLowerCase() !== input.sourceId.toLowerCase()) return view("source", { blocker: "following-other" });
    const noGrant = !data.approved;
    if (!trader) return view("done", { followingThis: true, noGrant });
    const need = reviewNeed(data.verdict, data.reviewPending, input.now, input.risk);
    if (need === "needed" && !local.reviewSkipped) return view("review", { followingThis: true, review: need });
    return view("done", { followingThis: true, review: need, noGrant, guardOn: data.guardOn });
  }

  if (!local.marginWaived) {
    if (data.equity === null) return view("margin", { blocker: "margin-unreadable" });
    if (data.equity <= 0n) return view("margin", { blocker: "no-margin" });
    // short of the suggested margin: offered only when there is spot USDso to move in, never a dead end
    if (input.marginTarget !== undefined && data.equity < input.marginTarget && data.spot !== null && data.spot > 0n) return view("margin", { blocker: "low-margin" });
  }
  if (!data.approved) return view("approve");
  if (!local.policyDone) return view("policy");
  if (guardPending) return view("guard");
  if (!local.tankDone) return view("tank");
  return view("follow");
}

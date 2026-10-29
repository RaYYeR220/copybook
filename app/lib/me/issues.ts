import type { Address } from "viem";
import { MIN_TANK, type FollowerStatus } from "@copybook/sdk";
import { fmtInt, shortHex } from "../format";
import { fmtStt } from "../units";

/**
 * The dashboard's banners: every stuck state the chain shows for this follow, each with the exact call that clears
 * it. The SDK's `status().issues` gives the hub's own states; the dashboard adds what only the event log and the
 * book show (markets left out of step after a deferral, a missing operator grant).
 */

export type CallMethod = "resume" | "poke" | "catchUp" | "resync" | "fundTank" | "setGuard" | "approveOperator";

export interface Call {
  method: CallMethod;
  args: readonly unknown[];
  /** STT sent with it (fundTank). */
  value?: bigint;
  /** `hub.catchUp(0x7d73…1932, [])`, as the wallet will send it. */
  text: string;
  /** The button: `Send catchUp`. */
  label: string;
}

export type BannerCode = FollowerStatus["issues"][number]["code"] | "OUT_OF_STEP" | "NO_GRANT";

export interface Banner {
  code: BannerCode;
  severity: "error" | "warning" | "info";
  message: string;
  call?: Call;
  /** No call clears it: the person changes the policy or adds margin first. */
  fix?: "policy-or-margin";
}

const CONTRACT: Record<CallMethod, string> = {
  resume: "hub",
  poke: "hub",
  catchUp: "hub",
  resync: "hub",
  fundTank: "hub",
  setGuard: "gate",
  approveOperator: "registry",
};

const arg = (v: unknown, names: (a: string) => string | undefined): string => {
  if (Array.isArray(v)) return `[${v.map((x) => arg(x, names)).join(", ")}]`;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return names(v) ?? shortHex(v);
  return String(v);
};

/** The call as text: `hub.catchUp(0x7d73…1932, [BTC-PERP])`. `names` turns a pool into its market name. */
export function callText(method: CallMethod, args: readonly unknown[], value?: bigint, names: (a: string) => string | undefined = () => undefined): string {
  const shown = method === "approveOperator" ? ["hub", "[placeOrderFor]", ...args] : args;
  const name = method === "approveOperator" ? "setOperatorApprovalGlobal" : method;
  return `${CONTRACT[method]}.${name}(${shown.map((a) => arg(a, names)).join(", ")})${value !== undefined ? ` · value ${fmtStt(value)}` : ""}`;
}

export const makeCall = (method: CallMethod, args: readonly unknown[] = [], value?: bigint, names?: (a: string) => string | undefined): Call => ({
  method,
  args,
  ...(value !== undefined ? { value } : {}),
  text: callText(method, args, value, names),
  label: method === "approveOperator" ? "Send the grant" : `Send ${method}`,
});

const ORDER = { error: 0, warning: 1, info: 2 } as const;

export interface BannerInput {
  status: FollowerStatus;
  /** Trader follows: markets a catchUp would bring to the trader's size (see `catchUpPools`). */
  catchUp?: readonly Address[];
  /** The newest unanswered Deferred since the follow began. */
  deferredAt?: bigint;
  /** The global operator grant; undefined when unread. */
  approved?: boolean;
  /** pool → market name for the call text. */
  names?: (a: string) => string | undefined;
}

export function dashboardBanners({ status, catchUp = [], deferredAt, approved, names }: BannerInput): Banner[] {
  const out: Banner[] = [];
  const follow = status.follow;
  if (!follow) return out;
  for (const i of status.issues) {
    const b: Banner = { code: i.code, severity: i.severity, message: i.message };
    if (i.action) {
      const value = i.action.method === "fundTank" ? (i.action.args?.[0] as bigint) : undefined;
      const args = i.action.method === "fundTank" ? [] : (i.action.args ?? []);
      b.call = makeCall(i.action.method, args, value, names);
    } else if (i.code === "STOPPED") b.fix = "policy-or-margin";
    out.push(b);
  }
  const latched = status.issues.some((i) => i.code === "EXITS_PENDING" || i.code === "STOP_CLOSES_PENDING");
  if (follow.kind === "Trader" && !follow.paused && !latched && catchUp.length > 0) {
    const list = catchUp.map((p) => names?.(p) ?? shortHex(p)).join(", ");
    out.push({
      code: "OUT_OF_STEP",
      severity: "warning",
      message:
        deferredAt !== undefined
          ? `The handler deferred this follow at block #${fmtInt(deferredAt)} (its group ran out of gas), so ${list} ${catchUp.length === 1 ? "is" : "are"} out of step with the trader. catchUp brings ${catchUp.length === 1 ? "it" : "them"} to the trader's size now, on your gas.`
          : `${list} ${catchUp.length === 1 ? "is" : "are"} out of step with the trader and no gate refused ${catchUp.length === 1 ? "it" : "them"} for good: the hub acts at the trader's next move there, or now with catchUp, on your gas. Band and caps apply as usual.`,
      call: makeCall("catchUp", [status.follower, [...catchUp]], undefined, names),
    });
  }
  if (approved === false) {
    out.push({
      code: "NO_GRANT",
      severity: "info",
      message:
        "This wallet has no global operator grant to the hub. A grant for single markets may still cover some of them; in any market without one, the venue refuses every copy.",
      call: makeCall("approveOperator", [true], undefined, names),
    });
  }
  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** The banner the dashboard offers to send when it opens: the most severe one with a call, never an info one. */
export function offerOnOpen(banners: readonly Banner[]): Banner | undefined {
  return banners.find((b) => b.call && b.severity !== "info");
}

/** What a withdrawal may take now: everything above the 0.2 STT floor while following, all of it after. */
export const withdrawable = (tank: bigint, following: boolean): bigint => (following ? (tank > MIN_TANK ? tank - MIN_TANK : 0n) : tank);

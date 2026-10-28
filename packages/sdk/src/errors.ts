import { decodeErrorResult, type Abi, type Hex } from "viem";
import { engineErrorsAbi } from "./abi/engineErrors.ts";
import { gateAbi } from "./abi/gate.ts";
import { hubAbi } from "./abi/hub.ts";
import { themesAbi } from "./abi/themes.ts";

const onlyErrors = (abi: readonly { type: string }[]) => abi.filter((x) => x.type === "error");

/** Every custom error a Copybook call can revert with. */
export const revertAbi = [
  ...onlyErrors(hubAbi),
  ...onlyErrors(engineErrorsAbi),
  ...onlyErrors(themesAbi),
  ...onlyErrors(gateAbi),
] as unknown as Abi;

/** Plain-language cause for the reverts a user can hit; anything else falls back to the error's name. */
const MESSAGES: Record<string, string> = {
  AlreadyFollowing: "This wallet already follows a source. Unfollow first, or use a dedicated wallet per source.",
  NotFollowing: "This wallet is not following anything.",
  TankTooLow: "The gas tank must be funded with at least 0.2 STT to follow.",
  TankFloor: "A following wallet must keep at least 0.2 STT in its tank. Unfollow to take everything out.",
  InsufficientTank: "That is more than the tank holds.",
  InvalidSource: "That source does not exist, or it is the follower's own address.",
  JoinPoolsNotAllowed: "A theme follow manages its own legs; it takes no market list.",
  TooManyPools: "Too many markets in the list.",
  FollowsPaused: "New follows are paused by the hub owner.",
  StillBelowFloor: "Equity is still below the equity floor, so the stop cannot be lifted yet.",
  FlattenPending: "The stop's closes are not finished. Run poke to finish them, then resume.",
  NotThemeFollow: "Resync applies to theme follows only.",
  RebalanceTooSoon: "A theme can be rebalanced once a minute at most.",
  NoChange: "That rebalance leaves the legs as they are.",
  NotCreator: "Only the theme's creator can rebalance it.",
  UnknownTheme: "No such theme.",
  WeightTooSmall: "Every leg must weigh at least 5% (500 bps), long or short.",
  GrossTooHigh: "The legs' weights add up to more than 300% gross.",
  DuplicatePool: "A market appears twice in the legs.",
  ForeignPool: "That market is not a dreamDEX perp market.",
  TooManyLegs: "A theme holds at most 8 legs.",
  NoLegs: "A theme needs at least one leg.",
  ZeroWeight: "A leg cannot weigh zero.",
  Pending: "A review of this trader is already pending.",
  Cooldown: "This trader was reviewed a moment ago; wait for the cooldown.",
  FeeTooLow: "The review fee is higher than the value sent.",
  InvalidPolicy: "The policy is outside the allowed ranges.",
};

export type CopybookErrorCode =
  | "WRONG_CHAIN"
  | "NO_WALLET"
  | "NO_ACCOUNT"
  | "REVERTED"
  | "TX_FAILED"
  | "INVALID_INPUT";

/** The one error type the SDK throws for failures it understands. */
export class CopybookError extends Error {
  readonly code: CopybookErrorCode;
  /** Name of the contract custom error, when the failure was a revert (e.g. `TankTooLow`). */
  readonly revert?: string;
  readonly revertArgs?: readonly unknown[];
  constructor(code: CopybookErrorCode, message: string, opts: { revert?: string; revertArgs?: readonly unknown[]; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CopybookError";
    this.code = code;
    this.revert = opts.revert;
    this.revertArgs = opts.revertArgs;
  }
}

/** Pulls revert data out of whatever a viem call threw (it nests the node's answer several causes deep). */
export function revertDataOf(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur && typeof cur === "object"; i++) {
    const data = (cur as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}/.test(data)) return data as Hex;
    if (data && typeof data === "object") {
      const inner = (data as { data?: unknown }).data;
      if (typeof inner === "string" && /^0x[0-9a-fA-F]{8,}/.test(inner)) return inner as Hex;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Decodes a revert into a name, arguments and a plain-language message. Undefined when the data is not ours. */
export function decodeRevert(err: unknown): { name: string; args: readonly unknown[]; message: string } | undefined {
  const data = revertDataOf(err);
  if (!data) return undefined;
  try {
    const d = decodeErrorResult({ abi: revertAbi, data });
    const args = (d.args ?? []) as readonly unknown[];
    let message = MESSAGES[d.errorName] ?? d.errorName;
    if (d.errorName === "InvalidPolicy" || d.errorName === "InvalidParam") {
      const field = ["", "scaleBps", "allocation", "maxNotional", "bandBps"][Number(args[0])] ?? `field ${String(args[0])}`;
      message = `${MESSAGES.InvalidPolicy ?? d.errorName} (${field}).`;
    }
    return { name: d.errorName, args, message };
  } catch {
    return undefined;
  }
}

/** Wraps a thrown viem error: a known contract revert becomes a CopybookError, anything else passes through. */
export function asCopybookError(err: unknown): unknown {
  if (err instanceof CopybookError) return err;
  const r = decodeRevert(err);
  if (!r) return err;
  return new CopybookError("REVERTED", r.message, { revert: r.name, revertArgs: r.args, cause: err });
}

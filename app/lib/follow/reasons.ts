import type { PreflightCode, PreflightReason } from "@copybook/sdk";
import { shortHex } from "../format";
import type { MarketMeta } from "../tape";
import { fmtStt, fmtUsd18 } from "../units";
import type { FormField } from "./policyForm";

/**
 * Preflight reasons as the follow page shows them: the SDK's sentence, the market it is about, the least value
 * that clears it, and a one-click fix that writes that value into the form. Nothing here is sent anywhere.
 */

export interface ReasonView {
  key: string;
  code: PreflightCode;
  severity: PreflightReason["severity"];
  message: string;
  /** `BTC-PERP`, when the reason is about one market. */
  market?: string;
  /** The form field to fix. */
  field?: FormField | "tank";
  /** `Least that clears it: $60.00 at today's marks`. */
  needs?: string;
  /** Writes a value into a field: the least value that clears it, rounded up to a whole dollar (or exact STT). */
  apply?: { field: FormField | "tank"; value: string; label: string };
}

const E18 = 10n ** 18n;
const ceilDollars = (x: bigint) => ((x + E18 - 1n) / E18).toString();

/** The policy fields the SDK names, as the form names them. */
const FIELD: Record<string, FormField | "tank"> = {
  scaleBps: "scale",
  allocation: "allocation",
  maxNotional: "maxNotional",
  maxTotalNotional: "maxTotalNotional",
  bandBps: "band",
  equityFloor: "equityFloor",
  tank: "tank",
};

/** Reasons that the tank step settles, not the policy step. */
const TANK_CODES = new Set<PreflightCode>(["TANK_TOO_LOW", "INSUFFICIENT_BALANCE"]);
/** Reasons the flow handles in its own steps (wallet, network, one source, approval): never shown as form reasons. */
const FLOW_CODES = new Set<PreflightCode>(["WRONG_CHAIN", "NO_ACCOUNT", "ALREADY_FOLLOWING", "OPERATOR_NOT_APPROVED"]);

export function reasonView(r: PreflightReason, markets: Record<string, MarketMeta>, recommendedAllocation?: bigint): ReasonView {
  const m = r.pool ? markets[r.pool.toLowerCase()] : undefined;
  const field = r.field ? FIELD[r.field] : undefined;
  const v: ReasonView = {
    key: `${r.code}:${r.pool ?? ""}:${r.field ?? ""}`,
    code: r.code,
    severity: r.severity,
    message: r.message,
    ...(r.pool ? { market: m ? `${m.symbol}-PERP` : shortHex(r.pool) } : {}),
    ...(field ? { field } : {}),
  };
  if (r.required === undefined || r.severity !== "error") return v;
  switch (r.code) {
    case "ALLOCATION_BELOW_MINIMUM": {
      // the exact minimum holds at today's marks only: the fix adds the SDK's 10% headroom when it has it
      const use = recommendedAllocation !== undefined && recommendedAllocation > r.required ? recommendedAllocation : r.required;
      return {
        ...v,
        needs: `Least that opens every leg at today's marks: ${fmtUsd18(r.required, "up")}`,
        apply: { field: "allocation", value: ceilDollars(use), label: `Use $${ceilDollars(use)}${use !== r.required ? " (10% headroom)" : ""}` },
      };
    }
    case "CAP_BELOW_ONE_ORDER":
      return { ...v, needs: `Least cap that fits one order here: ${fmtUsd18(r.required, "up")}`, apply: { field: "maxNotional", value: ceilDollars(r.required), label: `Use $${ceilDollars(r.required)}` } };
    case "TOTAL_CAP_BELOW_BASKET":
      return { ...v, needs: `The basket opens at ${fmtUsd18(r.required, "up")} in total`, apply: { field: "maxTotalNotional", value: ceilDollars(r.required), label: `Use $${ceilDollars(r.required)}` } };
    case "TANK_TOO_LOW":
      return { ...v, needs: `Least the hub takes: ${fmtStt(r.required)}`, apply: { field: "tank", value: (Number(r.required) / 1e18).toString(), label: `Use ${fmtStt(r.required)}` } };
    case "INSUFFICIENT_BALANCE":
      return { ...v, needs: `The deposit is ${fmtStt(r.required)}, plus gas` };
    case "EQUITY_BELOW_FLOOR":
      return { ...v, needs: `Equity now: ${fmtUsd18(r.required)}. Set the floor below it, or leave it empty to keep it off.` };
    default:
      return v;
  }
}

export type FormStep = "policy" | "tank" | "follow";

/**
 * The reasons a step shows. The policy step leaves the tank's reasons to the tank step; every step leaves the
 * wallet, network, one-source and approval reasons to the flow, which has a step for each.
 */
export function reasonsFor(step: FormStep, reasons: readonly PreflightReason[]): PreflightReason[] {
  return reasons.filter((r) => !FLOW_CODES.has(r.code) && (step !== "policy" || !TANK_CODES.has(r.code)));
}

/** True when a step must not move on: an error among the reasons it shows. */
export const blocks = (step: FormStep, reasons: readonly PreflightReason[]) => reasonsFor(step, reasons).some((r) => r.severity === "error");

import type { PreflightReason, PreflightResult } from "@copybook/sdk";
import { fmt } from "./units.ts";

/** JSON with bigints as decimal strings. Raw bigints are chain integers, so use `fmt` where a value is money. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function presentReason(r: PreflightReason) {
  const money = r.required === undefined ? undefined : fmt(r.required);
  return {
    code: r.code,
    severity: r.severity,
    message: r.message,
    ...(r.pool ? { pool: r.pool } : {}),
    ...(r.field ? { field: r.field } : {}),
    ...(money !== undefined ? { leastValue: money, unit: r.field === "tank" ? "STT" : "USDso" } : {}),
  };
}

export function presentPreflight(p: PreflightResult) {
  return {
    ok: p.ok,
    reasons: p.reasons.map(presentReason),
    steps: p.steps,
    ...(p.themeMinimum
      ? {
          thesisMinimum: {
            minAllocationUsdso: fmt(p.themeMinimum.allocation),
            recommendedAllocationUsdso: fmt(p.themeMinimum.recommendedAllocation),
            minPerPositionCapUsdso: fmt(p.themeMinimum.maxNotional),
            bindingPool: p.themeMinimum.bindingPool,
          },
        }
      : {}),
  };
}

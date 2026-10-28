import type { TraderStats } from "./stats.ts";

export const RISK_SUMMARY_MAX_LENGTH = 280;

const NA = "n/a";

const signed = (x: number) => {
  const r = Math.sign(x) * (Math.round(Math.abs(x) * 10) / 10);
  if (r === 0) return "+0.0";
  return `${r > 0 ? "+" : "-"}${Math.abs(r).toFixed(1)}`;
};
const fixed1 = (x: number | null) => (x == null ? NA : x.toFixed(1));

/**
 * Compact, deterministic key=value line for a reviewer (human or model).
 * Unknown values are written as n/a rather than guessed.
 */
export function riskSummary(s: TraderStats): string {
  const w = `${s.windowDays}d`;
  const parts = [
    `trades${w}=${s.trades30d}`,
    `activeDays${w}=${s.activeDays30d}`,
    `markets=${s.marketsTraded}`,
    `realizedPnl${w}=${signed(s.realizedPnl30d)}`,
    `liquidations${w}=${s.liquidations30d}`,
    `maxDrawdownPct${w}=${fixed1(s.maxDrawdownPct30d)}`,
    `avgLeverage=${fixed1(s.avgLeverage)}`,
    `lastActive=${s.lastActiveAt ? s.lastActiveAt.slice(0, 10) : NA}`,
  ];
  if (s.truncated) parts.push("partial=1");
  return parts.join(" ").slice(0, RISK_SUMMARY_MAX_LENGTH);
}

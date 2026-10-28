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
 * Unknown values are written as n/a rather than guessed. The absolute drawdown is always
 * present; the percentage appears only when it could be estimated honestly.
 * The flags `history=none` and `partial=1` are appended last and always survive the length cap.
 */
export function riskSummary(s: TraderStats): string {
  const w = `${s.windowDays}d`;
  const parts = [
    `trades${w}=${s.trades30d}`,
    `activeDays${w}=${s.activeDays30d}`,
    `markets=${s.marketsTraded}`,
    `realizedPnl${w}=${signed(s.realizedPnl30d)}`,
    `liquidations${w}=${s.liquidations30d}`,
    `maxDrawdown${w}=${fixed1(s.maxDrawdownAbs30d)}`,
  ];
  if (s.maxDrawdownPct30d != null) parts.push(`maxDrawdownPct${w}=${s.maxDrawdownPct30d.toFixed(1)}`);
  parts.push(`avgLeverage=${fixed1(s.avgLeverage)}`, `lastActive=${s.lastActiveAt ? s.lastActiveAt.slice(0, 10) : NA}`);
  const flags: string[] = [];
  if (!s.hasHistory) flags.push("history=none");
  if (s.truncated) flags.push("partial=1");
  const tail = flags.length ? " " + flags.join(" ") : "";
  return parts.join(" ").slice(0, RISK_SUMMARY_MAX_LENGTH - tail.length) + tail;
}

const count = (x: number) => (Number.isFinite(x) ? String(x) : NA);

/**
 * The published rubric's inputs and nothing else: liquidations, trades, the drawdown percentage when it could be
 * estimated (absent otherwise, exactly as in `riskSummary`), and the history and partial flags, always stated.
 * This is the line the validators classify; `riskSummary` stays the fuller line for people.
 */
export function riskRubric(s: TraderStats): string {
  const w = `${s.windowDays}d`;
  const parts = [`liquidations${w}=${count(s.liquidations30d)}`, `trades${w}=${count(s.trades30d)}`];
  if (s.maxDrawdownPct30d != null) parts.push(`maxDrawdownPct${w}=${s.maxDrawdownPct30d.toFixed(1)}`);
  parts.push(`history=${s.hasHistory ? "yes" : "none"}`, `partial=${s.truncated ? 1 : 0}`);
  return parts.join(" ");
}

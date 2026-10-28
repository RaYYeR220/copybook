// The published risk rubric. The validators on Shannon apply it to a trader's 30-day key=value line served by
// /api/risk/<trader> (the full `summary` in run v2, the `rubric` field with only the rule inputs from run v3 on); this
// file applies the same rules in code, so every verdict can be checked.
//
//   BLOCK   if liquidations30d >= 2, or maxDrawdownPct30d is present and >= 50.
//   CAUTION if (not BLOCK and) any of: liquidations30d == 1; trades30d < 10; history=none; partial=1;
//           maxDrawdownPct30d present and >= 25.
//   OK      otherwise.
//
// Unknown is not safe, and what an absent key means depends on the key:
// - liquidations30d, trades30d: written as n/a, or missing, the input counts as CAUTION;
// - maxDrawdownPct30d: written as n/a it counts as CAUTION; absent, the drawdown rules do not apply (the endpoint
//   leaves it out when it cannot be estimated);
// - history, partial: flags; only history=none and partial=1 fire, and an absent flag means the trader has history
//   and the data is complete (partial=0).

export type Tier = "OK" | "CAUTION" | "BLOCK";
export const TIERS: readonly Tier[] = ["OK", "CAUTION", "BLOCK"];

export const RUBRIC = [
  "BLOCK if liquidations30d >= 2, or maxDrawdownPct30d is present and >= 50.",
  "CAUTION if (not BLOCK and) any of: liquidations30d == 1; trades30d < 10; history=none; partial=1; maxDrawdownPct30d present and >= 25.",
  "OK otherwise.",
  "Inputs are the summary keys; n/a means unknown, not safe.",
] as const;

/** The reviewer's system prompt: the rubric in words, set on chain with RiskReviewer.setSystemPrompt. */
export const SYSTEM_PROMPT =
  "You review perpetual-futures traders for people who copy their positions automatically. Apply this rubric exactly to the 30-day stats (key=value; n/a means unknown, not safe). BLOCK if liquidations30d is 2 or more, or maxDrawdownPct30d is present and at least 50. Otherwise CAUTION if liquidations30d is 1, or trades30d is below 10, or history=none, or partial=1, or maxDrawdownPct30d is present and at least 25. Otherwise OK. Answer with exactly one word: OK, CAUTION or BLOCK.";

/** The summary as key -> value. Later duplicates win (none occur: riskSummary writes each key once). */
export function parseSummary(summary: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tok of summary.trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out.set(tok.slice(0, i), tok.slice(i + 1));
  }
  return out;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "n/a" || v.trim() === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export interface RubricResult {
  tier: Tier;
  /** Every rule that fired, BLOCK rules first. Empty for OK. */
  reasons: string[];
}

/** The rubric's tier for a summary line. */
export function rubricTier(summary: string): RubricResult {
  const kv = parseSummary(summary);
  const liq = num(kv.get("liquidations30d"));
  const trades = num(kv.get("trades30d"));
  const hasPct = kv.has("maxDrawdownPct30d");
  const pct = num(kv.get("maxDrawdownPct30d"));

  const block: string[] = [];
  if (liq !== null && liq >= 2) block.push(`liquidations30d=${liq} >= 2`);
  if (pct !== null && pct >= 50) block.push(`maxDrawdownPct30d=${pct} >= 50`);
  if (block.length) return { tier: "BLOCK", reasons: block };

  const caution: string[] = [];
  if (liq === null) caution.push("liquidations30d unknown");
  else if (liq === 1) caution.push("liquidations30d=1");
  if (trades === null) caution.push("trades30d unknown");
  else if (trades < 10) caution.push(`trades30d=${trades} < 10`);
  if (kv.get("history") === "none") caution.push("history=none");
  if (kv.get("partial") === "1") caution.push("partial=1");
  if (hasPct && pct === null) caution.push("maxDrawdownPct30d unknown");
  else if (pct !== null && pct >= 25) caution.push(`maxDrawdownPct30d=${pct} >= 25`);
  return caution.length ? { tier: "CAUTION", reasons: caution } : { tier: "OK", reasons: [] };
}

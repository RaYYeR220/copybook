import { getAddress, isAddress, type Address } from "viem";
import type { Leg } from "@copybook/sdk";
import { shortHex } from "../format";

/**
 * The ThemeRegistry's limits. The page reads them from the deployed registry (its public constants); these are the
 * values in contracts/src/ThemeRegistry.sol, used only when that read fails.
 */
export interface RegistryRules {
  /** MAX_LEGS */
  maxLegs: number;
  /** MAX_GROSS_BPS: Σ|weight| */
  maxGrossBps: number;
  /** MIN_LEG_WEIGHT_BPS: the least |weight| of a leg */
  minLegWeightBps: number;
  /** MIN_REBALANCE_INTERVAL, seconds since creation or the last rebalance */
  minRebalanceInterval: number;
}

export const REGISTRY_SOURCE_RULES: RegistryRules = { maxLegs: 8, maxGrossBps: 30_000, minLegWeightBps: 500, minRebalanceInterval: 60 };

/** The registry's custom errors this module mirrors, by name. */
export type RegistryError =
  | "NoLegs"
  | "TooManyLegs"
  | "ZeroWeight"
  | "WeightTooSmall"
  | "DuplicatePool"
  | "ForeignPool"
  | "GrossTooHigh"
  | "NotCreator"
  | "RebalanceTooSoon"
  | "NoChange";

export type AppCheck = "PickMarket" | "WeightMissing" | "WeightInvalid" | "RegistrationUnknown" | "RegistrationUnread" | "NameMissing" | "NameTooLong" | "NameInvalid" | "UriInvalid" | "UriTooLong";

export interface BasketIssue {
  code: RegistryError | AppCheck;
  /** `registry`: the contract would revert with `code`. `app`: the form is not complete or breaks an app limit. */
  by: "registry" | "app";
  /** `error` blocks signing; `checking` blocks it until a read lands; `wait` blocks it until the chain's clock passes. */
  severity: "error" | "checking" | "wait";
  /** Index of the leg (checkBasket) or of the form row (parseRows). */
  row?: number;
  message: string;
  /** A one-click fix: set this row's weight (percent). */
  fix?: { row: number; weight: string };
  /** The check could not be read: offer to read it again. */
  retry?: true;
  /** For RebalanceTooSoon: chain seconds left. */
  waitSeconds?: number;
}

/** One row of the builder form: a market, a side, and a weight typed as a percentage. */
export interface BasketRow {
  key: string;
  pool: Address | "";
  side: "long" | "short";
  weight: string;
}

const WEIGHT_RE = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

/** A weight typed as a percentage (`12.5`, `5 %`) as whole bps; bps are integers, so at most two decimals. */
export function parseWeight(s: string): number | "missing" | "invalid" {
  const t = s.trim().replace(/\s*%$/, "").trim();
  if (t === "") return "missing";
  const m = WEIGHT_RE.exec(t);
  if (!m) return "invalid";
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** bps → `12.5` (percent, trailing zeros trimmed), the form's own notation. */
export const bpsToPct = (bps: number) => {
  const a = Math.abs(bps);
  return a % 100 === 0 ? String(a / 100) : (a / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

const pct = (bps: number) => `${bpsToPct(bps)}%`;

export interface ParsedRows {
  legs: Leg[];
  /** Leg index → form row index. */
  rowOf: number[];
  issues: BasketIssue[];
}

/** The legs a form describes. Rows without a market or a readable weight are not legs; each is reported by row. */
export function parseRows(rows: readonly BasketRow[]): ParsedRows {
  const legs: Leg[] = [];
  const rowOf: number[] = [];
  const issues: BasketIssue[] = [];
  rows.forEach((r, i) => {
    if (!r.pool || !isAddress(r.pool, { strict: false })) {
      issues.push({ code: "PickMarket", by: "app", severity: "error", row: i, message: `Row ${i + 1} has no market. Pick one or remove the row.` });
      return;
    }
    const w = parseWeight(r.weight);
    if (w === "missing") {
      issues.push({ code: "WeightMissing", by: "app", severity: "error", row: i, message: `Row ${i + 1} has no weight.` });
      return;
    }
    if (w === "invalid") {
      issues.push({ code: "WeightInvalid", by: "app", severity: "error", row: i, message: `Row ${i + 1}: “${r.weight.trim().slice(0, 12)}” is not a weight. Type a percentage with at most two decimals; the side sets long or short.` });
      return;
    }
    legs.push({ pool: getAddress(r.pool), weightBps: r.side === "short" ? -w : w });
    rowOf.push(i);
  });
  return { legs, rowOf, issues };
}

const lc = (a: string) => a.toLowerCase();

/** The margin bank's answer per pool (lower-case): registered or not, `unread` when the read failed, absent while reading. */
export type Registration = Record<string, boolean | "unread" | undefined>;

/**
 * `ThemeRegistry._validate`, before signing. The contract reverts on the first failure; this lists every one, each
 * named by the error the contract would revert with, in the contract's order: the leg count, then per leg
 * ZeroWeight, WeightTooSmall, DuplicatePool, ForeignPool, then the gross. `registered` holds the margin bank's
 * `isPerpPoolRegistered` answer per pool (lower-case); a pool not read yet holds signing back.
 */
export function checkBasket(
  legs: readonly Leg[],
  rules: RegistryRules,
  registered: Registration,
  label: (pool: Address, i: number) => string = (pool, i) => `Leg ${i + 1} (${shortHex(pool)})`,
): BasketIssue[] {
  const out: BasketIssue[] = [];
  const reg = (code: RegistryError, message: string, extra: Partial<BasketIssue> = {}) =>
    out.push({ code, by: "registry", severity: "error", message: `${message} (${code})`, ...extra });

  if (legs.length === 0) reg("NoLegs", "Add at least one leg. The registry refuses an empty thesis");
  if (legs.length > rules.maxLegs) reg("TooManyLegs", `${legs.length} legs: the registry holds at most ${rules.maxLegs} per thesis`);

  let gross = 0;
  legs.forEach((l, i) => {
    const name = label(l.pool, i);
    const abs = Math.abs(l.weightBps);
    gross += abs;
    // the weight and the market are checked apart, so a leg wrong in both says both
    if (l.weightBps === 0) reg("ZeroWeight", `${name} weighs 0%. Give it a weight or remove it`, { row: i });
    else if (abs < rules.minLegWeightBps)
      reg("WeightTooSmall", `${name} weighs ${pct(abs)}: every leg needs at least ${pct(rules.minLegWeightBps)}, long or short`, {
        row: i,
        fix: { row: i, weight: bpsToPct(rules.minLegWeightBps) },
      });
    if (legs.slice(0, i).some((p) => lc(p.pool) === lc(l.pool))) reg("DuplicatePool", `${name} is already a leg: one leg per market`, { row: i });
    else {
      const r = registered[lc(l.pool)];
      if (r === false) reg("ForeignPool", `${name} is not a perp market registered with the margin bank the registry checks`, { row: i });
      else if (r === "unread")
        out.push({
          code: "RegistrationUnread",
          by: "registry",
          severity: "checking",
          row: i,
          retry: true,
          message: `Whether ${name} is registered with the margin bank (ForeignPool) could not be read, so it cannot be signed yet.`,
        });
      else if (r === undefined)
        out.push({ code: "RegistrationUnknown", by: "registry", severity: "checking", row: i, message: `Checking that ${name} is registered with the margin bank (ForeignPool)…` });
    }
  });
  if (gross > rules.maxGrossBps)
    reg("GrossTooHigh", `The legs add up to ${pct(gross)} gross, long and short together; the registry allows ${pct(rules.maxGrossBps)} at most`);
  return out;
}

const NAME_MAX = 48;
const URI_MAX = 256;

/** The registry stores any name; the app asks for 1–48 characters so a thesis reads the same on every page and card. */
export function checkName(name: string): BasketIssue[] {
  const t = name.trim();
  if (!t) return [{ code: "NameMissing", by: "app", severity: "error", message: "Give the thesis a name." }];
  // biome-ignore lint: control characters are exactly what this refuses
  if (/[\u0000-\u001f\u007f]/.test(t)) return [{ code: "NameInvalid", by: "app", severity: "error", message: "The name has a control character in it." }];
  if ([...t].length > NAME_MAX) return [{ code: "NameTooLong", by: "app", severity: "error", message: `Keep the name to ${NAME_MAX} characters (it has ${[...t].length}).` }];
  return [];
}

/** Optional: a link to the write-up behind the thesis, https or ipfs only, since pages link to it. */
export function checkUri(uri: string): BasketIssue[] {
  const t = uri.trim();
  if (!t) return [];
  if (t.length > URI_MAX) return [{ code: "UriTooLong", by: "app", severity: "error", message: `Keep the link under ${URI_MAX} characters.` }];
  if (!safeUri(t)) return [{ code: "UriInvalid", by: "app", severity: "error", message: "The link must start with https:// or ipfs://, or be left empty." }];
  return [];
}

/** A stored uri the pages may link to: https or ipfs, nothing else. */
export function safeUri(uri: string): string | null {
  try {
    const u = new URL(uri.trim());
    return u.protocol === "https:" || u.protocol === "ipfs:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `ThemeRegistry._same`: the same (pool, weight) pairs, in any order. */
export function sameLegs(cur: readonly Leg[], next: readonly Leg[]): boolean {
  if (cur.length !== next.length) return false;
  return next.every((n) => cur.some((c) => lc(c.pool) === lc(n.pool) && c.weightBps === n.weightBps));
}

/** Chain seconds until a rebalance is accepted: the registry refuses while `block.timestamp < updatedAt + interval`. */
export const rebalanceWait = (updatedAt: number, chainNow: number, interval: number) => Math.max(0, updatedAt + interval - chainNow);

export interface RebalanceInput {
  creator: Address;
  account: Address;
  current: readonly Leg[];
  next: readonly Leg[];
  /** The thesis's creation or last rebalance, unix seconds as the chain stored it; null when it could not be read. */
  updatedAt: number | null;
  /** The chain's clock (the latest block's timestamp, carried forward); null until read. */
  chainNow: number | null;
  rules: RegistryRules;
  registered: Registration;
  label?: (pool: Address, i: number) => string;
}

/** `ThemeRegistry.rebalance` in its order: NotCreator, RebalanceTooSoon, the basket rules, NoChange. */
export function checkRebalance(x: RebalanceInput): BasketIssue[] {
  if (lc(x.account) !== lc(x.creator))
    return [{ code: "NotCreator", by: "registry", severity: "error", message: `Only the creator, ${shortHex(x.creator)}, can rebalance this thesis (NotCreator)` }];
  const out: BasketIssue[] = [];
  // an unknown clock is left to the gas estimate, which reverts RebalanceTooSoon before anything is signed
  const wait = x.updatedAt === null || x.chainNow === null ? 0 : rebalanceWait(x.updatedAt, x.chainNow, x.rules.minRebalanceInterval);
  if (wait > 0)
    out.push({
      code: "RebalanceTooSoon",
      by: "registry",
      severity: "wait",
      waitSeconds: wait,
      message: `The registry takes one change per ${x.rules.minRebalanceInterval} s; this thesis last changed ${x.chainNow! - x.updatedAt!} s ago (RebalanceTooSoon)`,
    });
  out.push(...checkBasket(x.next, x.rules, x.registered, x.label));
  if (out.every((i) => i.severity !== "error") && sameLegs(x.current, x.next))
    out.push({ code: "NoChange", by: "registry", severity: "error", message: "These are the legs the thesis has now: change a weight, a side or a market (NoChange)" });
  return out;
}

export type LegChange = "added" | "dropped" | "resized" | "flipped" | "same";

/** What a rebalance does per market: current legs in their order, then the new ones. Weights in bps, signed. */
export function legDiff(cur: readonly Leg[], next: readonly Leg[]): { pool: Address; change: LegChange; from: number; to: number }[] {
  const out: { pool: Address; change: LegChange; from: number; to: number }[] = [];
  for (const c of cur) {
    const n = next.find((x) => lc(x.pool) === lc(c.pool));
    const to = n?.weightBps ?? 0;
    const change: LegChange = !n ? "dropped" : to === c.weightBps ? "same" : Math.sign(to) !== Math.sign(c.weightBps) ? "flipped" : "resized";
    out.push({ pool: c.pool, change, from: c.weightBps, to });
  }
  for (const n of next) if (!cur.some((c) => lc(c.pool) === lc(n.pool))) out.push({ pool: n.pool, change: "added", from: 0, to: n.weightBps });
  return out;
}

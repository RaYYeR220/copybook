/**
 * Number formatting for chain and indexer values. Deterministic (no locale, no clock) so a server render and the
 * hydrated client agree. Negative numbers use a true minus sign; nothing here colours a gain or a loss.
 */

const MINUS = "−";
const group = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `value / 10^decimals`, grouped, trailing zeros trimmed, at most `maxFrac` decimals (a nonzero value never shows as 0). */
export function fmtUnits(value: bigint, decimals: number, maxFrac = 8): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const one = 10n ** BigInt(decimals);
  const int = abs / one;
  let frac = (abs % one).toString().padStart(decimals, "0").slice(0, Math.min(maxFrac, decimals)).replace(/0+$/, "");
  if (abs > 0n && int === 0n && !frac) frac = `${"0".repeat(Math.min(maxFrac, decimals) - 1)}1`;
  const s = `${group(int.toString())}${frac ? `.${frac}` : ""}`;
  return neg && s !== "0" ? `${MINUS}${s}` : s;
}

/** An 18-decimal price: two decimals from 1 up, up to six significant decimals below. */
export function fmtPrice18(price: bigint): string {
  const one = 10n ** 18n;
  if (price >= one || price <= -one) {
    const cents = (price * 100n + (price >= 0n ? one / 2n : -one / 2n)) / one;
    const neg = cents < 0n;
    const a = neg ? -cents : cents;
    return `${neg ? MINUS : ""}${group((a / 100n).toString())}.${(a % 100n).toString().padStart(2, "0")}`;
  }
  return fmtUnits(price, 18, 6);
}

/** An 18-decimal USD amount in cents. `up` rounds any remainder up, for minimums that must not be understated. */
export function fmtUsd18(amount: bigint, round: "nearest" | "up" = "nearest"): string {
  const unit = 10n ** 16n;
  const cents = round === "up" ? (amount + unit - 1n) / unit : (amount + unit / 2n) / unit;
  return `$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A signed 18-decimal USD amount in cents, rounded half away from zero: `+$0.42`, `−$1,250.00`, `$0.00`. */
export function fmtUsdSigned18(amount: bigint): string {
  const unit = 10n ** 16n;
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const cents = (a + unit / 2n) / unit;
  if (cents === 0n) return "$0.00";
  return `${neg ? MINUS : "+"}$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Realized PnL in quote units (USDso), signed, two decimals. */
export function fmtPnl(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (r === 0) return "0.00";
  const [int, frac] = Math.abs(r).toFixed(2).split(".");
  return `${r > 0 ? "+" : MINUS}${group(int)}.${frac}`;
}

/** A plain number with `dp` decimals, digits grouped: `8140.77` → `8,140.77`. */
export function fmtFixed(n: number, dp = 2): string {
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toFixed(dp).split(".");
  const s = `${group(int)}${frac ? `.${frac}` : ""}`;
  return neg && Number(s.replace(/,/g, "")) !== 0 ? `${MINUS}${s}` : s;
}

/** Native STT from wei. */
export const fmtStt = (wei: bigint) => `${fmtUnits(wei, 18, 4)} STT`;

/** USDso (18 decimals) as a token amount: `25 USDso`, `3.5 USDso`. */
export const fmtUsdso = (x: bigint) => `${fmtUnits(x, 18, 4)} USDso`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** Unix seconds as `28 Oct 2026, 13:36:31 UTC`. */
export function fmtUtc(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

/** A duration in seconds as `13 h 40 min`, `9 min`, `40 s`. */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s} s`;
}

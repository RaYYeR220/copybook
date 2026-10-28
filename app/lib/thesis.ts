import type { Leg } from "@copybook/sdk";

/** `7000` → long 70%, `-3000` → short 30%. */
export function legSide(weightBps: number): { side: "long" | "short"; pct: string } {
  const abs = Math.abs(weightBps);
  const pct = abs % 100 === 0 ? `${abs / 100}%` : `${(abs / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
  return { side: weightBps < 0 ? "short" : "long", pct };
}

/** Sum of |weight| over the legs, in bps (the registry allows at most 30,000). */
export const grossBps = (legs: readonly Pick<Leg, "weightBps">[]) => legs.reduce((s, l) => s + Math.abs(l.weightBps), 0);
/** Sum of signed weights, in bps: long minus short. */
export const netBps = (legs: readonly Pick<Leg, "weightBps">[]) => legs.reduce((s, l) => s + l.weightBps, 0);

export const pctOfBps = (bps: number) => {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2)}%`;
};

/** Decimals of a base asset from the venue's `oneBase` (10^decimals). */
export function decimalsOf(oneBase: bigint): number {
  let d = 0;
  for (let x = oneBase; x > 1n; x /= 10n) d++;
  return d;
}

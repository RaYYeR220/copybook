/** Small, allocation-free helpers shared by the canvas scenes. */

export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/** Hermite smoothstep of `v` between `a` and `b` (either order). */
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export const rad = (deg: number) => (deg * Math.PI) / 180;

/** One decimal, for SVG path data. */
export const f1 = (n: number) => n.toFixed(1);

/** Cyclic index into a list (negative indices wrap). */
export const cyc = <T>(list: readonly T[], k: number): T => list[((k % list.length) + list.length) % list.length];

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Stop = readonly [at: number, hex: string];

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Linear mix of two `#rrggbb` colours, as an `rgb()` string. */
export function mixHex(a: string, b: string, t: number) {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`;
}

/** Colour at `t` along a ramp of `[t, #hex]` stops. */
export function mixStops(stops: readonly Stop[], t: number) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mixHex(c0, c1, (t - t0) / (t1 - t0 || 1));
    }
  }
  const last = stops[stops.length - 1][1];
  return mixHex(last, last, 0);
}

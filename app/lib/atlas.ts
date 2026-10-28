import { rad } from "./motion";

/**
 * The engraved star atlas the nightfall flock settles onto. Coordinates are plate units, centred on the pole;
 * the plate is scaled to the stage at layout time.
 */

/** Radius of the limb (the chart's outer circle). */
export const LIMB = 560;
/** Half-size of the plate's viewBox (the hour ring sits outside the limb). */
export const PLATE_OUT = 660;
/** The gold meridian's bearing. The leader and the copies land on it. */
export const MERIDIAN_ANGLE = rad(-56);
/** Where on the meridian (fraction of the limb) the leader and the copies sit. */
export const LEADER_AT = 0.9;
export const COPIES_AT = [0.66, 0.73, 0.8] as const;

interface Constellation {
  name: string;
  /** Polar placement of the figure's origin. */
  r: number;
  a: number;
  rot: number;
  scale: number;
  /** Stars `[x, y, magnitude]` in figure units. */
  stars: readonly (readonly [number, number, number])[];
  lines: readonly (readonly [number, number])[];
}

const CONSTELLATIONS: readonly Constellation[] = [
  { name: "Ursa", r: 445, a: 196, rot: -14, scale: 1.12, stars: [[0, 0, 2], [40, -8, 2], [78, -4, 2], [112, 6, 3], [122, 44, 2], [170, 52, 2], [176, 14, 1]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]] },
  { name: "Cassiopeia", r: 440, a: 258, rot: 18, scale: 1.12, stars: [[0, 0, 2], [30, 30, 2], [62, 8, 1], [96, 36, 2], [128, 4, 3]], lines: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  { name: "Cygnus", r: 372, a: 128, rot: 22, scale: 1.05, stars: [[0, 0, 2], [0, -70, 1], [0, 62, 3], [-56, -12, 2], [56, -20, 3], [0, -34, 4]], lines: [[1, 5], [5, 0], [0, 2], [3, 0], [0, 4]] },
  { name: "Lyra", r: 360, a: 8, rot: 0, scale: 1.25, stars: [[0, 0, 1], [14, 22, 3], [34, 18, 3], [40, 40, 3], [20, 44, 3]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1]] },
  { name: "Orion", r: 300, a: 212, rot: -12, scale: 1.05, stars: [[0, 0, 1], [70, -6, 2], [22, 58, 2], [35, 56, 2], [48, 54, 2], [-6, 118, 1], [76, 112, 2]], lines: [[0, 1], [0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6]] },
  { name: "Delphinus", r: 250, a: 84, rot: 30, scale: 1, stars: [[0, 0, 3], [18, -10, 3], [34, 0, 3], [18, 12, 3], [52, 24, 3]], lines: [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4]] },
];

export interface PlacedConstellation {
  name: string;
  /** Stars in plate units. */
  stars: [x: number, y: number, mag: number][];
  /** Segments, shortened 7 units at each end so they never touch a star. */
  segments: [x1: number, y1: number, x2: number, y2: number][];
  /** Where the name is set: under the figure. */
  label: [x: number, y: number];
}

export const constellations: PlacedConstellation[] = CONSTELLATIONS.map((C) => {
  const ox = C.r * Math.cos(rad(C.a));
  const oy = C.r * Math.sin(rad(C.a));
  const cr = Math.cos(rad(C.rot));
  const sr = Math.sin(rad(C.rot));
  const stars = C.stars.map(([x, y, mg]) => [ox + (x * cr - y * sr) * C.scale, oy + (x * sr + y * cr) * C.scale, mg] as [number, number, number]);
  const segments = C.lines.map(([i, j]) => {
    const [x1, y1] = stars[i];
    const [x2, y2] = stars[j];
    const g = 7 / Math.hypot(x2 - x1, y2 - y1);
    return [x1 + (x2 - x1) * g, y1 + (y2 - y1) * g, x2 - (x2 - x1) * g, y2 - (y2 - y1) * g] as [number, number, number, number];
  });
  const mx = stars.reduce((a, p) => a + p[0], 0) / stars.length;
  const my = Math.max(...stars.map((p) => p[1]));
  return { name: C.name, stars, segments, label: [mx, my + 28] };
});

/** A point on the meridian at `q` × the limb radius, in plate units (multiply by the plate scale for px). */
export const meridianPoint = (q: number): [number, number] => [LIMB * q * Math.cos(MERIDIAN_ANGLE), LIMB * q * Math.sin(MERIDIAN_ANGLE)];

export function roman(n: number) {
  const table: [number, string][] = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, r] of table) {
    while (n >= v) {
      s += r;
      n -= v;
    }
  }
  return s;
}

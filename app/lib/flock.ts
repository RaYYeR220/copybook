import { clamp } from "./motion";

/**
 * The murmuration shared by the hero, the nightfall scene and the pictograms.
 *
 * A flock is one twisted sheet: every bird has fixed coordinates on it (s along, w across, t off the surface), and
 * a single pose (twist, yaw, pitch, roll, scale, centre) places all of them. Turning the pose turns every bird in
 * the same frame, which is the point the page makes about copies landing in the same block.
 */

export interface Bird {
  /** Position along the sheet, -1..1. */
  s: number;
  /** Position across the sheet. */
  w: number;
  /** Offset off the sheet's surface. */
  t: number;
  /** Wingbeat phase. */
  ph: number;
  /** Size and wingbeat rate factor. */
  k: number;
  /** Jitter 0..1 (the nightfall uses it to stagger landings). */
  j: number;
}

export interface PoseInput {
  cx: number;
  cy: number;
  /** Scale in px. */
  S: number;
  twist: number;
  yaw: number;
  pitch: number;
  roll?: number;
  /** Uniform squash. */
  sq?: number;
  /** Seconds, drives the wingbeat. */
  time: number;
}

export interface Pose extends PoseInput {
  cyw: number;
  syw: number;
  cp: number;
  sp: number;
  cr: number;
  sr: number;
}

export interface Projected {
  x: number;
  y: number;
  /** Perspective factor; > 1 is nearer the viewer. */
  f: number;
}

/** Park–Miller generator: the same seed draws the same flock on the server and in the browser. */
export const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

export const gauss = (r: () => number) => {
  let u = 0;
  let v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185 * v);
};

export function formation(n: number, seed: number): Bird[] {
  const r = rng(seed);
  const birds: Bird[] = [];
  while (birds.length < n) {
    const u = r() * 2 - 1;
    if (r() > 0.45 + 0.55 * Math.exp((-u * u) / 0.28)) continue;
    const half = 0.43 * Math.sqrt(Math.max(0, 1 - u * u));
    let v = (r() * 2 - 1) * half;
    let t = gauss(r) * 0.018;
    let s = u;
    if (r() < 0.016) {
      s += gauss(r) * 0.05;
      v += gauss(r) * 0.07;
      t += gauss(r) * 0.08;
    }
    birds.push({ s, w: v, t, ph: r() * 6.2832, k: 0.8 + r() * 0.42, j: r() });
  }
  return birds;
}

export const pose = (o: PoseInput): Pose => ({
  ...o,
  cyw: Math.cos(o.yaw),
  syw: Math.sin(o.yaw),
  cp: Math.cos(o.pitch),
  sp: Math.sin(o.pitch),
  cr: Math.cos(o.roll ?? 0),
  sr: Math.sin(o.roll ?? 0),
});

/** Projects one point of the sheet into `out` (reused to keep the frame allocation-free). */
export function project(b: Pick<Bird, "s" | "w" | "t">, P: Pose, out: Projected): Projected {
  const th = P.twist + 2.0 * b.s;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const x = b.s;
  const y = 0.3 * b.s * b.s + 0.04 * b.s + b.w * c - b.t * sn;
  const z = 0.2 * Math.sin(2.2 * b.s + 0.4) + b.w * sn + b.t * c;
  const x2 = x * P.cyw + z * P.syw;
  const z2 = -x * P.syw + z * P.cyw;
  const y3 = y * P.cp - z2 * P.sp;
  const z3 = y * P.sp + z2 * P.cp;
  const f = 1.55 / (1.55 - z3 * 0.42);
  const sq = P.sq ?? 1;
  const X = x2 * P.S * f * sq;
  const Y = y3 * P.S * f * sq;
  out.x = P.cx + X * P.cr - Y * P.sr;
  out.y = P.cy + X * P.sr + Y * P.cr;
  out.f = f;
  return out;
}

/** Depth buckets: [alpha, line width] for far, middle and near birds. */
export const DEPTH_BUCKETS = [
  [0.3, 0.78],
  [0.5, 0.92],
  [0.76, 1.08],
] as const;

/** A chevron "bird" as SVG path data. */
export const chevronPath = (x: number, y: number, a: number, flap: number) =>
  `M${(x - a).toFixed(1)} ${(y - a * flap).toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}L${(x + a).toFixed(1)} ${(y - a * flap).toFixed(1)}`;

export interface DrawFlockOptions {
  W: number;
  H: number;
  size: number;
  color: string;
  lineWidth?: number;
  /** Nav spans `[left, right, bottom]`; the return value is how far the sheet rises into them. */
  guard?: readonly (readonly [number, number, number])[] | null;
}

/**
 * Strokes the whole flock as three paths (one per depth bucket). Butt caps and bevel joins look the same at
 * 1–2 device px and rasterise about twice as fast as round ones.
 */
export function drawFlock(ctx: CanvasRenderingContext2D, birds: readonly Bird[], P: Pose, opt: DrawFlockOptions): number {
  const o: Projected = { x: 0, y: 0, f: 0 };
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  const G = opt.guard;
  const nG = G ? G.length : 0;
  let over = 0;
  let gy = -1e9;
  for (let i = 0; i < nG; i++) gy = Math.max(gy, G![i][2]);
  for (const b of birds) {
    project(b, P, o);
    if (o.y < gy) {
      for (let i = 0; i < nG; i++) {
        const g = G![i];
        if (o.x > g[0] && o.x < g[1] && g[2] - o.y > over) over = g[2] - o.y;
      }
    }
    if (o.x < -12 || o.y < -12 || o.x > opt.W + 12 || o.y > opt.H + 12) continue;
    // nearness 0..1 from the perspective factor, and its depth bucket (inline: this runs for every bird, every frame)
    const d = clamp((o.f - 0.89) / 0.25);
    const k = d < 0.33 ? 0 : d < 0.66 ? 1 : 2;
    const a = opt.size * (0.62 + 0.55 * d) * b.k;
    const fl = 0.12 + 0.38 * Math.sin(P.time * 10.5 * b.k + b.ph);
    paths[k].moveTo(o.x - a, o.y - a * fl);
    paths[k].lineTo(o.x, o.y);
    paths[k].lineTo(o.x + a, o.y - a * fl);
  }
  ctx.lineCap = "butt";
  ctx.lineJoin = "bevel";
  ctx.strokeStyle = opt.color;
  DEPTH_BUCKETS.forEach(([alpha, lw], k) => {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw * (opt.lineWidth ?? 1);
    ctx.stroke(paths[k]);
  });
  ctx.globalAlpha = 1;
  return over;
}

export interface FittedCanvas {
  ctx: CanvasRenderingContext2D;
  /** CSS px. */
  W: number;
  H: number;
  dpr: number;
}

/** Sizes a canvas's backing store to its CSS box at `min(cap, devicePixelRatio)`. */
export function fitCanvas(cv: HTMLCanvasElement, cap = 2): FittedCanvas {
  const dpr = Math.min(cap, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: r.width, H: r.height, dpr };
}

/** The autonomous turn sequence: twist, yaw and pitch for each successive turn. */
export const TURNS = {
  twist: [1.5, 1.12, 1.9, 1.02, 1.66, 2.06, 1.26],
  yaw: [0, -0.15, 0.13, -0.06, 0.19, -0.11, 0.08],
  pitch: [0.02, 0.1, -0.06, 0.13, -0.04, 0.09, -0.1],
} as const;

/** Seconds between autonomous turns, and how long each turn eases. */
export const TURN_EVERY = 6;
export const TURN_DURATION = 0.9;

export const INK = "#2a2124";
export const GOLD = "#caa063";
/** The leader ring on dusk: a 1px line, not text. */
export const GOLD_STROKE_DUSK = "#a77a35";
export const BONE = "#e6dfcc";

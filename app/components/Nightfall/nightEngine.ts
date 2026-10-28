import { COPIES_AT, LEADER_AT, LIMB, MERIDIAN_ANGLE, constellations } from "@/lib/atlas";
import {
  BONE,
  DEPTH_BUCKETS,
  GOLD,
  GOLD_STROKE_DUSK,
  TURN_DURATION,
  TURN_EVERY,
  TURNS,
  depthOf,
  fitCanvas,
  formation,
  pose,
  project,
  rng,
  type Bird,
  type FittedCanvas,
  type Projected,
} from "@/lib/flock";
import { clamp, cyc, easeInOutCubic, mixHex, mixStops, rad, smoothstep } from "@/lib/motion";

/**
 * Nightfall: a pinned, scroll-scrubbed scene. Progress p runs 0 → 1 over the track. The sky darkens, text flips
 * from ink to bone, and the flock settles bird by bird onto the atlas's stars; the leader and the copies land on
 * the gold meridian. Nothing autoplays: every value is keyed to p (the wingbeat aside).
 */

/** Stage-space geometry of the atlas, shared with the meridian overlay. */
export interface AtlasGeometry {
  W: number;
  H: number;
  cx: number;
  cy: number;
  /** Plate units → px. */
  k: number;
  mobile: boolean;
}

export interface NightfallOptions {
  track: HTMLElement;
  stage: HTMLElement;
  sky: HTMLElement;
  glow: HTMLElement;
  canvas: HTMLCanvasElement;
  reduced: boolean;
  onLayout: (geo: AtlasGeometry) => void;
}

const SKY_TOP = [[0, "#f3e6de"], [0.2, "#dcb9ae"], [0.38, "#8f6662"], [0.54, "#3a2a29"], [0.74, "#15110e"], [1, "#0c0b09"]] as const;
const SKY_BOTTOM = [[0, "#f5ceb0"], [0.2, "#f2b893"], [0.38, "#e39a6d"], [0.54, "#9a5f42"], [0.74, "#2c2019"], [1, "#17130f"]] as const;
const BIRD_INK = [[0, "#2a2124"], [0.3, "#2a2124"], [0.42, "#f0e2c8"], [1, "#e6dfcc"]] as const;
/** Star radius by magnitude (index 1 = brightest). */
const STAR_R = [0, 2.6, 1.9, 1.3, 0.95, 0.65];
/** Past this p every bird has landed: the frame stops changing. */
const SETTLED = 0.88;

interface Target {
  x: number;
  y: number;
  mag: number;
  lead?: boolean;
}

/** Atlas placement in stage px. Mirrors the CSS that places the plate (container units on the stage). */
export function atlasGeometry(W: number, H: number): AtlasGeometry {
  const mobile = W < 760;
  const R = mobile ? Math.min(W * 0.44, H * 0.26) : Math.min(H * 0.4, W * 0.27);
  return { W, H, cx: mobile ? W * 0.5 : W * 0.64, cy: mobile ? H * 0.55 : H * 0.54, k: R / LIMB, mobile };
}

export function startNightfall(opt: NightfallOptions): () => void {
  const { track, stage, sky, glow, canvas, reduced } = opt;
  let C: FittedCanvas;
  let geo: AtlasGeometry;
  let birds: Bird[] = [];
  let targets: Target[] = [];
  let pNow = -1;
  let drawnP = -1;

  function layout() {
    C = fitCanvas(canvas);
    geo = atlasGeometry(C.W, C.H);
    const { cx, cy, k, mobile } = geo;
    const onMeridian = (q: number) => ({ x: cx + LIMB * q * k * Math.cos(MERIDIAN_ANGLE), y: cy + LIMB * q * k * Math.sin(MERIDIAN_ANGLE) });

    birds = formation(mobile ? 950 : 1600, 1717);
    birds[0] = { ...birds[0], s: 0.95, w: 0, t: 0 }; // the leader, at its place on the sheet

    // targets: the leader's star, the copies on the meridian, the constellations, then a field
    const T: Target[] = [{ ...onMeridian(LEADER_AT), mag: 1, lead: true }, ...COPIES_AT.map((q) => ({ ...onMeridian(q), mag: 2 }))];
    for (const c of constellations) for (const [x, y, mag] of c.stars) T.push({ x: cx + x * k, y: cy + y * k, mag });
    const r = rng(424242);
    while (T.length < birds.length) {
      const rr = LIMB * 0.975 * Math.sqrt(0.012 + 0.988 * r());
      const a = r() * 360;
      const mg = r();
      T.push({ x: cx + rr * k * Math.cos(rad(a)), y: cy + rr * k * Math.sin(rad(a)), mag: mg > 0.985 ? 2 : mg > 0.82 ? 3 : mg > 0.5 ? 4 : 5 });
    }

    // the leader → its star, copies → the meridian, the rest by x so the sheet pours onto the chart
    const formationPose = pose({ cx: C.W * (mobile ? 0.5 : 0.62), cy: C.H * 0.34, S: mobile ? C.W * 0.4 : Math.min(C.W * 0.24, 340), twist: 1.3, yaw: 0.05, pitch: 0.05, roll: 0, time: 0 });
    const o: Projected = { x: 0, y: 0, f: 0 };
    const rest = birds.slice(4).map((b, i) => ({ i: i + 4, x: project(b, formationPose, o).x })).sort((a, b) => a.x - b.x);
    const restTargets = T.slice(4).sort((a, b) => a.x - b.x);
    targets = new Array(birds.length);
    for (let i = 0; i < 4; i++) targets[i] = T[i];
    rest.forEach((e, j) => (targets[e.i] = restTargets[j]));

    drawnP = -1;
    opt.onLayout(geo);
  }

  function progress() {
    if (reduced) return 1;
    const r = track.getBoundingClientRect();
    const span = r.height - window.innerHeight;
    return span > 0 ? clamp(-r.top / span) : 1;
  }

  function paintSky(p: number) {
    sky.style.background = `linear-gradient(180deg, ${mixStops(SKY_TOP, p)} 0%, ${mixStops(SKY_BOTTOM, p)} 100%)`;
    const horizon = (1 - smoothstep(0.35, 0.8, p)) * 0.9;
    const ember = smoothstep(0.2, 0.55, p) * (1 - smoothstep(0.6, 0.9, p));
    glow.style.background =
      `radial-gradient(90% 46% at 50% 104%, rgba(246,190,150,${horizon.toFixed(3)}), transparent 72%), ` +
      `radial-gradient(60% 40% at 64% 100%, rgba(202,140,80,${(ember * 0.45).toFixed(3)}), transparent 70%), ` +
      `radial-gradient(42% 36% at 64% 54%, rgba(202,160,99,${(smoothstep(0.7, 1, p) * 0.07).toFixed(3)}), transparent 72%)`;
    const tone = smoothstep(0.3, 0.42, p);
    const labels = smoothstep(0.88, 0.98, p);
    const s = stage.style;
    s.setProperty("--fg", mixHex("#2a2124", "#e6dfcc", tone));
    s.setProperty("--fg-2", mixHex("#55474a", "#cfc7b3", tone));
    s.setProperty("--fg-3", mixHex("#74645f", "#a79e8a", tone));
    s.setProperty("--soft", (100 * (1 - tone)).toFixed(1)); // the display face hardens as night falls
    s.setProperty("--plate-o", smoothstep(0.48, 0.95, p).toFixed(3));
    s.setProperty("--mer-o", smoothstep(0.8, 0.93, p).toFixed(3));
    s.setProperty("--lab-o", labels.toFixed(3));
    s.setProperty("--grain-dusk-o", (0.075 * (1 - tone)).toFixed(3));
    s.setProperty("--grain-night-o", (0.055 * tone).toFixed(3));
    s.setProperty("--dial", p.toFixed(3));
    stage.toggleAttribute("data-read", labels > 0.5);
  }

  function draw(t: number, p: number) {
    const { ctx, W, H } = C;
    const { mobile } = geo;
    ctx.clearRect(0, 0, W, H);
    const ink = mixStops(BIRD_INK, p);
    const k = Math.floor(t / TURN_EVERY);
    const q = easeInOutCubic(Math.min(1, (t - k * TURN_EVERY) / TURN_DURATION));
    const lerp = (A: readonly number[]) => cyc(A, k) + (cyc(A, k + 1) - cyc(A, k)) * q;
    const P = pose({
      cx: W * (mobile ? 0.5 : 0.62) + 10 * Math.sin(t * 0.08),
      cy: H * 0.34 + 6 * Math.sin(t * 0.13),
      S: mobile ? W * 0.4 : Math.min(W * 0.24, 340),
      twist: lerp(TURNS.twist) * 0.9 + 0.15,
      yaw: lerp(TURNS.yaw),
      pitch: 0.05,
      roll: 0,
      time: t,
    });
    const o: Projected = { x: 0, y: 0, f: 0 };
    const chev = [new Path2D(), new Path2D(), new Path2D()];
    const dots = new Path2D();
    const bright: [number, number, number, boolean][] = [];
    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      const T = targets[i];
      project(b, P, o);
      const e = easeInOutCubic(clamp((p - 0.2 - b.j * 0.1) / 0.58));
      const x = o.x + (T.x - o.x) * e;
      const y = o.y + (T.y - o.y) * e;
      const [kk, d] = depthOf(o.f);
      const a = (mobile ? 1.25 : 1.5) * (0.62 + 0.55 * d) * b.k * (1 - e);
      if (a > 0.15) {
        const fl = (0.12 + 0.38 * Math.sin(t * 10.5 * b.k + b.ph)) * (1 - e);
        chev[kk].moveTo(x - a, y - a * fl);
        chev[kk].lineTo(x, y);
        chev[kk].lineTo(x + a, y - a * fl);
      }
      if (e > 0.02) {
        const r = STAR_R[T.mag] * e;
        dots.moveTo(x + r, y);
        dots.arc(x, y, r, 0, 6.2832);
        if (T.mag <= 2 && e > 0.9) bright.push([x, y, T.mag, !!T.lead]);
      }
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = ink;
    DEPTH_BUCKETS.forEach(([alpha, lw], kk) => {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lw * 0.9;
      ctx.stroke(chev[kk]);
    });
    ctx.globalAlpha = 0.55 + 0.45 * smoothstep(0.6, 1, p);
    ctx.fillStyle = ink;
    ctx.fill(dots);
    // bright stars get a cross
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = BONE;
    ctx.lineWidth = 0.8;
    for (const [x, y, mg, lead] of bright) {
      const L = lead ? 11 : mg === 1 ? 9 : 6;
      ctx.beginPath();
      ctx.moveTo(x - L, y);
      ctx.lineTo(x + L, y);
      ctx.moveTo(x, y - L);
      ctx.lineTo(x, y + L);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // the leader keeps its gold ring the whole way down
    project(birds[0], P, o);
    const e0 = easeInOutCubic(clamp((p - 0.2 - birds[0].j * 0.1) / 0.58));
    const lx = o.x + (targets[0].x - o.x) * e0;
    const ly = o.y + (targets[0].y - o.y) * e0;
    if (p < 0.9) {
      ctx.strokeStyle = p < 0.34 ? GOLD_STROKE_DUSK : GOLD;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(lx, ly, 7.5, 0, 6.2832);
      ctx.stroke();
    }
    if (e0 > 0.95) {
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(lx, ly, 4.2, 0, 6.2832);
      ctx.fill();
    }
    drawnP = p;
  }

  /** Repaints for the current scroll position; once everything has landed the frame is skipped. */
  function step(t: number) {
    const p = progress();
    if (Math.abs(p - pNow) > 1e-4) {
      pNow = p;
      paintSky(p);
    }
    if (!(pNow >= SETTLED && drawnP >= SETTLED)) draw(t, pNow);
  }

  // ---------- loop: only while the track is on screen and the tab is visible ----------
  let raf = 0;
  let lastMs: number | null = null;
  let clock = 0;
  let onScreen = false;
  const tick = (ms: number) => {
    const raw = lastMs === null ? 0 : (ms - lastMs) / 1000;
    lastMs = ms;
    clock += Math.min(raw, 0.1);
    step(clock);
    raf = requestAnimationFrame(tick);
  };
  const run = () => {
    const want = !reduced && onScreen && document.visibilityState === "visible";
    if (want && !raf) {
      lastMs = null;
      raf = requestAnimationFrame(tick);
    } else if (!want && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const settle = () => {
    layout();
    pNow = progress();
    paintSky(pNow);
    draw(reduced ? 3 : clock, pNow);
  };
  settle();

  const io = new IntersectionObserver((es) => {
    onScreen = es[es.length - 1].isIntersecting;
    run();
  });
  io.observe(track);
  document.addEventListener("visibilitychange", run);

  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(settle, 150);
  });
  ro.observe(stage);

  return () => {
    cancelAnimationFrame(raf);
    raf = 0;
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("visibilitychange", run);
    window.clearTimeout(resizeTimer);
  };
}

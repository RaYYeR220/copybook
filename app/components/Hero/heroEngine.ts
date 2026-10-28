import {
  GOLD_STROKE_DUSK,
  INK,
  TURN_DURATION,
  TURN_EVERY,
  TURNS,
  drawFlock,
  fitCanvas,
  formation,
  pose,
  project,
  type Bird,
  type FittedCanvas,
  type Pose,
  type PoseInput,
  type Projected,
} from "@/lib/flock";
import { clamp, cyc, easeInOutCubic, smoothstep } from "@/lib/motion";

/**
 * The hero murmuration at dusk.
 *
 * The pointer guides the gold-ringed leader, never the flock. The flock is one rigid sheet posed from the leader's
 * position every frame, so the whole flock turns with it in the same frame: no per-bird physics, no scatter, no lag.
 * Idle for 2 s (or pointer out) and control eases back to the autonomous turn every 6 s. On touch there is no
 * steering; a tap calls one turn. With reduced motion the hero is one static frame.
 */

export interface HeroFlockOptions {
  hero: HTMLElement;
  canvas: HTMLCanvasElement;
  /** The leader's address tag, positioned every frame. */
  tag: HTMLElement;
  /** Class names toggled on the tag. */
  tagClass: { on: string; tuck: string; flip: string };
  reduced: boolean;
  /** Called with the running turn count (0 = still holding the first formation). */
  onTurn: (turn: number) => void;
  onBirds: (count: number) => void;
}

const SEED = 20261028;
const FIRST_TURN = 2.2; // s
const IDLE_MS = 2000; // pointer still this long → hand control back
const ENGAGE = 0.45; // s to take control
const RESUME = 2.4; // s from hand-back to the next own turn
const LEAD = { s: 0.95, w: 0, t: 0 }; // the leader's place on the sheet
const RESOLUTIONS = [1.5, 1.25, 1]; // canvas DPR steps; the governor only ever steps down
const POSE_KEYS = ["cx", "cy", "S", "twist", "yaw", "pitch", "roll"] as const;

type Rect = [left: number, top: number, right: number, bottom: number];
type Span = [left: number, right: number, bottom: number];

export function startHeroFlock(opt: HeroFlockOptions): () => void {
  const { hero, canvas, tag, tagClass, reduced } = opt;
  const mask = document.createElement("canvas");

  let C: FittedCanvas;
  let birds: Bird[] = [];
  let mobile = false;
  let heroTop = 0;
  let heroLeft = 0;
  let tagW = 0;
  let tagH = 0;
  let clearRects: Rect[] = [];
  let guard: Span[] = [];
  let column: { top: number; centre: number; halfWidth: number } | null = null;
  let tucked = false;
  let flipped = false;
  let scrollX = window.scrollX;
  let scrollY = window.scrollY;

  // autonomous turn schedule (event-based, so a tap can call a turn)
  const auto = { k: 0, start: -1e9, next: FIRST_TURN };
  // fine pointer, client coords
  const ptr = { x: 0, y: 0, on: false, last: -1e9 };
  // the guided leader
  const gd = { live: false, x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, yaw: 0, off: 0, yc: 0, tc: 0, over: 0, ly: 0 };
  const lo: Projected = { x: 0, y: 0, f: 0 };
  const L: Projected = { x: 0, y: 0, f: 0 };

  let turnNo = 0;
  let reportedTurn = -1;
  let w = 1; // 0 = guided … 1 = autonomous
  let hairAlpha = 0;
  let clock = 0; // s, advances only while the hero is drawn
  let wasSteering = false;
  let releaseDur = 1.5;

  // frame-budget governor: if frames keep missing 60 fps the canvas steps its resolution down
  let resI = 0;
  let ema = 1 / 60;
  let slow = 0;
  let governFrom = 0;

  function govern(raw: number, t: number) {
    if (t < governFrom || raw <= 0 || raw > 0.12) return; // ignore start-up, tab switches, stalls
    ema += (raw - ema) * 0.08;
    slow = ema > 0.018 ? slow + 1 : 0; // ~0.5 s under 55 fps → one notch down
    if (slow > 30 && resI < RESOLUTIONS.length - 1 && C.dpr > 1) {
      resI++;
      slow = 0;
      ema = 1 / 60;
      governFrom = t + 1;
      C = fitCanvas(canvas, RESOLUTIONS[resI]);
      buildMask();
    }
  }

  function size() {
    C = fitCanvas(canvas, RESOLUTIONS[resI]);
    governFrom = clock + 1.5;
    const wasMobile = mobile;
    mobile = C.W < 760;
    if (!birds.length || wasMobile !== mobile) {
      birds = formation(mobile ? 3200 : 8200, SEED);
      opt.onBirds(birds.length);
    }
    scrollX = window.scrollX;
    scrollY = window.scrollY;
    const r = hero.getBoundingClientRect();
    heroTop = r.top + scrollY;
    heroLeft = r.left + scrollX;
    tagW = tag.offsetWidth;
    tagH = tag.offsetHeight;
    // the guided sheet stays below the nav text
    guard = [...document.querySelectorAll("[data-flock-guard]")].map((el) => {
      const q = el.getBoundingClientRect();
      return [q.left - r.left - 16, q.right - r.left + 16, q.bottom - r.top + 8] as Span;
    });
    buildMask();
  }

  /** Feathered holes around the copy, so the flock never draws over the words. */
  function buildMask() {
    mask.width = canvas.width;
    mask.height = canvas.height;
    const m = mask.getContext("2d")!;
    m.setTransform(C.dpr, 0, 0, C.dpr, 0, 0);
    m.clearRect(0, 0, C.W, C.H);
    m.filter = "blur(14px)";
    m.fillStyle = "#000";
    const hr = hero.getBoundingClientRect();
    const pad = mobile ? 10 : 18;
    clearRects = [];
    column = null;
    hero.querySelectorAll("[data-flock-clear]").forEach((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) {
        if (r.width < 2) continue;
        clearRects.push([r.left - hr.left - 6, r.top - hr.top - 6, r.right - hr.left + 6, r.bottom - hr.top + 6]);
        if (!column || r.top - hr.top < column.top) {
          column = { top: r.top - hr.top, centre: (r.left + r.right) / 2 - hr.left, halfWidth: r.width / 2 };
        }
        m.beginPath();
        const x = r.left - hr.left - pad;
        const y = r.top - hr.top - pad * 0.7;
        if (m.roundRect) m.roundRect(x, y, r.width + pad * 2, r.height + pad * 1.4, 22);
        else m.rect(x, y, r.width + pad * 2, r.height + pad * 1.4);
        m.fill();
      }
    });
  }

  /** Autonomous pose: drift + breathing + a same-frame turn every 6 s, eased over 0.9 s. */
  function autoPose(t: number): Pose {
    if (t >= auto.next) {
      auto.k++;
      auto.start = t;
      auto.next = t + TURN_EVERY;
      turnNo++;
    }
    const k = auto.k;
    const p = k === 0 ? 1 : easeInOutCubic(clamp((t - auto.start) / TURN_DURATION));
    const lerp = (A: readonly number[]) => (k === 0 ? A[0] : cyc(A, k - 1) + (cyc(A, k) - cyc(A, k - 1)) * p);
    const S = mobile ? C.W * 0.43 : Math.min(C.W * 0.335, 490);
    return pose({
      cx: C.W * 0.5 + C.W * (mobile ? 0.008 : 0.016) * Math.sin(t * 0.07),
      cy: (mobile ? 150 : 214) + 7 * Math.sin(t * 0.11 + 1.3),
      S: S * (1 + 0.025 * Math.sin(t * 0.23)),
      twist: lerp(TURNS.twist),
      yaw: lerp(TURNS.yaw),
      pitch: lerp(TURNS.pitch),
      roll: 0.04 * Math.sin(t * 0.09),
      sq: 1,
      time: t,
    });
  }

  const pointerInHero = (): [number, number] => [ptr.x - heroLeft + scrollX, ptr.y - heroTop + scrollY];

  // leader right of centre → yaw 0 (rest) … left → −π (turned round, through the near side)
  const yawFor = (x: number, A: Pose, reach: number) => -Math.acos(clamp((x - A.cx) / reach, -1, 1) * 0.95);

  function startGuide(A: Pose) {
    project(LEAD, A, lo);
    Object.assign(gd, { live: true, x: lo.x, y: lo.y, tx: lo.x, ty: lo.y, vx: 0, vy: 0, yaw: A.yaw, yc: A.yaw, tc: clock, over: 0, ly: lo.y });
    project(LEAD, pose({ ...A, yaw: 0, roll: 0 }), lo);
    gd.off = A.yaw - yawFor(gd.x, A, lo.x - A.cx); // dissolves, so taking control never snaps the sheet
  }

  /**
   * Guided pose: the leader eases toward the pointer (speed-clamped, critically damped); the sheet's yaw is a
   * function of where the leader is, and the sheet is translated so the leader sits exactly on its point.
   */
  function guidedPose(A: Pose, t: number, dt: number, steer: boolean): Pose {
    project(LEAD, pose({ ...A, yaw: 0, roll: 0 }), lo);
    const reach = lo.x - A.cx;
    const restY = lo.y;
    const sn = Math.sin(gd.yaw);
    const S = A.S * (1 - 0.12 * sn * sn); // edge-on, the sheet stands tall: draw it a little smaller
    // vertical is a nudge, the turn is the gesture: the leader stays above the copy and below the nav text
    const side = restY + 0.06 * A.S;
    const floor = column
      ? side + (column.top - 26 - side) * smoothstep(column.halfWidth + 120, column.halfWidth + 20, Math.abs(gd.x - column.centre))
      : side;
    if (steer) {
      const [px, py] = pointerInHero();
      gd.tx = clamp(px, A.cx - reach, A.cx + reach);
      gd.ty = py;
    }
    gd.ty = Math.min(floor, Math.max(gd.ty, restY - 0.2 * A.S, gd.over > 0 ? gd.ly + gd.over : -1e9));
    const vmax = 1.1 * S;
    const TP = 0.34;
    const TV = 0.085;
    let vx = (gd.tx - gd.x) / TP;
    let vy = (gd.ty - gd.y) / TP;
    const sp = Math.hypot(vx, vy);
    if (sp > vmax) {
      vx *= vmax / sp;
      vy *= vmax / sp;
    }
    const a = 1 - Math.exp(-dt / TV);
    gd.vx += (vx - gd.vx) * a;
    gd.vy += (vy - gd.vy) * a;
    gd.x += gd.vx * dt;
    gd.y += gd.vy * dt;
    gd.off *= Math.exp(-dt / 1.2);
    const yawTarget = yawFor(gd.x, A, reach) + gd.off;
    const maxRate = 2.4 * dt;
    gd.yaw += clamp((yawTarget - gd.yaw) * (1 - Math.exp(-dt / 0.16)), -maxRate, maxRate);
    if (Math.abs(gd.yaw - gd.yc) > 1 && t - gd.tc > 1.2) {
      gd.yc = gd.yaw;
      gd.tc = t;
      turnNo++; // a guided turn is a turn too
    }
    const bank = clamp(gd.vx / vmax, -1, 1);
    const climb = clamp(gd.vy / vmax, -1, 1);
    // pitch mirrors with the turn, so the turned-round sheet keeps the resting silhouette
    const P = pose({
      cx: 0,
      cy: 0,
      S,
      twist: A.twist,
      yaw: gd.yaw,
      pitch: A.pitch * Math.cos(gd.yaw) + 0.08 * climb,
      roll: (A.roll ?? 0) + 0.06 * bank,
      sq: 1,
      time: t,
    });
    project(LEAD, P, lo);
    P.cx = gd.x - lo.x;
    P.cy = gd.y - lo.y;
    return P;
  }

  function mixPose(A: Pose, B: Pose, k: number): Pose {
    const o: PoseInput = { cx: 0, cy: 0, S: 0, twist: 0, yaw: 0, pitch: 0, roll: 0, sq: 1, time: A.time };
    for (const q of POSE_KEYS) o[q] = (A[q] ?? 0) + ((B[q] ?? 0) - (A[q] ?? 0)) * k;
    return pose(o);
  }

  function frame(t: number, raw: number) {
    const dt = clamp(raw, 0, 1 / 30);
    if (!reduced) govern(raw, t);
    const steer = !reduced && ptr.on && performance.now() - ptr.last < IDLE_MS;
    if (steer || w < 1) auto.next = Math.max(auto.next, t + RESUME); // no own turns while guided
    const A = autoPose(t);
    if (steer && !gd.live) startGuide(A);
    if (wasSteering && !steer && gd.live) releaseDur = clamp(1.2 + 0.6 * Math.abs(gd.yaw - A.yaw), 1.2, 3.2); // a wider turn hands back more slowly
    wasSteering = steer;
    w = steer ? Math.max(0, w - dt / ENGAGE) : Math.min(1, w + dt / releaseDur);
    hairAlpha += ((steer ? 1 : 0) - hairAlpha) * (1 - Math.exp(-dt / 0.18));

    let P = A;
    if (gd.live) {
      const G = guidedPose(A, t, dt, steer);
      P = w > 0 ? mixPose(G, A, smoothstep(0, 1, w)) : G;
      if (w >= 1) gd.live = false;
    }

    const { ctx, W, H } = C;
    ctx.clearRect(0, 0, W, H);
    const over = drawFlock(ctx, birds, P, {
      W,
      H,
      size: mobile ? 1.15 : 1.38,
      lineWidth: mobile ? 0.8 : 0.92,
      color: INK,
      guard: gd.live ? guard : null,
    });
    project(LEAD, P, L);
    if (gd.live) {
      gd.over = over;
      gd.ly = L.y;
    }

    // a hairline from the pointer to the leader: you move the leader, the flock moves with it
    if (hairAlpha > 0.02) {
      const [px, py] = pointerInHero();
      const dx = px - L.x;
      const dy = py - L.y;
      const d = Math.hypot(dx, dy);
      const al = hairAlpha * 0.7 * clamp((d - 16) / 40);
      if (al > 0.01) {
        ctx.globalAlpha = al;
        ctx.strokeStyle = GOLD_STROKE_DUSK;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(L.x + (dx / d) * 10, L.y + (dy / d) * 10);
        ctx.lineTo(px - (dx / d) * 4, py - (dy / d) * 4);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(mask, 0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";

    // the leader stays marked even near the text
    ctx.strokeStyle = GOLD_STROKE_DUSK;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(L.x, L.y, mobile ? 6 : 7.5, 0, 6.2832);
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(L.x, L.y, 1.4, 0, 6.2832);
    ctx.fill();

    // the tag rides on the leader's open side and never sits on the copy
    const flip = mobile || (flipped ? L.x < W * 0.55 : L.x < W * 0.45);
    if (flip !== flipped) {
      flipped = flip;
      tag.classList.toggle(tagClass.flip, flip);
    }
    const lx = mobile ? L.x - tagW - 10 : flipped ? L.x - tagW - 8 : L.x + 8;
    const ly = mobile ? L.y + 10 : L.y - 10;
    tag.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
    const onCopy = gd.live && clearRects.some((r) => lx < r[2] && lx + tagW > r[0] && ly < r[3] && ly + tagH > r[1]);
    if (onCopy !== tucked) {
      tucked = onCopy;
      tag.classList.toggle(tagClass.tuck, onCopy);
    }

    if (turnNo !== reportedTurn) {
      reportedTurn = turnNo;
      opt.onTurn(turnNo);
    }
  }

  function drawStatic() {
    auto.k = 1;
    auto.start = -1e9;
    auto.next = Infinity;
    turnNo = 1;
    frame(FIRST_TURN + TURN_DURATION + 0.5, 0);
  }

  // ---------- loop: runs only while the hero is on screen and the tab is visible ----------
  let raf = 0;
  let lastMs: number | null = null;
  let onScreen = true;
  const tick = (ms: number) => {
    const raw = lastMs === null ? 0 : (ms - lastMs) / 1000;
    lastMs = ms;
    clock += Math.min(raw, 0.1);
    frame(clock, raw);
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

  size();
  if (reduced) drawStatic();
  else frame(0, 0);

  const io = new IntersectionObserver((es) => {
    onScreen = es[es.length - 1].isIntersecting;
    run();
  });
  io.observe(hero);
  document.addEventListener("visibilitychange", run);

  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      size();
      if (reduced) drawStatic();
    }, 150);
  });
  ro.observe(hero);

  let maskTimer = 0;
  let alive = true;
  document.fonts?.ready.then(() => {
    if (!alive) return;
    size();
    if (reduced) drawStatic();
    maskTimer = window.setTimeout(buildMask, 1000); // after the entrance has settled the copy
  });

  const tagTimer = window.setTimeout(() => tag.classList.add(tagClass.on), reduced ? 0 : 900);

  const onScroll = () => {
    scrollX = window.scrollX;
    scrollY = window.scrollY;
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    ptr.on = true;
    ptr.last = performance.now();
  };
  const onLeave = () => {
    ptr.on = false;
  };
  // touch: no steering; a quick tap off the links calls one turn
  let tap: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => {
    tap = e.pointerType === "touch" && !(e.target as Element).closest("a,button") ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  };
  const onUp = (e: PointerEvent) => {
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10 && e.timeStamp - tap.t < 400 && !gd.live && clock - auto.start > TURN_DURATION) {
      auto.next = clock;
    }
    tap = null;
  };
  const onCancel = () => {
    tap = null;
  };

  if (!reduced) {
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("blur", onLeave);
    hero.addEventListener("pointermove", onMove);
    hero.addEventListener("pointerleave", onLeave);
    hero.addEventListener("pointerdown", onDown);
    hero.addEventListener("pointerup", onUp);
    hero.addEventListener("pointercancel", onCancel);
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    raf = 0;
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("visibilitychange", run);
    window.clearTimeout(resizeTimer);
    window.clearTimeout(maskTimer);
    window.clearTimeout(tagTimer);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("blur", onLeave);
    hero.removeEventListener("pointermove", onMove);
    hero.removeEventListener("pointerleave", onLeave);
    hero.removeEventListener("pointerdown", onDown);
    hero.removeEventListener("pointerup", onUp);
    hero.removeEventListener("pointercancel", onCancel);
    tag.classList.remove(tagClass.on, tagClass.tuck, tagClass.flip);
  };
}

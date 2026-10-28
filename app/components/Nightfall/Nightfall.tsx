"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { COPIES_AT, LEADER_AT, LIMB, MERIDIAN_ANGLE } from "@/lib/atlas";
import { f1, prefersReducedMotion } from "@/lib/motion";
import { startNightfall, type AtlasGeometry } from "./nightEngine";
import styles from "./Nightfall.module.css";

export interface MeridianLabel {
  title: string;
  detail: string;
  /** Set in gold after the detail. */
  mark?: string;
}

/** The gold meridian in stage px: the leader's ring, the copies, and their labels. */
function Meridian({ geo, leader, copy }: { geo: AtlasGeometry; leader: MeridianLabel; copy: MeridianLabel }) {
  const { cx, cy, k, mobile, W, H } = geo;
  const at = (q: number): [number, number] => [cx + LIMB * q * k * Math.cos(MERIDIAN_ANGLE), cy + LIMB * q * k * Math.sin(MERIDIAN_ANGLE)];
  const [ax, ay] = at(0.46);
  const [bx, by] = at(0.6);
  const [lx, ly] = at(1.06);
  const [l2x, l2y] = at(1.16);
  const [Lx, Ly] = at(LEADER_AT);
  const [Cx, Cy] = at(0.73);
  const nx = -Math.sin(MERIDIAN_ANGLE);
  const ny = Math.cos(MERIDIAN_ANGLE);
  // labels sit on the meridian's outer side; on a narrow stage that runs off the edge, so they flip inward
  const side = mobile ? -1 : 1;
  const label = (x: number, y: number, off: number, l: MeridianLabel) => {
    const X = f1(x + nx * off * side);
    const Y = y + ny * off * side + 4 - (mobile ? 15 : 0);
    return (
      <text className={styles.lab} textAnchor={mobile ? "end" : "start"}>
        <tspan x={X} y={f1(Y)}>
          {l.title}
        </tspan>
        <tspan className={styles.labDim} x={X} y={f1(Y + 15)}>
          {l.detail}
          {l.mark && (
            <>
              {" · "}
              <tspan className={styles.labGold}>{l.mark}</tspan>
            </>
          )}
        </tspan>
      </text>
    );
  };
  return (
    <svg className={styles.meridian} viewBox={`0 0 ${f1(W)} ${f1(H)}`} aria-hidden="true">
      <g className={styles.merLines}>
        <line className={styles.md} x1={f1(ax)} y1={f1(ay)} x2={f1(bx)} y2={f1(by)} />
        <line className={styles.ml} x1={f1(bx)} y1={f1(by)} x2={f1(lx)} y2={f1(ly)} />
        <line className={styles.ml} strokeWidth="2.2" x1={f1(lx)} y1={f1(ly)} x2={f1(l2x)} y2={f1(l2y)} />
        <circle className={styles.lr} cx={f1(Lx)} cy={f1(Ly)} r={mobile ? 11 : 14} />
        <circle className={styles.lr} opacity=".3" cx={f1(Lx)} cy={f1(Ly)} r={mobile ? 18 : 24} />
        {COPIES_AT.map((q) => {
          const [x, y] = at(q);
          return <circle key={q} className={styles.cr} cx={f1(x)} cy={f1(y)} r={mobile ? 6 : 8} />;
        })}
      </g>
      <g className={styles.merLabels}>
        {label(Lx, Ly, mobile ? 18 : 26, leader)}
        {label(Cx, Cy, mobile ? 14 : 20, copy)}
      </g>
    </svg>
  );
}

interface NightfallSceneProps {
  /** The engraved atlas (server-rendered). */
  plate: ReactNode;
  /** Kicker, headline and intro. */
  head: ReactNode;
  /** The ephemeris read off the chain, shown once night has fallen. */
  readout: ReactNode;
  leaderLabel: MeridianLabel;
  copyLabel: MeridianLabel;
  labelledBy: string;
}

/** The pinned nightfall: a tall track with a sticky stage, scrubbed by scroll. */
export function NightfallScene({ plate, head, readout, leaderLabel, copyLabel, labelledBy }: NightfallSceneProps) {
  const track = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const sky = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [geo, setGeo] = useState<AtlasGeometry | null>(null);

  useEffect(() => {
    if (!track.current || !stage.current || !sky.current || !glow.current || !canvas.current) return;
    const els = { track: track.current, stage: stage.current, sky: sky.current, glow: glow.current, canvas: canvas.current };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stop = () => {};
    const start = () => {
      stop();
      stop = startNightfall({ ...els, reduced: prefersReducedMotion(), onLayout: setGeo });
    };
    start();
    motion.addEventListener("change", start);
    return () => {
      motion.removeEventListener("change", start);
      stop();
    };
  }, []);

  return (
    <section ref={track} className={styles.track} id="proof" aria-labelledby={labelledBy}>
      <div ref={stage} className={styles.stage}>
        <div ref={sky} className={styles.sky} aria-hidden="true" />
        <div ref={glow} className={styles.glow} aria-hidden="true" />
        <div className={styles.plate}>{plate}</div>
        <canvas ref={canvas} className={styles.settle} aria-hidden="true" />
        {geo && <Meridian geo={geo} leader={leaderLabel} copy={copyLabel} />}
        <div className={styles.head}>{head}</div>
        <div className={styles.read}>{readout}</div>
        <div className={styles.dial} aria-hidden="true">
          <span>Dusk</span>
          <span className={styles.bar}>
            <i />
          </span>
          <span>Night</span>
        </div>
        <div className={`grain grain-dusk ${styles.grainDusk}`} aria-hidden="true" />
        <div className={`grain grain-night ${styles.grainNight}`} aria-hidden="true" />
      </div>
    </section>
  );
}

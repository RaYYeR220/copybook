"use client";

import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/motion";
import { useFlockStore } from "./FlockState";
import { startHeroFlock } from "./heroEngine";
import styles from "./Hero.module.css";

/**
 * The hero canvas and the leader's tag. Mount inside the element marked `data-hero`; the copy it keeps clear of is
 * marked `data-flock-clear`, the nav text it stays below `data-flock-guard`.
 */
export function Flock({ leaderLabel }: { leaderLabel: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const store = useFlockStore();

  useEffect(() => {
    const cv = canvas.current;
    const tg = tag.current;
    const hero = cv?.closest<HTMLElement>("[data-hero]");
    if (!cv || !tg || !hero) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stop = () => {};
    const start = () => {
      stop();
      stop = startHeroFlock({
        hero,
        canvas: cv,
        tag: tg,
        tagClass: { on: styles.tagOn, tuck: styles.tagTuck, flip: styles.tagFlip },
        reduced: prefersReducedMotion(),
        onTurn: (turn) => store.set({ turn }),
        onBirds: (birds) => store.set({ birds }),
      });
    };
    start();
    motion.addEventListener("change", start);
    return () => {
      motion.removeEventListener("change", start);
      stop();
    };
  }, [store]);

  return (
    <>
      <canvas ref={canvas} className={styles.flock} aria-hidden="true" />
      <div ref={tag} className={styles.tag} aria-hidden="true">
        <span>{leaderLabel}</span>
      </div>
    </>
  );
}

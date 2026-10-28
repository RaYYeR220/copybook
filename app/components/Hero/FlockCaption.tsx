"use client";

import { useEffect, useState } from "react";
import { fmtInt } from "@/lib/format";
import { useFlockState } from "./FlockState";
import styles from "./Hero.module.css";

/** "Fig. 1": the figure caption under the hero, counting the flock's turns. */
export function FlockCaption() {
  const { turn, birds } = useFlockState();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (turn === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1400);
    return () => window.clearTimeout(t);
  }, [turn]);

  return (
    <p>
      Fig. 1 — dusk · <b>{turn ? `turn ${String(turn).padStart(2, "0")}` : "holding formation"}</b> ·{" "}
      {birds === null ? (
        <>
          <span className={styles.wide}>8,200</span>
          <span className={styles.narrow}>3,200</span>
        </>
      ) : (
        fmtInt(birds)
      )}{" "}
      birds · <span className={`${styles.frameNote} ${flash ? styles.flash : ""}`}>{turn ? "same frame" : "one formation"}</span>
    </p>
  );
}

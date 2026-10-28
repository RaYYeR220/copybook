import type { ReactNode } from "react";
import styles from "./Stat.module.css";

/**
 * A display numeral under a mono label (Your PnL · Source, scaled · Tracking error).
 * Figures are never coloured for gain or loss; the sign carries the meaning.
 */
export function Stat({ label, value, align = "start" }: { label: ReactNode; value: ReactNode; align?: "start" | "end" }) {
  return (
    <div className={`${styles.stat} ${align === "end" ? styles.end : ""}`}>
      <span className={styles.label}>{label}</span>
      <b className={styles.value}>{value}</b>
    </div>
  );
}

/** A row of stats; the last one can sit at the far end. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className={styles.row}>{children}</div>;
}

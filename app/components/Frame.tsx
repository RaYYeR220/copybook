import type { ReactNode } from "react";
import styles from "./Frame.module.css";

/**
 * A night plate: square corners, a double rule (1px outside, 1px inset 5px), and tabs set into the top rule.
 * The right tab hides on narrow screens.
 */
export function Frame({ tab, tabEnd, className, children }: { tab: ReactNode; tabEnd?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={[styles.frame, className].filter(Boolean).join(" ")}>
      <span className={styles.tab}>{tab}</span>
      {tabEnd && <span className={`${styles.tab} ${styles.end}`}>{tabEnd}</span>}
      {children}
    </div>
  );
}

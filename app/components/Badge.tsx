import type { ReactNode } from "react";
import styles from "./Badge.module.css";

type Tone = "gold" | "refused" | "verdict";

/**
 * A status pill. `gold` is the same-block badge, `refused` the dashed pill for refusals and pauses,
 * `verdict` the solid hairline pill for on-chain verdicts.
 */
export function Badge({ tone = "gold", icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

/** The 28px circular ↗ link that pairs with every badge. `label` names what opens. */
export function ExplorerLink({ href, label }: { href: string; label: string }) {
  return (
    <a className={styles.ext} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

import type { ReactNode } from "react";
import styles from "./SourceHead.module.css";

/**
 * The source panel's top line: a kicker left, a status step right (gold dot when live, a ring otherwise).
 * `stepNode` replaces the step with a component that draws its own (a live follower count).
 */
export function SourceTop({ kick, step, quiet = false, stepNode }: { kick: ReactNode; step?: ReactNode; quiet?: boolean; stepNode?: ReactNode }) {
  return (
    <div className={styles.top}>
      <span className={styles.kick}>{kick}</span>
      {stepNode ??
        (step && (
          <span className={`${styles.step} ${quiet ? styles.quiet : ""}`}>
            <i aria-hidden="true" />
            {step}
          </span>
        ))}
    </div>
  );
}

/** The page's one H1: the source's name in the display face. `address` sets a long hex name a size down. */
export const SourceTitle = ({ children, address = false, id }: { children: ReactNode; address?: boolean; id?: string }) => (
  <h1 id={id} className={`${styles.h1} ${address ? styles.addr : ""}`}>
    {children}
  </h1>
);

export const SourceLine = ({ children }: { children: ReactNode }) => <p className={styles.line}>{children}</p>;
export const SourceLead = ({ children }: { children: ReactNode }) => <p className={styles.lead}>{children}</p>;
export const SourceLedger = ({ children }: { children: ReactNode }) => <div className={styles.ledger}>{children}</div>;
export const SourceActs = ({ children }: { children: ReactNode }) => <div className={styles.acts}>{children}</div>;

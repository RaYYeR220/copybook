import type { ReactNode } from "react";
import styles from "./State.module.css";

export type StateKind = "loading" | "empty" | "unavailable";

/**
 * An explicit data state. Loading, nothing there, and a source that did not answer are three different things, and
 * each says which source it is about ("the indexer did not answer" is never shown as "no trades").
 */
export function DataState({ kind, title, children }: { kind: StateKind; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={`${styles.state} ${styles[kind]}`} role="status" data-state={kind}>
      <span className={styles.mark} aria-hidden="true" />
      <div>
        <p className={styles.title}>{title}</p>
        {children && <p className={styles.detail}>{children}</p>}
      </div>
    </div>
  );
}

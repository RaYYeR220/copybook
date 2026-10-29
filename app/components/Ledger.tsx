import type { ReactNode } from "react";
import styles from "./Ledger.module.css";

export interface LedgerRow {
  label: string;
  value: ReactNode;
  /** A quiet mono line under the row. */
  note?: ReactNode;
}

/**
 * An ephemeris: italic display labels, a dotted leader, mono values. `lg` is the landing's reading (21px labels),
 * `md` the app's policy ledger (17px).
 */
export function Ledger({ rows, size = "lg", className }: { rows: LedgerRow[]; size?: "lg" | "md"; className?: string }) {
  return (
    <dl className={[styles.ledger, styles[size], className].filter(Boolean).join(" ")}>
      {rows.map((r) => (
        // dt and dd sit directly in the group (a dl allows nothing else); the dotted leader is the group's ::before
        <div key={r.label} className={styles.group}>
          <dt className={styles.label}>{r.label}</dt>
          <dd className={styles.value}>{r.value}</dd>
          {r.note && <dd className={styles.note}>{r.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Gold inside a ledger value: the same-block delta, the AI guard. */
export const Gold = ({ children }: { children: ReactNode }) => <span className={styles.gold}>{children}</span>;

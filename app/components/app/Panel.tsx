import type { CSSProperties, ReactNode } from "react";
import { delay } from "@/lib/style";
import styles from "./Panel.module.css";

/** The page grid: a 400px column and a fluid one; one column below 1180px. */
export const AppMain = ({ children, label }: { children: ReactNode; label?: string }) => (
  <main id="main" className={styles.wrap} aria-label={label}>
    {children}
  </main>
);

export const Col = ({ children }: { children: ReactNode }) => <div className={styles.col}>{children}</div>;

interface PanelProps {
  /** The panel's heading id; its h2 is labelled by it. */
  id: string;
  title?: ReactNode;
  /** The mono kicker or meta at the right of the header. */
  aside?: ReactNode;
  /** Order on phones, where both columns fold into one. */
  order?: number;
  /** Entrance delay, seconds. */
  d?: number;
  className?: string;
  children: ReactNode;
}

/** A square panel on a hairline, with an optional header: display H2 left, mono kicker right. */
export function Panel({ id, title, aside, order, d = 0, className, children }: PanelProps) {
  const style = { ...delay(d), ...(order ? { "--order": order } : {}) } as CSSProperties;
  return (
    <section className={[styles.panel, "rise", className].filter(Boolean).join(" ")} style={style} aria-labelledby={id}>
      {title && (
        <div className={styles.ph}>
          <h2 id={id} className={styles.h2}>
            {title}
          </h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export const Kick = ({ children }: { children: ReactNode }) => <span className={styles.kick}>{children}</span>;
export const Meta = ({ children }: { children: ReactNode }) => <span className={styles.meta}>{children}</span>;
/** Hidden on phones, where the header stacks. */
export const Wide = ({ children }: { children: ReactNode }) => <span className={styles.wide}>{children}</span>;
export const PanelBody = ({ children }: { children: ReactNode }) => <div className={styles.body}>{children}</div>;
export const PanelNote = ({ children }: { children: ReactNode }) => <p className={styles.note}>{children}</p>;
export const Colophon = ({ children }: { children: ReactNode }) => (
  <p className={`${styles.colophon} rise`} style={delay(0.2)}>
    {children}
  </p>
);

import styles from "./Hairline.module.css";

/** A 1px rule in the current tone. Hairlines, not shadows, separate things. */
export function Hairline({ strength = 1, className }: { strength?: 1 | 2 | 3; className?: string }) {
  return <hr className={[styles.rule, styles[`s${strength}`], className].filter(Boolean).join(" ")} />;
}

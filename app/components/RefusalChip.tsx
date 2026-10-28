import { REASON_LABEL, type RefusalReason } from "@/lib/reasons";
import styles from "./RefusalChip.module.css";

/**
 * A refusal, shown by shape: a dashed pill with a dashed hollow dot and the reason's name.
 * The AI guard's chip has a solid gold-line border. A reason with a zero count drops to night-3.
 */
export function RefusalChip({ reason, zero = false, size = "md" }: { reason: RefusalReason; zero?: boolean; size?: "md" | "sm" }) {
  const cls = [styles.chip, styles[size], reason === "RiskGate" && styles.ai, zero && styles.zero].filter(Boolean).join(" ");
  return <span className={cls}>{REASON_LABEL[reason]}</span>;
}

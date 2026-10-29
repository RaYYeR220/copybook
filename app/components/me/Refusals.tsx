import { RefusalChip } from "@/components/RefusalChip";
import { PanelNote } from "@/components/app/Panel";
import type { ReasonName } from "@copybook/sdk";
import styles from "./Me.module.css";

/** Refusals by reason since the follow began, every one a Refused event with its reason. Zero counts stay listed, dimmed. */
export function Refusals({ counts }: { counts: { reason: ReasonName; n: number }[] }) {
  return (
    <>
      <ul className={styles.reasons}>
        {counts.map((c) => (
          <li key={c.reason} className={c.n === 0 ? styles.zero : undefined}>
            <RefusalChip reason={c.reason === "None" ? "VenueRejected" : c.reason} zero={c.n === 0} size="sm" />
            <span className={styles.n}>{c.n}</span>
          </li>
        ))}
      </ul>
      <PanelNote>A refusal stops an opening, never a closing. Each one is a Refused event with its reason, in the feed above.</PanelNote>
    </>
  );
}

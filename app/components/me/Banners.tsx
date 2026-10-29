"use client";

import type { Copybook } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { TxLine } from "@/components/follow/parts";
import { txFor, type useTx } from "@/components/follow/hooks";
import { IDLE } from "@/lib/follow/tx";
import type { Banner, Call } from "@/lib/me/issues";
import styles from "./Me.module.css";

const KIND: Record<Banner["severity"], string> = { error: "Stuck", warning: "Needs a call", info: "Note" };

/** Sends a banner's call through the SDK (gas estimate first, so a call that would revert says why). */
export function sendCall(cb: Copybook, c: Call) {
  switch (c.method) {
    case "resume":
      return cb.resume();
    case "poke":
      return cb.poke(c.args[0] as `0x${string}`);
    case "catchUp":
      return cb.catchUp(c.args[0] as `0x${string}`, (c.args[1] as `0x${string}`[]) ?? []);
    case "resync":
      return cb.resync();
    case "fundTank":
      return cb.fundTank(c.value ?? 0n);
    case "setGuard":
      return cb.setGuard(Boolean(c.args[0]));
    case "approveOperator":
      return cb.approveOperator(Boolean(c.args[0]));
  }
}

/**
 * Every stuck state the chain shows, each with the exact call that clears it. The first one with a call (never an
 * info) is offered when the dashboard opens: it is set apart and its button is the page's primary action. Nothing
 * is sent until the button is pressed.
 */
export function Banners({
  banners,
  offer,
  writer,
  tx,
  onFixPolicy,
}: {
  banners: readonly Banner[];
  offer?: Banner;
  writer: () => Copybook;
  tx: ReturnType<typeof useTx>;
  onFixPolicy: () => void;
}) {
  if (banners.length === 0) return null;
  return (
    <section className={styles.banners} aria-label="What this follow needs">
      {banners.map((b) => {
        const offered = b === offer;
        const action = b.call ? `banner:${b.code}` : "";
        const mine = b.call ? txFor(tx, [action]) : IDLE;
        return (
          <div key={b.code} className={`${styles.banner} ${styles[b.severity]} ${offered ? styles.offer : ""}`} data-issue={b.code} role={b.severity === "error" ? "alert" : undefined}>
            <span className={styles.bmark} aria-hidden="true" />
            <div className={styles.bbody}>
              <p className={styles.bkind}>{offered ? `${KIND[b.severity]} · offered now, sent only if you press it` : KIND[b.severity]}</p>
              <p className={styles.btext}>{b.message}</p>
              {b.call && (
                <code className={styles.bcall} aria-label="The call that clears it">
                  {b.call.text}
                </code>
              )}
              {b.call && <TxLine tx={mine} recalled={tx.recalled} />}
            </div>
            <div className={styles.bacts}>
              {b.call && (
                <Button size="md" variant={offered ? "primary" : "secondary"} disabled={tx.busy} onClick={() => tx.run(action, () => sendCall(writer(), b.call!))}>
                  {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : b.call.label}
                </Button>
              )}
              {b.fix === "policy-or-margin" && (
                <Button size="md" variant="secondary" onClick={onFixPolicy}>
                  Lower the floor
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

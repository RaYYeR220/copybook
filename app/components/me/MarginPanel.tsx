"use client";

import { useState } from "react";
import type { Address } from "viem";
import type { Copybook, MarginFunding } from "@copybook/sdk";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { PanelNote } from "@/components/app/Panel";
import { FundsHelp, MOVE_ACTIONS, MoveUsdso } from "@/components/follow/MoveUsdso";
import { txFor, type useTx } from "@/components/follow/hooks";
import { suggestedDeposit, type MarginTarget } from "@/lib/follow/margin";
import { fmtUsd18, fmtUsdso } from "@/lib/units";
import styles from "./Me.module.css";

/**
 * The wallet's dreamDEX perps account: its equity, the USDso still on spot, and the move from one to the other
 * (approve, then deposit). With no USDso anywhere it says where testnet funds come from.
 */
export function MarginPanel({
  equity,
  funding,
  target,
  bank,
  writer,
  tx,
}: {
  /** null when the margin bank did not answer. */
  equity: bigint | null;
  /** null when the token did not answer. */
  funding: MarginFunding | null;
  /** A following wallet: the margin its own policy suggests. */
  target?: MarginTarget;
  bank: Address;
  writer: () => Copybook;
  tx: ReturnType<typeof useTx>;
}) {
  const spot = funding?.spot ?? null;
  // open from the start when the account is empty, an approval is waiting for its deposit, or a move is in flight
  const inFlight = txFor(tx, MOVE_ACTIONS).phase !== "idle";
  const [open, setOpen] = useState(() => (equity !== null && equity <= 0n) || (funding?.allowance ?? 0n) > 0n);
  const rows: LedgerRow[] = [
    { label: "Perps equity", value: <b>{equity !== null ? fmtUsd18(equity) : "unread"}</b>, note: equity === null ? "the margin bank did not answer" : undefined },
    { label: "USDso on spot", value: spot !== null ? fmtUsdso(spot) : "unread", note: spot !== null && spot > 0n ? "in the wallet, outside the perps account" : undefined },
  ];
  if (target)
    rows.push({
      label: "Suggested",
      value: fmtUsd18(target.amount),
      note: target.basis === "trader-cap" ? "one position at your cap per position, held without leverage" : "your basket at your allocation, held without leverage",
    });
  return (
    <>
      <div className={styles.ledger}>
        <Ledger size="md" rows={rows} />
      </div>
      <div className={styles.marginBody}>
        {spot === null ? (
          <p className={styles.dlead}>This wallet&apos;s USDso could not be read, so nothing is offered. The panel reads it again with the rest of the page.</p>
        ) : spot === 0n ? (
          <FundsHelp />
        ) : open || inFlight ? (
          <MoveUsdso id="me-move-usdso" spot={spot} allowance={funding?.allowance ?? null} initial={suggestedDeposit(equity, target?.amount, spot)} bank={bank} writer={writer} tx={tx} />
        ) : (
          <button type="button" className={styles.link} onClick={() => setOpen(true)}>
            Move USDso into your perps account
          </button>
        )}
      </div>
      <PanelNote>
        Copies are orders in this account, so the venue refuses the ones it cannot margin. Moving USDso back to spot is done on dreamDEX (Perps ⇆ Spot).
      </PanelNote>
    </>
  );
}

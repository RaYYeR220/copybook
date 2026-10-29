"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { Copybook } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { FUNDS_X_HANDLE, FUNDS_X_URL, VOUCHER_REPORT_URL } from "@/content/site";
import { checkMove, usdsoInput } from "@/lib/follow/margin";
import { shortHex } from "@/lib/format";
import { fmtUsdso } from "@/lib/units";
import { txFor, type useTx } from "./hooks";
import { Acts, Call, Field, TxLine } from "./parts";
import styles from "./Flow.module.css";

/** The two transactions of a move, as `useTx` names them. */
export const MOVE_ACTIONS = ["approveMargin", "depositMargin"] as const;

/** A wallet with no USDso on spot: where testnet funds come from, and why not the venue's voucher. */
export function FundsHelp() {
  return (
    <div className={styles.funds} data-funds="">
      <p className={styles.lead}>
        No USDso on spot in this wallet. Message{" "}
        <a className="lnk" href={FUNDS_X_URL} target="_blank" rel="noopener noreferrer">
          {FUNDS_X_HANDLE}
        </a>{" "}
        on X with your Hideki address and we send STT + USDso.
      </p>
      <p className={styles.help}>
        dreamDEX&apos;s perps voucher cannot be claimed from a wallet on Hideki right now:{" "}
        <a className="lnk" href={VOUCHER_REPORT_URL} target="_blank" rel="noopener noreferrer">
          the report ↗
        </a>
      </p>
    </div>
  );
}

interface Props {
  /** USDso in the wallet, outside the perps account. Above zero: with none, show `FundsHelp` instead. */
  spot: bigint;
  /** What the margin bank may pull now; null when unread (an approval is then offered first). */
  allowance: bigint | null;
  /** The amount the form starts at. */
  initial: bigint;
  bank: Address;
  writer: () => Copybook;
  tx: ReturnType<typeof useTx>;
  /** The amount input's id, unique on the page. */
  id: string;
}

/**
 * Moves spot USDso into the wallet's dreamDEX perps account: an approval of the margin bank for exactly the amount,
 * then `deposit` on the bank, as dreamDEX's own SDK does it. Which one comes next is read from the chain (the bank's
 * allowance), so after a reload, or once the approval lands, the form offers the deposit.
 */
export function MoveUsdso({ spot, allowance, initial, bank, writer, tx, id }: Props) {
  const [typed, setTyped] = useState(() => usdsoInput(initial));
  // a new suggestion from the chain (a deposit landed, a balance changed) replaces the typed amount
  useEffect(() => setTyped(usdsoInput(initial)), [initial]);
  const check = checkMove(typed, spot, allowance);
  const mine = txFor(tx, MOVE_ACTIONS);
  const amount = check.ok ? fmtUsdso(check.amount) : "USDso";
  const send = () => {
    if (!check.ok) return;
    const a = check.amount;
    if (check.next === "approve") void tx.run("approveMargin", () => writer().approveMargin(a));
    else void tx.run("depositMargin", () => writer().depositMargin(a));
  };
  const covered = allowance !== null && allowance > 0n;
  return (
    <div className={styles.move} data-move={check.ok ? check.next : "invalid"}>
      <div className={styles.fields}>
        <Field
          id={id}
          label="Move into perps"
          value={typed}
          onChange={setTyped}
          suffix="USDso"
          error={check.ok ? undefined : check.problem}
          help={
            <>
              This wallet holds {fmtUsdso(spot)} on spot
              {covered ? `; the margin bank may already pull ${fmtUsdso(allowance)}` : ""}.{" "}
              <button type="button" className={styles.apply} onClick={() => setTyped(usdsoInput(spot))}>
                All {fmtUsdso(spot)}
              </button>
            </>
          }
        />
      </div>
      <ol className={styles.moveSteps} aria-label="The two transactions">
        <li data-state={check.ok ? (check.next === "approve" ? "current" : "done") : "todo"}>
          <span>
            <b>Approve</b> dreamDEX&apos;s margin bank to pull {amount} from this wallet{check.ok && check.next === "deposit" ? ": in place" : ""}
          </span>
        </li>
        <li data-state={check.ok && check.next === "deposit" ? "current" : "todo"}>
          <span>
            <b>Deposit</b> {amount} into this wallet&apos;s perps account: equity rises by it
          </span>
        </li>
      </ol>
      {check.ok && (
        <Call>
          {check.next === "approve" ? (
            <>
              <b>approve</b>(MarginBank {shortHex(bank)}, {fmtUsdso(check.amount)}) on USDso
            </>
          ) : (
            <>
              <b>deposit</b>({fmtUsdso(check.amount)}) on MarginBank {shortHex(bank)}
            </>
          )}
        </Call>
      )}
      <Acts>
        <Button size="md" disabled={!check.ok || tx.busy} onClick={send}>
          {mine.phase === "signing"
            ? "Confirm in your wallet…"
            : mine.phase === "pending"
              ? "Waiting for the block…"
              : check.ok && check.next === "deposit"
                ? `Move ${amount} into perps`
                : `Approve ${amount}`}
        </Button>
      </Acts>
      <TxLine tx={mine} recalled={tx.recalled} />
    </div>
  );
}

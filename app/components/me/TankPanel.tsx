"use client";

import { useState } from "react";
import { MIN_TANK, MIN_TANK_FOR_INCREASE, type Copybook } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { PanelNote } from "@/components/app/Panel";
import { TxLine } from "@/components/follow/parts";
import { txFor, type useTx } from "@/components/follow/hooks";
import { parseTank } from "@/lib/follow/policyForm";
import type { TankStats } from "@/lib/me/activity";
import { withdrawable } from "@/lib/me/issues";
import { fmtStt, fmtUnits } from "@/lib/units";
import styles from "./Me.module.css";

const E18 = 10n ** 18n;
const f1 = (n: number) => n.toFixed(1);
const rad = (d: number) => (d * Math.PI) / 180;

/** An engraved half-dial from 0 to `full` STT, a bone arc to the tank and a gold needle; the 0.2 STT floor dashed. */
export function TankGauge({ tank, full }: { tank: bigint; full: bigint }) {
  const R = 80;
  const v = full > 0n ? Math.min(1, Number((tank * 10_000n) / full) / 10_000) : 0;
  const ticks = [];
  for (let i = 0; i <= 50; i++) {
    const a = rad(180 + i * 3.6);
    const L = i % 10 === 0 ? 12 : i % 5 === 0 ? 7 : 3.5;
    ticks.push(<line key={`t${i}`} className={styles.tk} x1={f1(R * Math.cos(a))} y1={f1(R * Math.sin(a))} x2={f1((R - L) * Math.cos(a))} y2={f1((R - L) * Math.sin(a))} />);
    if (i % 25 === 0)
      ticks.push(
        <text key={`l${i}`} x={f1((R + 10) * Math.cos(a))} y={f1((R + 10) * Math.sin(a) + 3)} textAnchor="middle">
          {fmtUnits((full * BigInt(i)) / 50n, 18, 2)}
        </text>,
      );
  }
  const ea = rad(180 + v * 180);
  const r2 = R - 18;
  const fa = rad(180 + Math.min(1, Number((MIN_TANK * 10_000n) / (full || 1n)) / 10_000) * 180);
  return (
    <svg className={styles.gauge} viewBox="-96 -92 192 104" role="img" aria-label={`Gas tank ${fmtStt(tank)} on a dial to ${fmtStt(full)}`}>
      <path className={styles.r} d={`M ${-R} 0 A ${R} ${R} 0 0 1 ${R} 0`} />
      <path className={styles.r} d={`M ${-R + 12} 0 A ${R - 12} ${R - 12} 0 0 1 ${R - 12} 0`} />
      {ticks}
      <line className={styles.floor} x1={f1((R - 14) * Math.cos(fa))} y1={f1((R - 14) * Math.sin(fa))} x2={f1((R + 4) * Math.cos(fa))} y2={f1((R + 4) * Math.sin(fa))} />
      {v > 0 && <path className={styles.fill} d={`M ${-r2} 0 A ${r2} ${r2} 0 0 1 ${f1(r2 * Math.cos(ea))} ${f1(r2 * Math.sin(ea))}`} />}
      <line className={styles.nd} x1="0" y1="0" x2={f1((R - 2) * Math.cos(ea))} y2={f1((R - 2) * Math.sin(ea))} />
      <circle r="3" fill="#caa063" />
    </svg>
  );
}

/** Whole STT above the tank (at least 1), so the dial has room: the dial's end is a scale, not a deposit. */
export const dialFull = (tank: bigint) => {
  const whole = (tank + E18 - 1n) / E18;
  return (whole < 1n ? 1n : whole) * E18;
};

/** The tank: what it holds, what the handler has charged it per run, and top-up and withdraw. */
export function TankPanel({
  tank,
  stats,
  sinceKnown,
  following,
  writer,
  tx,
  balance,
}: {
  tank: bigint;
  stats: TankStats;
  /** The current follow's block is known, so its charges can be told from earlier follows'. */
  sinceKnown: boolean;
  following: boolean;
  writer: () => Copybook;
  tx: ReturnType<typeof useTx>;
  balance?: bigint;
}) {
  const [mode, setMode] = useState<"fund" | "withdraw" | null>(null);
  const [amount, setAmount] = useState("0.2");
  const free = withdrawable(tank, following);
  const wei = parseTank(amount);
  const mine = txFor(tx, ["fundTank", "withdrawTank"]);
  const problem =
    wei === null || wei === 0n
      ? "Type an amount in STT, like 0.2."
      : mode === "withdraw" && wei > free
        ? `At most ${fmtStt(free)} can come out now${following ? ": a following wallet keeps 0.2 STT in the tank" : ""}.`
        : mode === "fund" && balance !== undefined && wei >= balance
          ? `This wallet holds ${fmtStt(balance)}, and the top-up needs gas on top.`
          : null;
  const send = () =>
    mode &&
    wei &&
    tx.run(mode === "fund" ? "fundTank" : "withdrawTank", () => (mode === "fund" ? writer().fundTank(wei) : writer().withdrawTank(wei)));

  return (
    <>
      <div className={styles.gas}>
        <TankGauge tank={tank} full={dialFull(tank)} />
        <div>
          <div className={styles.gv}>
            {fmtUnits(tank, 18, 4)} <small>STT</small>
          </div>
          <p className={styles.gs}>
            {stats.average !== undefined && stats.left !== undefined ? (
              <>
                ≈ {stats.left.toString()} more runs that copy or refuse
                <br />
                <span>
                  at this follow&apos;s average for those, {fmtStt(stats.average)}, over {stats.runs} run{stats.runs === 1 ? "" : "s"}
                </span>
              </>
            ) : (
              <span>
                {sinceKnown
                  ? "No run of this follow has copied or refused yet, so there is no per-run figure to estimate from."
                  : "This follow's charges are still being read, so there is no per-run figure yet."}
              </span>
            )}
          </p>
          <p className={styles.gs}>
            <span>{following ? "withdrawable above the 0.2 STT floor" : "withdrawable"}:</span> {fmtStt(free)}
          </p>
        </div>
      </div>
      <div className={styles.tankForm}>
        {mode === null ? (
          <>
            <button type="button" className={styles.link} onClick={() => setMode("fund")}>
              Top up
            </button>
            <button type="button" className={styles.link} onClick={() => setMode("withdraw")} disabled={free === 0n}>
              Withdraw
            </button>
          </>
        ) : (
          <>
            <label className={styles.amount}>
              {mode === "fund" ? "Top up" : "Withdraw"}
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label={`${mode === "fund" ? "Top-up" : "Withdrawal"} in STT`} />
              STT
            </label>
            <Button size="md" variant="secondary" disabled={!!problem || tx.busy} onClick={send}>
              {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : mode === "fund" ? "Send fundTank" : "Send withdrawTank"}
            </Button>
            <button type="button" className={styles.link} onClick={() => setMode(null)} disabled={tx.busy}>
              Cancel
            </button>
            {mode === "withdraw" && (
              <button type="button" className={styles.link} onClick={() => setAmount(fmtUnits(free, 18, 18).replace(/,/g, ""))}>
                All {fmtStt(free)}
              </button>
            )}
          </>
        )}
      </div>
      {mode !== null && problem && wei !== null && <PanelNote>{problem}</PanelNote>}
      <div className={styles.txPad}>
        <TxLine tx={mine} recalled={tx.recalled} />
      </div>
      <PanelNote>
        Every handler run that reaches this wallet is billed to the tank. A run that copies or refuses logs its charge (TankCharged); a run with nothing to do is billed
        without an event, so the tank lasts somewhat less than the estimate. Below {fmtStt(MIN_TANK_FOR_INCREASE)} every increase is refused; exits still run. The dashed mark on
        the dial is the 0.2 STT a following wallet keeps.
      </PanelNote>
    </>
  );
}

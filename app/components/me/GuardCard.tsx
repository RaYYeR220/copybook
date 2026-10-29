"use client";

import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import type { Copybook, Verdict } from "@copybook/sdk";
import { VerdictBlock, VerdictCaution, VerdictOk } from "@/components/glyphs";
import { DataState } from "@/components/app/State";
import { HubFeedProvider } from "@/components/app/HubFeed";
import { VerdictHistory } from "@/components/app/VerdictHistory";
import g from "@/components/app/Guard.module.css";
import { Button } from "@/components/Button";
import { Call, TxLine } from "@/components/follow/parts";
import { txFor, type useTx } from "@/components/follow/hooks";
import type { PublicConfig } from "@/lib/publicConfig";
import { fmtUtc } from "@/lib/units";
import { verdictView } from "@/lib/verdict";
import styles from "./Me.module.css";

const WORD = { None: "Not reviewed", Ok: "OK", Caution: "Caution", Block: "Block" } as const;

/**
 * The AI guard on the dashboard: the gate's verdict on the trader this wallet follows, the verdicts it logged, and
 * this wallet's guard switch (`setGuard`). For a thesis follow the guard does nothing, and the panel says so.
 */
export function GuardCard({
  kind,
  trader,
  verdict,
  guardOn,
  pub,
  now,
  writer,
  tx,
}: {
  kind: "Trader" | "Theme";
  trader?: Address;
  /** null when the gate did not answer. */
  verdict?: Verdict | null;
  guardOn: boolean;
  pub: PublicConfig;
  now: number;
  writer: () => Copybook;
  tx: ReturnType<typeof useTx>;
}) {
  const mine = txFor(tx, ["setGuard"]);
  // a plain button and a confirm: no wallet prompt from a stray key press on a radio group
  const [confirming, setConfirming] = useState(false);
  const want = !guardOn;
  const toggle = (
    <>
      <div className={styles.toggle}>
        <span className={styles.tlabel}>
          Your guard · <span className={guardOn ? styles.on : undefined}>{guardOn ? "on" : "off"}</span>
        </span>
        {!confirming && (
          <Button size="md" variant="quiet" disabled={tx.busy} onClick={() => setConfirming(true)}>
            {guardOn ? "Turn it off…" : "Turn it on…"}
          </Button>
        )}
      </div>
      {confirming && (
        <div className={styles.confirm} role="group" aria-label={guardOn ? "Turn the guard off" : "Turn the guard on"}>
          <p className={styles.dlead}>
            {want
              ? "With the guard on, a fresh BLOCK verdict on the trader you follow stops new size for this wallet; exits still run."
              : "With the guard off, a BLOCK verdict no longer stops new size for this wallet. It is this wallet's setting on the RiskGate, for this follow and any later one."}
          </p>
          <Call>
            <b>setGuard</b>({String(want)}) on the RiskGate
          </Call>
          <div className={styles.drow}>
            <Button
              size="md"
              variant="secondary"
              disabled={tx.busy}
              onClick={async () => {
                const out = await tx.run("setGuard", () => writer().setGuard(want));
                if (out.phase === "confirmed") setConfirming(false);
              }}
            >
              {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : `Send setGuard(${want})`}
            </Button>
            <button type="button" className={styles.link} disabled={tx.busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <TxLine tx={mine} />
    </>
  );

  if (kind === "Theme")
    return (
      <div className={g.body}>
        <p className={`${styles.law} ${styles.lawFirst}`}>
          <b>A thesis follow is never gated.</b> The guard reads the validators&apos; verdict on a trader; a thesis has none, so copies and rebalances run whatever the switch says.
          It stays this wallet&apos;s setting for any trader it follows later.
        </p>
        {toggle}
      </div>
    );

  if (!trader) return null;
  if (verdict === null || verdict === undefined)
    return (
      <div className={g.body}>
        <DataState kind="unavailable" title="The risk gate did not answer.">
          The verdict is unknown right now, which is not the same as no verdict.
        </DataState>
        {toggle}
      </div>
    );

  const v = verdictView(verdict, now, pub.risk);
  const G = v.tier === "Block" ? VerdictBlock : v.tier === "Caution" ? VerdictCaution : v.tier === "Ok" ? VerdictOk : null;
  const blockingYou = v.tier === "Block" && v.blocking && guardOn;
  return (
    <div className={g.body}>
      <div className={styles.vrow}>
        <div className={`${g.vbig} ${v.tier === "Caution" ? g.gold : ""}`}>
          {G ? <G className={g.vglyph} /> : <span className={g.vnone} aria-hidden="true" />}
          <div>
            <b>{v.tier === "Block" && v.expired ? "Block, lapsed" : WORD[v.tier]}</b>
            <small>{v.reviewed && v.reviewedAt ? `reviewed ${fmtUtc(v.reviewedAt)}` : "no verdict on the gate"}</small>
            {v.tier === "Block" && !v.expired && v.heldUntil !== undefined && (
              <small>
                {now < v.heldUntil ? `held until ${fmtUtc(v.heldUntil)}: only another BLOCK replaces it before then` : `its hold ended ${fmtUtc(v.heldUntil)}: any new verdict replaces it`}
              </small>
            )}
          </div>
        </div>
        <p className={`${g.vmeta} ${styles.vmetaLeft}`}>
          {blockingYou ? (
            <>
              no new size for you
              {" "}
              <b>until {v.expiresAt ? fmtUtc(v.expiresAt) : "it lapses"}</b>
            </>
          ) : v.tier === "Block" && v.blocking ? (
            <>
              blocking, but
              {" "}
              <b>your guard is off</b>
            </>
          ) : (
            <>copies continue</>
          )}
        </p>
      </div>
      <HubFeedProvider pub={pub} source={trader} cap={200} live={false}>
        <VerdictHistory trader={trader} reviewed={v.reviewed} />
      </HubFeedProvider>
      <p className={styles.law}>
        <b>BLOCK stops new size — it never stops an exit.</b> A committee of {pub.committee.size} Somnia validators reviews the trader&apos;s 30-day record; the verdict reaches the gate
        over Hyperlane. <Link href={`/t/${trader}`} prefetch={false}>The full verdict, and a fresh review</Link>, are on the trader&apos;s page.
      </p>
      {toggle}
    </div>
  );
}

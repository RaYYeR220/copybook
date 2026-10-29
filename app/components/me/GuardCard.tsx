"use client";

import Link from "next/link";
import type { Address } from "viem";
import type { Copybook, Verdict } from "@copybook/sdk";
import { VerdictBlock, VerdictCaution, VerdictOk } from "@/components/glyphs";
import { DataState } from "@/components/app/State";
import { HubFeedProvider } from "@/components/app/HubFeed";
import { VerdictHistory } from "@/components/app/VerdictHistory";
import g from "@/components/app/Guard.module.css";
import { Segmented, TxLine } from "@/components/follow/parts";
import type { useTx } from "@/components/follow/hooks";
import { IDLE } from "@/lib/follow/tx";
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
  const mine = tx.tx.phase !== "idle" && "action" in tx.tx && tx.tx.action === "setGuard" ? tx.tx : IDLE;
  const toggle = (
    <>
      <div className={styles.toggle}>
        <span className={styles.tlabel}>Your guard</span>
        <Segmented
          name="me-guard"
          label="AI guard for this wallet"
          value={guardOn ? "on" : "off"}
          onChange={(v) => !tx.busy && tx.run("setGuard", () => writer().setGuard(v === "on"))}
          options={[
            { value: "on", label: "On", gold: true },
            { value: "off", label: "Off" },
          ]}
        />
      </div>
      <TxLine tx={mine} recalled={tx.recalled} />
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

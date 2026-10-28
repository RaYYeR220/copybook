import type { ReactNode } from "react";
import type { Address } from "viem";
import type { ReviewPending, Verdict } from "@copybook/sdk";
import { VerdictBlock, VerdictCaution, VerdictOk } from "@/components/glyphs";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { shortHex } from "@/lib/format";
import { toJsonSafe } from "@/lib/json";
import type { PublicConfig } from "@/lib/publicConfig";
import type { ShannonTally } from "@/lib/server/config";
import { TIER_LABEL } from "@/lib/tape";
import { fmtUtc } from "@/lib/units";
import { verdictView } from "@/lib/verdict";
import { AskValidators } from "./AskValidators";
import { DataState } from "./State";
import { VerdictHistory, VerdictSince } from "./VerdictHistory";
import styles from "./Guard.module.css";

interface Props {
  trader: Address;
  pub: PublicConfig;
  /** null when the gate could not be read */
  verdict: Verdict | null;
  pending: ReviewPending | null;
  fee: bigint | null;
  tally?: ShannonTally;
  shannonExplorer: string;
  reviewerUrl: string;
  now: number;
}

const WORD = { None: "Not reviewed", Ok: "OK", Caution: "Caution", Block: "Block" } as const;

/**
 * The trader's AI guard: the verdict the gate holds now, what it does (BLOCK stops new size for guarded followers,
 * never an exit), when a BLOCK can be replaced and when it lapses, the committee's tally on Shannon, the verdicts
 * logged so far, and a way to ask for a fresh review.
 */
export function GuardPanel({ trader, pub, verdict, pending, fee, tally, shannonExplorer, reviewerUrl, now }: Props) {
  const initial = toJsonSafe({ verdict, pending: pending ? { nonce: pending.nonce, requestedAt: pending.requestedAt } : null, fee });
  if (!verdict)
    return (
      <div className={styles.body}>
        <DataState kind="unavailable" title="The risk gate could not be read from the chain.">
          The verdict is unknown right now, which is not the same as no verdict. Reload in a moment.
        </DataState>
        <p className={styles.law}>BLOCK stops new size — it never stops an exit.</p>
      </div>
    );

  const v = verdictView(verdict, now, pub.risk);
  const G = v.tier === "Block" ? VerdictBlock : v.tier === "Caution" ? VerdictCaution : v.tier === "Ok" ? VerdictOk : null;
  const word = v.tier === "Block" && v.expired ? "Block, lapsed" : WORD[v.tier];

  let what: ReactNode;
  if (v.tier === "Block" && v.blocking)
    what = (
      <>
        new size stopped{" "}
        <br />
        <b>for guarded followers</b>
      </>
    );
  else if (v.tier === "Block") what = <>no longer blocks</>;
  else what = <>copies continue</>;

  const rows: LedgerRow[] = [];
  if (v.reviewed && v.reviewedAt) rows.push({ label: "Reviewed", value: fmtUtc(v.reviewedAt), note: "when the verdict reached the gate" });
  if (v.tier === "Block" && v.heldUntil !== undefined)
    rows.push({
      label: "Held until",
      value: <b>{fmtUtc(v.heldUntil)}</b>,
      note: v.held ? "until then only another BLOCK can replace it" : "the hold is over: any new verdict replaces it",
    });
  if (v.tier === "Block" && v.expiresAt !== undefined)
    rows.push({ label: v.expired ? "Lapsed" : "Blocks until", value: fmtUtc(v.expiresAt), note: v.expired ? undefined : "unless a new BLOCK refreshes it" });
  if (v.reviewed && tally)
    rows.push({
      label: "Committee",
      value: `${tally.tier === "Block" ? tally.votes.blocked : tally.tier === "Caution" ? tally.votes.caution : tally.votes.ok} of ${tally.votes.responded} said ${TIER_LABEL[tally.tier]}`,
    });
  if (v.reviewed)
    rows.push({
      label: "Shannon request",
      value: (
        <a className="lnk" href={tally ? `${shannonExplorer}/tx/${tally.tallyTx}` : reviewerUrl} target="_blank" rel="noopener noreferrer">
          #{verdict.shannonRequestId.toString()} ↗
        </a>
      ),
      note: tally ? "the committee's tally on Shannon" : "this review was not recorded here: the link opens the reviewer on Shannon",
    });
  if (v.reviewed) rows.push({ label: "Summary hash", value: <span title={verdict.summaryHash}>{shortHex(verdict.summaryHash, 6, 4)}</span> });

  return (
    <div className={styles.body}>
      <div className={styles.vrow}>
        <div className={`${styles.vbig} ${v.tier === "Caution" ? styles.gold : ""}`}>
          {G ? <G className={styles.vglyph} /> : <span className={styles.vnone} aria-hidden="true" />}
          <div>
            <b>{word}</b>
            {v.reviewed ? (
              <small>
                <VerdictSince trader={trader} requestId={verdict.shannonRequestId.toString()} fallback={v.held ? "held" : v.tier === "Block" && v.blocking ? "blocking" : "stored"} />
              </small>
            ) : (
              <small>no verdict on the gate</small>
            )}
          </div>
        </div>
        <p className={styles.vmeta}>{what}</p>
      </div>

      <VerdictHistory trader={trader} reviewed={v.reviewed} />

      {rows.length > 0 && (
        <div className={styles.ledger}>
          <Ledger size="md" rows={rows} />
        </div>
      )}

      <p className={styles.law}>
        <b>BLOCK stops new size — it never stops an exit.</b> It applies to guarded followers of trader follows: every follower is guarded unless they turn the guard off.
        {!v.reviewed && " No validator has reviewed this trader yet, so nothing is blocked."}
        {v.tier === "Caution" && " CAUTION never stops a copy; it is a flag for people deciding whether to follow."}
      </p>

      <AskValidators trader={trader} pub={pub} initial={initial} renderedAt={now} />
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { MIN_TANK, type Copybook, type Follow, type PreflightInput } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { Gold, Ledger, type LedgerRow } from "@/components/Ledger";
import { SourceLine, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { Call, ReasonList, Segmented, TxLine } from "@/components/follow/parts";
import { PolicyFields } from "@/components/follow/PolicyFields";
import { usePreflight, type useReader, type useTx } from "@/components/follow/hooks";
import { parsePolicyForm, policyToForm, type FormField } from "@/lib/follow/policyForm";
import { blocks, reasonsFor } from "@/lib/follow/reasons";
import { IDLE } from "@/lib/follow/tx";
import { addressUrl } from "@/lib/explorer";
import { fmtInt, shortHex } from "@/lib/format";
import type { MarketMeta } from "@/lib/tape";
import { fmtUsd18 } from "@/lib/units";
import styles from "./Me.module.css";

export type Drawer = "unfollow" | "policy" | null;

interface Props {
  who: Address;
  follow: Follow;
  name: string;
  /** Thesis follows: the thesis version and the version this book is on. */
  versions?: { thesis: number; synced: number };
  /** Block of the Followed event, when the feed has it. */
  since?: bigint;
  /** null: unknown (not a plain follow call); [] whole book. */
  joinPools: Address[] | null | undefined;
  held: Address[];
  guardOn: boolean;
  approved?: boolean;
  equity: bigint | null;
  inStep?: { n: number; of: number };
  stopped: boolean;
  flattenPending: boolean;
  markets: Record<string, MarketMeta>;
  reader: ReturnType<typeof useReader>;
  writer: () => Copybook;
  tx: ReturnType<typeof useTx>;
  drawer: Drawer;
  setDrawer: (d: Drawer) => void;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** The source this wallet follows, its policy as a ledger, and the controls: resume, edit the policy, unfollow. */
export function SourceCard(p: Props) {
  const { follow, markets } = p;
  const pol = follow.policy;
  const marketText =
    follow.kind === "Theme"
      ? undefined
      : p.joinPools === undefined
        ? "reading the follow from the history…"
        : p.joinPools === null
          ? "unknown: the follow transaction was not found"
          : p.joinPools.length === 0
            ? "whole book"
            : p.joinPools.map((x) => (markets[x.toLowerCase()] ? `${markets[x.toLowerCase()]!.symbol}-PERP` : shortHex(x))).join(", ");
  const rows: LedgerRow[] = [
    follow.kind === "Trader" ? { label: "Scale", value: <b>{(pol.scaleBps / 10_000).toString()}×</b> } : { label: "Allocation", value: <b>{fmtUsd18(pol.allocation)}</b> },
    { label: "Cap per position", value: fmtUsd18(pol.maxNotional) },
    { label: "Total cap", value: pol.maxTotalNotional > 0n ? fmtUsd18(pol.maxTotalNotional) : "none" },
    { label: "Price band", value: `±${pct(pol.bandBps)}` },
    { label: "Equity floor", value: pol.equityFloor > 0n ? fmtUsd18(pol.equityFloor) : "off" },
  ];
  if (marketText) rows.push({ label: "Markets", value: marketText });
  rows.push({ label: "AI guard", value: follow.kind === "Theme" ? "not applied to theses" : p.guardOn ? <Gold>On · validators&apos; verdict</Gold> : "Off" });
  rows.push({ label: "Perps equity", value: p.equity !== null ? fmtUsd18(p.equity) : "unread" });
  if (p.approved !== undefined) rows.push({ label: "Operator grant", value: p.approved ? "global" : "no global grant" });

  const step = p.stopped ? "stopped" : p.inStep ? `live · ${p.inStep.n} of ${p.inStep.of} in step` : "live";
  return (
    <>
      <SourceTop kick="Following" step={step} quiet={p.stopped} />
      <SourceTitle id="src-h" address={follow.kind === "Trader"}>
        {p.name}
      </SourceTitle>
      <SourceLine>
        {follow.kind === "Trader" && follow.trader ? (
          <>
            <Link href={`/t/${follow.trader}`} prefetch={false}>
              {shortHex(follow.trader, 6, 4)}
            </Link>{" "}
            <span>· trader</span>
          </>
        ) : (
          <>
            <Link href={`/thesis/${follow.themeId}`} prefetch={false}>
              thesis #{follow.themeId?.toString()}
            </Link>
            {p.versions && (
              <span>
                {" "}
                · v{p.versions.thesis}
                {p.versions.synced !== p.versions.thesis ? `, your book on v${p.versions.synced}` : ""}
              </span>
            )}
          </>
        )}
        <br />
        <span>{p.since !== undefined ? "since block" : "follow block"}</span> {p.since !== undefined ? `#${fmtInt(p.since)}` : "not in the events read"} <span>· wallet</span>{" "}
        <a href={addressUrl(p.who)} target="_blank" rel="noopener noreferrer">
          {shortHex(p.who)}
        </a>
      </SourceLine>
      <div className={styles.ledger}>
        <Ledger size="md" rows={rows} />
      </div>
      <div className={styles.acts}>
        <div className={`${styles.drow} ${styles.flush}`}>
          {p.stopped && !p.flattenPending && (
            <Button size="md" disabled={p.tx.busy} onClick={() => p.tx.run("resume", () => p.writer().resume())}>
              Resume copying
            </Button>
          )}
          <Button size="md" variant="quiet" onClick={() => p.setDrawer(p.drawer === "policy" ? null : "policy")} aria-expanded={p.drawer === "policy"}>
            Edit policy
          </Button>
        </div>
        <Button size="md" variant="secondary" onClick={() => p.setDrawer(p.drawer === "unfollow" ? null : "unfollow")} aria-expanded={p.drawer === "unfollow"}>
          Unfollow
        </Button>
      </div>
      {p.tx.tx.phase !== "idle" && "action" in p.tx.tx && p.tx.tx.action === "resume" && (
        <div className={styles.drawer}>
          <TxLine tx={p.tx.tx} recalled={p.tx.recalled} />
        </div>
      )}
      {p.drawer === "unfollow" && <UnfollowDrawer {...p} />}
      {p.drawer === "policy" && <PolicyDrawer {...p} />}
    </>
  );
}

function UnfollowDrawer({ writer, tx, follow }: Props) {
  const [flatten, setFlatten] = useState(true);
  const mine = tx.tx.phase !== "idle" && "action" in tx.tx && tx.tx.action === "unfollow" ? tx.tx : IDLE;
  return (
    <div className={styles.drawer} role="group" aria-label="Unfollow">
      <Segmented
        name="flatten"
        label="What happens to your positions"
        value={flatten ? "close" : "keep"}
        onChange={(v) => setFlatten(v === "close")}
        options={[
          { value: "close", label: "Close my positions" },
          { value: "keep", label: "Keep them open" },
        ]}
      />
      <p className={`${styles.dlead} ${styles.spaced}`}>
        {flatten ? (
          <>
            The hub closes every market it traded for you, in this transaction, with orders at twice your band (at least 1%). Anything the venue cannot take now stays open, and the
            Unfollowed event says so (<span className="mono">flattened: false</span>).
          </>
        ) : (
          <>Your positions stay open and become yours to manage: the hub stops touching them.</>
        )}
      </p>
      <p className={styles.dlead}>
        Either way the tank can then be withdrawn in full, and the operator grant stays until you revoke it here.{" "}
        {follow.kind === "Theme" ? "Following again starts the thesis from its current version." : ""}
      </p>
      <Call>
        <b>unfollow</b>({String(flatten)}) on the hub
      </Call>
      <div className={styles.drow}>
        <Button size="md" variant="secondary" disabled={tx.busy} onClick={() => tx.run("unfollow", () => writer().unfollow(flatten))}>
          {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : flatten ? "Unfollow and close" : "Unfollow, keep positions"}
        </Button>
      </div>
      <TxLine tx={mine} recalled={tx.recalled} />
    </div>
  );
}

function PolicyDrawer({ follow, who, joinPools, held, markets, reader, writer, tx, guardOn }: Props) {
  const [form, setForm] = useState(() => policyToForm(follow.kind, follow.policy));
  // a new policy on chain (this edit landing, or another tab) resets the form; a re-read of the same one does not
  const onChain = JSON.stringify(follow.policy, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const policyRef = useRef(follow.policy);
  policyRef.current = follow.policy;
  useEffect(() => setForm(policyToForm(follow.kind, policyRef.current)), [follow.kind, onChain]);
  const parsed = parsePolicyForm(follow.kind, form);
  const source = follow.kind === "Trader" ? follow.trader! : follow.themeId!;
  const input: PreflightInput | null = parsed.policy
    ? {
        account: who,
        kind: follow.kind,
        source,
        policy: parsed.policy,
        joinPools: joinPools ?? [],
        ...(follow.kind === "Trader" && (joinPools?.length ?? 0) === 0 ? { checkPools: held } : {}),
        tank: MIN_TANK,
        ...(follow.kind === "Trader" ? { guardOn } : {}),
      }
    : null;
  const key = input ? JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : "";
  const pre = usePreflight(reader.copybook, input, key);
  const result = pre.status === "ready" ? pre.result : pre.status === "checking" || pre.status === "error" ? pre.last : undefined;
  const shown = result ? reasonsFor("policy", result.reasons).filter((r) => r.code !== "ALLOW_ALL_MIRRORS_OPEN_BOOK") : [];
  const ready = pre.status === "ready" && !!parsed.policy && !blocks("policy", pre.result.reasons);
  const mine = tx.tx.phase !== "idle" && "action" in tx.tx && tx.tx.action === "updatePolicy" ? tx.tx : IDLE;
  const apply = (f: FormField | "tank", v: string) => f !== "tank" && f !== "markets" && setForm((x) => ({ ...x, [f]: v }));
  return (
    <div className={styles.drawer} role="group" aria-label="Edit policy">
      <p className={styles.dlead}>
        The new policy applies from the next copy{follow.kind === "Theme" ? "; a new allocation resizes the legs at the next sync, which catchUp runs now" : ""}. The market list stays as
        it was set when following.
      </p>
      <PolicyFields kind={follow.kind} values={form} onChange={setForm} errors={parsed.errors} markets={markets} idPrefix="edit" marketsEditable={false} />
      <ReasonList reasons={shown} markets={markets} onApply={apply} label="What the check found" />
      {pre.status === "checking" && <p className={styles.dlead}>Checking against the venue…</p>}
      <Call>
        <b>updatePolicy</b>(policy) on the hub
      </Call>
      <div className={styles.drow}>
        <Button size="md" variant="secondary" disabled={!ready || tx.busy} onClick={() => tx.run("updatePolicy", () => writer().updatePolicy(parsed.policy!))}>
          {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : "Save the policy"}
        </Button>
      </div>
      <TxLine tx={mine} recalled={tx.recalled} />
    </div>
  );
}

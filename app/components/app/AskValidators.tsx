"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, http, type Address, type PublicClient, type WalletClient } from "viem";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";
import { createCopybook, type Verdict } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { askValidators, type AskPhase } from "@/lib/ask";
import { txUrl } from "@/lib/explorer";
import { fmtInt } from "@/lib/format";
import { fromJsonSafe } from "@/lib/json";
import { deploymentsOf, type PublicConfig } from "@/lib/publicConfig";
import { fmtDuration, fmtStt, fmtUtc } from "@/lib/units";
import { askState, verdictView, type AskState } from "@/lib/verdict";
import { hideki } from "@/lib/wallet/hideki";
import { useHubFeed } from "./HubFeed";
import styles from "./Guard.module.css";

type StoredVerdict = Pick<Verdict, "tier" | "reviewedAt" | "shannonRequestId" | "summaryHash">;

interface Props {
  trader: Address;
  pub: PublicConfig;
  /** JSON-safe reads from the server render: the stored verdict, the pending review and the fee (null if unread). */
  initial: unknown;
  /** Unix seconds of the server render, so the first client render says the same thing. */
  renderedAt: number;
}

function explain(s: AskState, now: number): string | null {
  if (s.kind === "pending")
    return `A review (request #${s.nonce}) is already on its way, asked ${fmtUtc(s.requestedAt)}. The gate takes a new one once it is answered, or after ${fmtUtc(s.replaceableAt)} (in ${fmtDuration(s.replaceableAt - now)}) if it is not.`;
  if (s.kind === "cooldown") return `The gate stored a verdict minutes ago. A new review can be asked after ${fmtUtc(s.readyAt)} (in ${fmtDuration(s.readyAt - now)}).`;
  if (s.holdUntil !== undefined)
    return `You can ask now, but until ${fmtUtc(s.holdUntil)} only another BLOCK can replace this one: a milder verdict that arrives before then is logged as held and the BLOCK stands.`;
  if (s.replaces !== undefined) return `Request #${s.replaces} got no answer in time; a new review replaces it.`;
  return null;
}

/**
 * "Ask the validators": pays the gate's fee for a fresh review of this trader. The gate's own checks run first, on
 * fresh reads, so a request that would revert is explained instead of sent.
 */
export function AskValidators({ trader, pub, initial, renderedAt }: Props) {
  const reads = useMemo(() => fromJsonSafe<{ verdict: StoredVerdict | null; pending: { nonce: bigint; requestedAt: number } | null; fee: bigint | null }>(initial), [initial]);
  const deployments = useMemo(() => deploymentsOf(pub), [pub]);
  const { status, chainId, address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChain, isPending: switching } = useSwitchChain();
  const router = useRouter();
  const feed = useHubFeed();
  const [now, setNow] = useState(renderedAt);
  const [phase, setPhase] = useState<AskPhase>({ phase: "idle" });
  const requestedAt = useRef<bigint | undefined>(undefined);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);

  // when the answer to our request lands, re-read the page (verdict, hold, expiry)
  useEffect(() => {
    const from = requestedAt.current;
    if (from === undefined) return;
    const answered = feed.events.some(
      (e) =>
        (e.name === "VerdictReceived" || e.name === "BlockHeld" || e.name === "ReviewFailed") &&
        e.trader.toLowerCase() === trader.toLowerCase() &&
        (e.log.blockNumber ?? 0n) > from,
    );
    if (answered) {
      requestedAt.current = undefined;
      router.refresh();
    }
  }, [feed.events, trader, router]);

  const pre = reads.verdict ? askState(verdictView(reads.verdict, now, pub.risk), reads.pending, now, pub.risk) : ({ kind: "ready" } as AskState);
  const preText = explain(pre, now);
  const busy = phase.phase === "checking" || phase.phase === "signing" || phase.phase === "sent";
  const connected = status === "connected";
  const wrongChain = connected && chainId !== hideki.id;

  async function ask() {
    if (!walletClient || !address) return;
    const publicClient = createPublicClient({ chain: hideki, transport: http() }) as PublicClient;
    const copybook = createCopybook({ publicClient, walletClient: walletClient as WalletClient, deployments });
    const out = await askValidators(
      {
        verdict: () => copybook.verdictOf(trader),
        pending: () => copybook.reviewPendingOf(trader),
        fee: () => copybook.reviewFee(),
        balance: () => publicClient.getBalance({ address }),
        send: (value) => copybook.requestReview(trader, value),
        now: () => Math.floor(Date.now() / 1000),
        risk: pub.risk,
      },
      setPhase,
    );
    if (out.phase === "requested") requestedAt.current = out.block;
  }

  let action;
  if (!connected)
    action = (
      <Button size="md" variant="secondary" disabled>
        Ask the validators
      </Button>
    );
  else if (wrongChain)
    action = (
      <Button size="md" variant="secondary" onClick={() => switchChain({ chainId: hideki.id })} disabled={switching}>
        {switching ? "Check your wallet…" : `Switch to ${hideki.name}`}
      </Button>
    );
  else
    action = (
      <Button size="md" variant="secondary" onClick={ask} disabled={busy || pre.kind !== "ready" || !walletClient}>
        {phase.phase === "checking"
          ? "Checking the gate…"
          : phase.phase === "signing"
            ? "Confirm in your wallet…"
            : phase.phase === "sent"
              ? "Waiting for the block…"
              : `Ask the validators${reads.fee !== null ? ` · ${fmtStt(reads.fee)}` : ""}`}
      </Button>
    );

  return (
    <div className={styles.ask}>
      <p className={styles.askLead}>
        Anyone can pay for a fresh review. The fee{reads.fee !== null ? <> is <b>{fmtStt(reads.fee)}</b>, read from the gate,</> : " is read from the gate when you ask"} and pays a committee of {pub.committee.size}{" "}
        validators on Shannon to classify the trader&apos;s 30-day record; the verdict comes back to the gate over Hyperlane.
      </p>
      {preText && <p className={styles.askNote}>{preText}</p>}
      <div className={styles.askRow}>
        {action}
        {!connected && <span className={styles.askHint}>Connect a wallet (top right) to ask.</span>}
      </div>
      <div aria-live="polite">
        {phase.phase === "blocked" && <p className={styles.askNote}>{explain(phase.state, Math.floor(Date.now() / 1000))} Nothing was sent.</p>}
        {phase.phase === "sent" && (
          <p className={styles.askNote}>
            Sent:{" "}
            <a className="lnk" href={txUrl(phase.hash)} target="_blank" rel="noopener noreferrer">
              view the transaction
            </a>
            .
          </p>
        )}
        {phase.phase === "requested" && (
          <p className={styles.askNote}>
            Review{phase.nonce !== undefined ? ` #${phase.nonce}` : ""} requested in block #{fmtInt(phase.block)} (
            <a className="lnk" href={txUrl(phase.hash)} target="_blank" rel="noopener noreferrer">
              transaction
            </a>
            ). This page re-reads the gate when the verdict lands.
          </p>
        )}
        {phase.phase === "failed" && <p className={styles.askNote}>{phase.message}</p>}
      </div>
    </div>
  );
}

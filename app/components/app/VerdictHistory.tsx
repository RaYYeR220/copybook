"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import type { TierName } from "@copybook/sdk";
import { VerdictBlock, VerdictCaution, VerdictOk } from "@/components/glyphs";
import { txUrl } from "@/lib/explorer";
import { fmtInt } from "@/lib/format";
import { TIER_LABEL } from "@/lib/tape";
import { useHubFeed } from "./HubFeed";
import styles from "./Guard.module.css";

interface Reading {
  key: string;
  tier: TierName;
  block: bigint;
  hash?: string;
  /** A milder verdict that arrived inside a BLOCK's hold: logged, not stored. */
  held: boolean;
}

const GLYPH: Partial<Record<TierName, typeof VerdictOk>> = { Ok: VerdictOk, Caution: VerdictCaution, Block: VerdictBlock };
const SHOW = 6;

/** The trader's verdicts as the gate logged them, on one engraved line; the newest last. */
export function VerdictHistory({ trader, reviewed }: { trader: Address; reviewed: boolean }) {
  const feed = useHubFeed();
  const readings = useMemo(() => {
    const out: Reading[] = [];
    for (const e of [...feed.events].reverse()) {
      if ((e.name !== "VerdictReceived" && e.name !== "BlockHeld") || e.trader.toLowerCase() !== trader.toLowerCase() || e.log.blockNumber === undefined) continue;
      out.push({
        key: `${e.log.transactionHash}:${e.log.logIndex}`,
        tier: e.name === "VerdictReceived" ? e.tier : e.newTier,
        block: e.log.blockNumber,
        hash: e.log.transactionHash,
        held: e.name === "BlockHeld",
      });
    }
    return out;
  }, [feed.events, trader]);

  if (!feed.loaded) return <p className={styles.histNote}>Reading the gate&apos;s log…</p>;
  if (readings.length === 0) {
    if (feed.error) return <p className={styles.histNote}>The gate&apos;s log could not be read.</p>;
    return reviewed ? <p className={styles.histNote}>The gate&apos;s log has not shown this verdict yet.</p> : null;
  }

  const shown = readings.slice(-SHOW);
  return (
    <div className={styles.hist}>
      <ol className={styles.rule} aria-label="Verdicts the gate logged for this trader, oldest first">
        {shown.map((r) => {
          const G = GLYPH[r.tier];
          return (
            <li key={r.key} className={r.held ? styles.held : r.tier === "Caution" ? styles.caution : undefined}>
              <span className={styles.dot}>{G ? <G /> : null}</span>
              <a href={r.hash ? txUrl(r.hash) : undefined} target="_blank" rel="noopener noreferrer">
                <b>
                  {TIER_LABEL[r.tier]}
                  {r.held && " · held"}
                </b>
                <span>#{fmtInt(r.block)}</span>
              </a>
            </li>
          );
        })}
      </ol>
      {readings.length > SHOW && <p className={styles.histNote}>The {SHOW} most recent of {readings.length}.</p>}
      {readings.some((r) => r.held) && (
        <p className={styles.histNote}>“held”: a milder verdict that arrived during a BLOCK&apos;s hold. The gate logged it and kept the BLOCK.</p>
      )}
    </div>
  );
}

/**
 * "since block #N": the block the stored verdict reached the gate in, found in the gate's log by its Shannon request
 * id. Until the log answers, `fallback`.
 */
export function VerdictSince({ trader, requestId, fallback }: { trader: Address; requestId: string; fallback: string }) {
  const feed = useHubFeed();
  const block = useMemo(() => {
    for (const e of feed.events)
      if (e.name === "VerdictReceived" && e.trader.toLowerCase() === trader.toLowerCase() && e.shannonRequestId.toString() === requestId) return e.log.blockNumber;
    return undefined;
  }, [feed.events, trader, requestId]);
  return <>{block !== undefined ? `${fallback} since block #${fmtInt(block)}` : fallback}</>;
}

"use client";

import type { Market } from "@copybook/sdk";
import { GlyphExit, GlyphRefused, GlyphSame } from "@/components/glyphs";
import { Stat, StatRow } from "@/components/Stat";
import { PanelNote } from "@/components/app/Panel";
import { DataState } from "@/components/app/State";
import t from "@/components/app/Table.module.css";
import { addressUrl } from "@/lib/explorer";
import { fmtInt, shortHex } from "@/lib/format";
import { bookSummary, type BookRow } from "@/lib/me/book";
import { REASON_LABEL } from "@/lib/reasons";
import type { MarketMeta } from "@/lib/tape";
import { decimalsOf, legSide } from "@/lib/thesis";
import { fmtPrice18, fmtUnits, fmtUsdSigned18 } from "@/lib/units";
import styles from "./Me.module.css";

interface Props {
  kind: "Trader" | "Theme";
  rows: BookRow[] | undefined;
  markets: Record<string, Market | null>;
  names: Record<string, MarketMeta>;
  sourceLabel: string;
  loading: boolean;
  error?: string;
}

const dash = <span className={t.dim}>—</span>;

function size(x: bigint | null | undefined, m: Market | null | undefined, meta: MarketMeta | undefined) {
  if (x === null || x === undefined) return null;
  if (x === 0n) return "flat";
  const dec = m ? decimalsOf(m.oneBase) : meta?.decimals;
  const abs = x < 0n ? -x : x;
  return `${x > 0n ? "long" : "short"} ${dec !== undefined ? fmtUnits(abs, dec) : `${abs} units`}`;
}

function State({ r }: { r: BookRow }) {
  if (r.state === "in-step")
    return (
      <span className={styles.st}>
        <GlyphSame />
        In step
      </span>
    );
  if (r.state === "flat")
    return (
      <span className={styles.st}>
        <GlyphExit />
        Both flat
      </span>
    );
  if (r.state === "unknown") return <span className={`${styles.st} ${styles.out}`}>Unread</span>;
  const why = r.why;
  return (
    <span className={`${styles.st} ${styles.out}`}>
      <GlyphRefused />
      Out of step ·{" "}
      <em>
        {why?.kind === "refused"
          ? `${REASON_LABEL[why.reason === "None" ? "VenueRejected" : why.reason]} at #${fmtInt(why.block)}`
          : why?.kind === "drift"
            ? `${(why.bps / 100).toFixed(1)}% off target`
            : "not copied yet"}
      </em>
    </span>
  );
}

/** Your book against the source's, per market, from the chain; the sums are unrealized at today's marks. */
export function BookTable({ kind, rows, markets, names, sourceLabel, loading, error }: Props) {
  if (!rows && loading) return <DataState kind="loading" title="Reading both books from the margin bank…">Every market the follow covers: your position, the source&apos;s, and each pool&apos;s mark.</DataState>;
  if (!rows)
    return (
      <DataState kind="unavailable" title="The margin bank or the pools did not answer.">
        {error ?? "Positions are unknown right now, which is not the same as flat."}
      </DataState>
    );
  if (rows.length === 0)
    return (
      <DataState kind="empty" title="No market yet.">
        {kind === "Trader"
          ? "The trader holds no open position and the hub has not traded any market for you. The first copy lands at the trader's next move."
          : "The thesis has no leg the hub could read."}
      </DataState>
    );
  const s = bookSummary(rows);
  return (
    <>
      <table className={t.table}>
        <caption className="sr-only">Your book against {sourceLabel}, per market</caption>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">{kind === "Trader" ? `Theirs` : "Thesis leg"}</th>
            <th scope="col">Yours</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = r.pool.toLowerCase();
            const m = markets[key];
            const meta = names[key];
            const target = size(r.target, m, meta);
            const yours = size(r.yours, m, meta);
            const showTarget = target !== null && (kind === "Theme" || r.target !== r.theirs || r.capped) && r.target !== r.yours;
            return (
              <tr key={r.pool}>
                <td className={t.name}>
                  {meta ? (
                    `${meta.symbol}-PERP`
                  ) : (
                    <a className={t.addr} href={addressUrl(r.pool)} target="_blank" rel="noopener noreferrer">
                      {shortHex(r.pool)}
                    </a>
                  )}
                </td>
                <td data-label={kind === "Trader" ? "theirs" : "leg"}>
                  {kind === "Trader" ? (
                    r.theirs === undefined ? (
                      dash
                    ) : (
                      <>
                        <b>{size(r.theirs, m, meta)}</b>
                        {r.theirs !== 0n && r.theirsEntry ? <> @ {fmtPrice18(r.theirsEntry)}</> : null}
                      </>
                    )
                  ) : r.weightBps ? (
                    <>
                      <b>
                        {legSide(r.weightBps).side} {legSide(r.weightBps).pct}
                      </b>
                    </>
                  ) : (
                    "no longer a leg"
                  )}
                  {showTarget && (
                    <span className={styles.sub}>
                      target {target}
                      {r.capped ? " · capped" : ""}
                    </span>
                  )}
                </td>
                <td data-label="yours">
                  {yours === null ? (
                    dash
                  ) : (
                    <>
                      <b>{yours}</b>
                      {r.yours !== 0n && r.yoursEntry ? <> @ {fmtPrice18(r.yoursEntry)}</> : null}
                    </>
                  )}
                </td>
                <td className={t.full}>
                  <State r={r} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.sum}>
        <StatRow>
          <Stat label="Your open PnL" value={s.pnl !== undefined ? fmtUsdSigned18(s.pnl) : "—"} />
          {kind === "Trader" && <Stat label="Theirs, scaled" value={s.theirsPnlScaled !== undefined ? fmtUsdSigned18(s.theirsPnlScaled) : "—"} />}
          <Stat label="In step" value={`${s.inStep} of ${rows.length}`} align="end" />
        </StatRow>
      </div>
      <PanelNote>
        Sizes and entries from the margin bank, marks from each pool, read now. PnL is unrealized at today&apos;s mark from the average entry, before funding and fees
        {kind === "Trader" ? "; theirs is scaled by your multiplier" : ""}. In step means the hub&apos;s next sync would send no order there (what is left is under one minimum order
        {kind === "Theme" ? ", or within the 5% drift the hub leaves alone" : ""}).{s.partial ? " Markets marked unread are left out of the sums." : ""}
      </PanelNote>
    </>
  );
}

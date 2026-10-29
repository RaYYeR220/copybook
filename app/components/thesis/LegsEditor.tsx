"use client";

import { useRef, type Dispatch, type SetStateAction } from "react";
import type { Address } from "viem";
import { minOrderQty } from "@copybook/sdk";
import type { BasketIssue, BasketRow, RegistryRules } from "@/lib/builder/basket";
import type { BasketMinimum, MarketRead } from "@/lib/builder/registry";
import { shortHex } from "@/lib/format";
import type { MarketMeta } from "@/lib/tape";
import { decimalsOf } from "@/lib/thesis";
import { fmtPrice18, fmtUnits, fmtUsd18 } from "@/lib/units";
import { Segmented } from "@/components/follow/parts";
import f from "@/components/follow/Flow.module.css";
import styles from "./Builder.module.css";

/** An empty row. Keys are given by the form (the first row's is fixed, so the server and the browser agree). */
export const blankRow = (key: string): BasketRow => ({ key, pool: "", side: "long", weight: "" });

/** `BTC-PERP`, or the pool's short address when the indexer has no name for it. */
export const marketLabel = (markets: Record<string, MarketMeta>, pool: string) => {
  const m = markets[pool.toLowerCase()];
  return m ? `${m.symbol}-PERP` : shortHex(pool);
};

interface Props {
  rows: BasketRow[];
  setRows: Dispatch<SetStateAction<BasketRow[]>>;
  markets: Record<string, MarketMeta>;
  registered: Record<string, boolean | undefined>;
  rules: RegistryRules;
  reads: Record<string, MarketRead | undefined>;
  minimum: BasketMinimum;
  /** Issues per form row (already mapped from leg indices). */
  rowIssues: Map<number, BasketIssue[]>;
  idPrefix: string;
}

/** The legs as an editable ledger: a market, long or short, and a weight, with what the venue says about each. */
export function LegsEditor({ rows, setRows, markets, registered, rules, reads, minimum, rowIssues, idPrefix }: Props) {
  const added = useRef(0);
  const options = Object.entries(markets).sort((a, b) => a[1].symbol.localeCompare(b[1].symbol));
  const set = (key: string, patch: Partial<BasketRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));
  const perLeg = minimum.status === "ok" ? new Map(minimum.minimum.perLeg.map((p) => [p.pool.toLowerCase(), p])) : new Map();
  const binding = minimum.status === "ok" ? minimum.minimum.bindingPool.toLowerCase() : null;

  return (
    <div className={styles.legs}>
      <ol className={styles.rows} aria-label="Legs">
        {rows.map((r, i) => {
          const id = `${idPrefix}-${r.key}`;
          const pool = r.pool ? r.pool.toLowerCase() : "";
          const read = pool ? reads[pool] : undefined;
          const meta = pool ? markets[pool] : undefined;
          const issues = rowIssues.get(i) ?? [];
          const leg = perLeg.get(pool);
          let facts: string | null = null;
          if (pool && read?.status === "ok") {
            const m = read.market;
            const parts = [`mark ${fmtPrice18(m.mark)}`, `min order ${fmtUnits(minOrderQty(m), decimalsOf(m.oneBase))}${meta ? ` ${meta.symbol}` : ""}`];
            if (leg) parts.push(`opens from ${fmtUsd18(leg.minAllocation, "up")}`);
            facts = parts.join(" · ");
          } else if (pool && read?.status === "error") facts = "the pool did not answer: its mark and minimum order are unknown";
          else if (pool) facts = "reading the pool…";
          return (
            <li key={r.key} className={styles.row} data-invalid={issues.some((x) => x.severity === "error") ? "" : undefined}>
              <span className={styles.idx} aria-hidden="true">
                {i + 1}
              </span>
              <div className={styles.pick}>
                <label className="sr-only" htmlFor={`${id}-m`}>
                  Market for leg {i + 1}
                </label>
                <select id={`${id}-m`} className={styles.select} value={pool} onChange={(e) => set(r.key, { pool: e.target.value as Address | "" })}>
                  <option value="">Choose a market</option>
                  {options.map(([p, m]) => (
                    <option key={p} value={p} disabled={registered[p] === false}>
                      {m.symbol}-PERP{registered[p] === false ? " · not registered" : ""}
                    </option>
                  ))}
                  {pool && !meta && <option value={pool}>{shortHex(pool)}</option>}
                </select>
              </div>
              <Segmented
                name={`${id}-side`}
                label={`Side of leg ${i + 1}`}
                value={r.side}
                onChange={(v) => set(r.key, { side: v })}
                options={[
                  { value: "long", label: "Long" },
                  { value: "short", label: "Short" },
                ]}
              />
              <span className={`${f.input} ${styles.weight}`}>
                <label className="sr-only" htmlFor={`${id}-w`}>
                  Weight of leg {i + 1}, percent
                </label>
                <input
                  id={`${id}-w`}
                  value={r.weight}
                  onChange={(e) => set(r.key, { weight: e.target.value })}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0"
                  aria-invalid={issues.some((x) => x.severity === "error") ? true : undefined}
                />
                <span aria-hidden="true">%</span>
              </span>
              <button type="button" className={styles.remove} onClick={() => remove(r.key)} aria-label={`Remove leg ${i + 1}`}>
                <span aria-hidden="true">×</span>
              </button>
              {(facts || (binding && binding === pool && rows.length > 1)) && (
                <p className={styles.facts}>
                  {facts}
                  {binding === pool && rows.length > 1 && leg && <span className={styles.sets}> · sets the minimum</span>}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <div className={styles.add}>
        <button type="button" className={f.apply} onClick={() => {
            // the key is taken outside the updater, which React may run twice
            const row = blankRow(`a${++added.current}`);
            setRows((rs) => [...rs, row]);
          }} disabled={rows.length >= rules.maxLegs}>
          Add a leg
        </button>
        <span className={f.hint}>{rows.length >= rules.maxLegs ? `${rules.maxLegs} legs is the registry's limit` : `${rows.length} of ${rules.maxLegs} legs`}</span>
      </div>
    </div>
  );
}

const KIND: Record<BasketIssue["severity"], string> = { error: "Refused", checking: "Checking", wait: "Wait" };

/** What would stop the transaction, before it is signed: each named by the registry error it mirrors, or the app's own rule. */
export function IssueList({ issues, onFix, label }: { issues: readonly BasketIssue[]; onFix?: (row: number, weight: string) => void; label: string }) {
  return (
    <div aria-live="polite">
      {issues.length > 0 && (
        <ul className={f.reasons} aria-label={label}>
          {issues.map((x, i) => (
            <li key={`${x.code}-${x.row ?? ""}-${i}`} className={`${f.reason} ${x.severity === "error" ? f.error : f.warning}`} data-reason={x.code} data-severity={x.severity}>
              <span className={f.rmark} aria-hidden="true" />
              <div>
                <p className={f.rtext}>
                  <span className={f.rkind}>{KIND[x.severity]}</span>
                  {x.message}
                </p>
                {x.fix && onFix && (
                  <p className={f.rneeds}>
                    <button type="button" className={f.apply} onClick={() => onFix(x.fix!.row, x.fix!.weight)}>
                      Use {x.fix.weight}%
                    </button>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

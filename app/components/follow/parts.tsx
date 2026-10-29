"use client";

import type { ReactNode } from "react";
import type { PreflightReason } from "@copybook/sdk";
import { txUrl } from "@/lib/explorer";
import { STEP_LABEL, type FlowView, type StepId } from "@/lib/follow/flow";
import type { FormField } from "@/lib/follow/policyForm";
import { reasonView } from "@/lib/follow/reasons";
import type { TxPhase } from "@/lib/follow/tx";
import { fmtInt, shortHex } from "@/lib/format";
import type { MarketMeta } from "@/lib/tape";
import styles from "./Flow.module.css";

/** The steps in order, each marked done, current, to do or skipped, with a short note from the chain. */
export function StepList({ view, notes, label }: { view: FlowView; notes: Partial<Record<StepId, string>>; label: string }) {
  return (
    <ol className={styles.steps} aria-label={label}>
      {view.steps.map((s) => (
        <li key={s.id} className={styles[s.state]} aria-current={s.state === "current" ? "step" : undefined}>
          <span className={styles.marker} aria-hidden="true" />
          <span className={styles.stepLabel}>
            {STEP_LABEL[s.id]}
            <span className="sr-only">, {s.state === "todo" ? "to do" : s.state}</span>
          </span>
          <span className={styles.stepNote}>{notes[s.id] ?? (s.state === "skipped" ? "skipped" : "")}</span>
        </li>
      ))}
    </ol>
  );
}

const KIND: Record<PreflightReason["severity"], string> = { error: "Refused", warning: "Note", info: "About" };

/** Preflight reasons, errors first: each says what would happen, the market, the least value that clears it, and a fix. */
export function ReasonList({
  reasons,
  markets,
  recommendedAllocation,
  onApply,
  label,
}: {
  reasons: readonly PreflightReason[];
  markets: Record<string, MarketMeta>;
  recommendedAllocation?: bigint;
  onApply?: (field: FormField | "tank", value: string) => void;
  label: string;
}) {
  return (
    <div aria-live="polite">
      {reasons.length > 0 && (
    <ul className={styles.reasons} aria-label={label}>
      {reasons.map((r) => {
        const v = reasonView(r, markets, recommendedAllocation);
        return (
          <li key={v.key} className={`${styles.reason} ${styles[v.severity]}`} data-reason={v.code} data-severity={v.severity}>
            <span className={styles.rmark} aria-hidden="true" />
            <div>
              <p className={styles.rtext}>
                <span className={styles.rkind}>{KIND[v.severity]}</span>
                {v.market && <span className={styles.rmarket}>{v.market}</span>}
                {v.message}
              </p>
              {(v.needs || v.apply) && (
                <p className={styles.rneeds}>
                  {v.needs && <span>{v.needs}</span>}
                  {v.apply && onApply && (
                    <button type="button" className={styles.apply} onClick={() => onApply(v.apply!.field, v.apply!.value)}>
                      {v.apply.label}
                    </button>
                  )}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
      )}
    </div>
  );
}

/** One line about the step's transaction: waiting for the wallet, sent, landed, declined or failed. */
export function TxLine({ tx, recalled }: { tx: TxPhase; recalled?: boolean }) {
  let body: ReactNode = null;
  let tone = "";
  switch (tx.phase) {
    case "idle":
      return <div aria-live="polite" />;
    case "signing":
      tone = styles.pending;
      body = "Confirm in your wallet…";
      break;
    case "pending":
      tone = styles.pending;
      body = (
        <>
          {recalled ? "Sent before this page loaded" : "Sent"} · waiting for the block ·{" "}
          <a href={txUrl(tx.hash)} target="_blank" rel="noopener noreferrer">
            {shortHex(tx.hash, 6, 4)} ↗
          </a>
        </>
      );
      break;
    case "confirmed":
      tone = styles.ok;
      body = (
        <>
          Landed in block #{fmtInt(tx.block)} ·{" "}
          <a href={txUrl(tx.hash)} target="_blank" rel="noopener noreferrer">
            view ↗
          </a>{" "}
          · reading the chain again
        </>
      );
      break;
    case "rejected":
      tone = styles.bad;
      body = "You declined in the wallet. Nothing was sent.";
      break;
    case "failed":
      tone = styles.bad;
      body = (
        <>
          {tx.message}
          {tx.hash && (
            <>
              {" "}
              <a href={txUrl(tx.hash)} target="_blank" rel="noopener noreferrer">
                view ↗
              </a>
            </>
          )}
        </>
      );
      break;
  }
  return (
    <div aria-live="polite">
      <p className={`${styles.tx} ${tone}`} role={tx.phase === "failed" ? "alert" : "status"} data-tx={tx.phase}>
        <i aria-hidden="true" />
        <span>{body}</span>
      </p>
    </div>
  );
}

/** A row of the editable ledger: italic label, dotted leader, an input with its unit. */
export function Field({
  id,
  label,
  value,
  onChange,
  prefix,
  suffix,
  help,
  error,
  placeholder,
  inputMode = "decimal",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  help?: ReactNode;
  error?: string;
  placeholder?: string;
  inputMode?: "decimal" | "numeric";
}) {
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  return (
    <div className={styles.field} data-invalid={error ? "" : undefined}>
      <div className={styles.fieldLine}>
        <label htmlFor={id}>{label}</label>
        <span className={styles.leader} aria-hidden="true" />
        <span className={styles.input}>
          {prefix && <span aria-hidden="true">{prefix}</span>}
          <input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            inputMode={inputMode}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={[help ? helpId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined}
          />
          {suffix && <span aria-hidden="true">{suffix}</span>}
        </span>
      </div>
      {help && (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      )}
      <div aria-live="polite">
        {error && (
          <p id={errId} className={styles.fieldErr}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** Two (or more) choices as pills; a native radio group underneath. */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
}: {
  name: string;
  value: T;
  options: { value: T; label: string; gold?: boolean }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={styles.seg} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={o.gold ? styles.goldOn : undefined}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** The exact call a button sends, in mono. */
export const Call = ({ children, label = "The exact call" }: { children: ReactNode; label?: string }) => (
  <code className={styles.call} aria-label={label}>
    {children}
  </code>
);

export const Lead = ({ children }: { children: ReactNode }) => <p className={styles.lead}>{children}</p>;
export const Acts = ({ children }: { children: ReactNode }) => <div className={styles.acts}>{children}</div>;
export const Hint = ({ children }: { children: ReactNode }) => <span className={styles.hint}>{children}</span>;
export const Block = ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
  <div className={styles.block}>
    {title && <h3 className={styles.sub}>{title}</h3>}
    {children}
  </div>
);
export const Notes = ({ children }: { children: ReactNode }) => <ul className={styles.notes}>{children}</ul>;

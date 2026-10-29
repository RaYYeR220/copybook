"use client";

import type { Address } from "viem";
import type { SourceKindName } from "@copybook/sdk";
import { errorFor, type FieldError, type FormField, type PolicyFormValues } from "@/lib/follow/policyForm";
import { shortHex } from "@/lib/format";
import type { MarketMeta } from "@/lib/tape";
import { Field, Segmented } from "./parts";
import styles from "./Flow.module.css";

interface Props {
  kind: SourceKindName;
  values: PolicyFormValues;
  onChange: (next: PolicyFormValues) => void;
  errors: readonly FieldError[];
  /** pool (lower-case) → name: every perp market the indexer lists, for the market list. */
  markets: Record<string, MarketMeta>;
  /** Trader follows: the markets the trader holds now (listed first). */
  held?: readonly Address[];
  /** Prefix for input ids, so two forms can share a page. */
  idPrefix?: string;
  /** Whether the market list can change (only at follow time: `updatePolicy` keeps the follow's markets). */
  marketsEditable?: boolean;
}

const lc = (a: string) => a.toLowerCase();

/** The policy as an editable ledger: the same rows the dashboard's policy ledger shows, with inputs. */
export function PolicyFields({ kind, values, onChange, errors, markets, held = [], idPrefix = "p", marketsEditable = true }: Props) {
  const set = (patch: Partial<PolicyFormValues>) => onChange({ ...values, ...patch });
  const err = (f: FormField) => errorFor(errors, f);
  const id = (f: string) => `${idPrefix}-${f}`;

  const heldSet = new Set(held.map(lc));
  const options = Object.entries(markets)
    .map(([pool, m]) => ({ pool, name: `${m.symbol}-PERP`, held: heldSet.has(pool) }))
    .sort((a, b) => Number(b.held) - Number(a.held) || a.name.localeCompare(b.name));
  // a held market the indexer does not name still belongs on the list
  for (const p of held) if (!markets[lc(p)]) options.unshift({ pool: lc(p), name: shortHex(p), held: true });
  const chosen = new Set(values.pools.map(lc));

  return (
    <div className={styles.fields}>
      {kind === "Trader" ? (
        <Field
          id={id("scale")}
          label="Scale"
          value={values.scale}
          onChange={(v) => set({ scale: v })}
          suffix="×"
          help="Your size is theirs times this, rounded toward zero like the hub does. 1 = the same size."
          error={err("scale")}
        />
      ) : (
        <Field
          id={id("allocation")}
          label="Allocation"
          value={values.allocation}
          onChange={(v) => set({ allocation: v })}
          prefix="$"
          help="The notional the thesis weights apply to. Every leg is sized from it, short legs included."
          error={err("allocation")}
        />
      )}
      <Field
        id={id("maxNotional")}
        label="Cap per position"
        value={values.maxNotional}
        onChange={(v) => set({ maxNotional: v })}
        prefix="$"
        help="The largest position the hub builds for you in one market. A copy above it is capped, not refused."
        error={err("maxNotional")}
      />
      <Field
        id={id("maxTotalNotional")}
        label="Total cap"
        value={values.maxTotalNotional}
        onChange={(v) => set({ maxTotalNotional: v })}
        prefix="$"
        placeholder="none"
        help="The largest whole book. An increase that would pass it is refused. Empty: no total cap."
        error={err("maxTotalNotional")}
      />
      <Field
        id={id("band")}
        label="Price band"
        value={values.band}
        onChange={(v) => set({ band: v })}
        suffix="%"
        help="How far past the mark an increase may fill (all-or-nothing). No fill inside it is a Band refusal. Exits get twice the band, at least 1%."
        error={err("band")}
      />
      <Field
        id={id("equityFloor")}
        label="Equity floor"
        value={values.equityFloor}
        onChange={(v) => set({ equityFloor: v })}
        prefix="$"
        placeholder="off"
        help="Below this account equity the follow stops and closes what it opened. Empty: off."
        error={err("equityFloor")}
      />
      {kind === "Trader" && marketsEditable && (
        <div className={styles.field}>
          <div className={styles.choiceLine}>
            <span className={styles.fieldLabel} id={id("markets-l")}>
              Markets
            </span>
            <Segmented
              name={id("allow")}
              label="Which markets to mirror"
              value={values.allowAll ? "all" : "list"}
              onChange={(v) => set({ allowAll: v === "all" })}
              options={[
                { value: "all", label: "Whole book" },
                { value: "list", label: "Chosen markets" },
              ]}
            />
          </div>
          <p className={styles.help}>
            {values.allowAll
              ? "Mirrors the trader's whole book, including positions already open: each market they hold is brought to their size at their next move there (or when you run catchUp), and every market they trade later is managed too."
              : "Only these markets. The follow transaction copies the trader's current positions in them right away; other markets stay yours."}
          </p>
          {!values.allowAll && (
            <ul className={styles.markets} aria-labelledby={id("markets-l")}>
              {options.map((o) => (
                <li key={o.pool}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(o.pool)}
                      onChange={(e) =>
                        set({ pools: e.target.checked ? [...values.pools, o.pool as Address] : values.pools.filter((p) => lc(p) !== o.pool) })
                      }
                    />
                    {o.name}
                    {o.held && <span className={styles.held}>held now</span>}
                  </label>
                </li>
              ))}
              {options.length === 0 && <li className={styles.help}>The dreamDEX indexer did not list any perp market just now.</li>}
            </ul>
          )}
          {err("markets") && <p className={styles.fieldErr}>{err("markets")}</p>}
        </div>
      )}
    </div>
  );
}

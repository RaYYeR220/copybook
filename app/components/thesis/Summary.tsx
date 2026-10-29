"use client";

import type { Address } from "viem";
import type { Leg } from "@copybook/sdk";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { bpsToPct, type RegistryRules } from "@/lib/builder/basket";
import type { BasketMinimum } from "@/lib/builder/registry";
import { shortHex } from "@/lib/format";
import { grossBps, netBps } from "@/lib/thesis";
import { fmtUsd18 } from "@/lib/units";
import f from "@/components/follow/Flow.module.css";
import styles from "./Builder.module.css";

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** The basket's shape against the registry's limits. Every figure is the legs as typed. */
export function ShapeLedger({ legs, rules }: { legs: readonly Leg[]; rules: RegistryRules }) {
  const gross = grossBps(legs);
  const net = netBps(legs);
  const rows: LedgerRow[] = [
    { label: "Legs", value: <b>{`${legs.length} of ${rules.maxLegs}`}</b> },
    { label: "Gross", value: <b>{`${bpsToPct(gross)}%`}</b>, note: `long and short together · the registry allows ${bpsToPct(rules.maxGrossBps)}%` },
    { label: "Net", value: net === 0 ? "flat" : `${bpsToPct(net)}% ${net > 0 ? "long" : "short"}` },
  ];
  return <Ledger size="md" rows={rows} />;
}

/**
 * The least allocation a follower needs for every leg to open, as the basket is edited: one minimum order per leg
 * at the marks just read, the largest of them, with 10% headroom beside it.
 */
export function MinimumBox({ minimum, readAt, label, caption }: { minimum: BasketMinimum; readAt?: number; label: (pool: Address) => string; caption?: string }) {
  if (minimum.status === "empty") return <p className={f.checking}>Add a leg with a weight to see the least a follower needs.</p>;
  if (minimum.status === "reading")
    return (
      <p className={f.checking} role="status">
        Reading {minimum.pools.map(label).join(", ")} from the venue…
      </p>
    );
  if (minimum.status === "unavailable")
    return (
      <p className={f.checking} role="status">
        {minimum.pools.map(label).join(", ")} {minimum.why === "unreadable" ? "did not answer" : "reports no usable mark or order size"}, so the least allocation is unknown. A follow
        form checks it again before anyone signs.
      </p>
    );
  const m = minimum.minimum;
  return (
    <div className={styles.minWrap} data-minimum={m.allocation.toString()}>
      {caption && <p className={styles.minCap}>{caption}</p>}
      <div className={f.min}>
        <div>
          Opens from<b>{fmtUsd18(m.allocation, "up")}</b>
        </div>
        <div>
          With headroom<b>{fmtUsd18(minimum.recommended, "up")}</b>
        </div>
        <div>
          Cap per position<b>{`≥ ${fmtUsd18(m.maxNotional, "up")}`}</b>
        </div>
      </div>
      <p className={f.help}>
        One minimum order in every leg at the marks read{readAt ? ` at ${hhmmss(readAt)} UTC` : ""}; {label(m.bindingPool)} sets it. Below it the hub opens no leg at all. Marks move, so
        followers see the figure with 10% headroom.
      </p>
    </div>
  );
}

/** The call the wallet will be asked to sign, legs as (pool, weight in bps). */
export function LegsCall({ fn, head, legs, label }: { fn: string; head: string[]; legs: readonly Leg[]; label: (pool: Address) => string }) {
  return (
    <>
      <b>{fn}</b>({[...head, `[${legs.map((l) => `(${label(l.pool)} ${shortHex(l.pool)}, ${l.weightBps})`).join(", ")}]`].join(", ")})
    </>
  );
}

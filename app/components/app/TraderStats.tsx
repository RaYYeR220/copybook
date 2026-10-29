import type { Address } from "viem";
import { IndexerError, riskRubric, type TraderStats as Stats } from "@copybook/stats";
import { Ledger } from "@/components/Ledger";
import { fmtInt } from "@/lib/format";
import { traderStats } from "@/lib/server/indexer";
import { fmtFixed, fmtPnl } from "@/lib/units";
import { DataState } from "./State";
import styles from "./TraderStats.module.css";

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function rows(s: Stats) {
  return [
    { label: "Realized PnL", value: <b className={styles.fig}>{fmtPnl(s.realizedPnl30d)}</b>, note: `USDso over ${s.windowDays} days, liquidation losses included` },
    { label: "Trades", value: <b>{fmtInt(s.trades30d)}</b>, note: "position changes, liquidations left out" },
    { label: "Active days", value: `${s.activeDays30d} of ${s.windowDays}` },
    { label: "Markets", value: String(s.marketsTraded) },
    { label: "Liquidations", value: <b>{s.liquidations30d}</b> },
    {
      label: "Max drawdown",
      value: s.maxDrawdownAbs30d === null ? "n/a" : `${fmtFixed(s.maxDrawdownAbs30d)} USDso${s.maxDrawdownPct30d === null ? "" : ` · ${s.maxDrawdownPct30d}%`}`,
      note: "deepest fall of realized PnL",
    },
    { label: "Avg leverage", value: s.avgLeverage === null ? "n/a" : `${s.avgLeverage}×`, note: s.avgLeverage === null ? "too few explicit leverage settings to say" : undefined },
    { label: "Last active", value: s.lastActiveAt ? utc(s.lastActiveAt) : "n/a" },
  ];
}

/** The trader's 30-day record from the dreamDEX indexer, and the exact line the validators' rubric reads. */
export async function TraderStats({ trader }: { trader: Address }) {
  let s: Stats;
  try {
    s = await traderStats(trader);
  } catch (err) {
    return (
      <DataState kind="unavailable" title="The dreamDEX indexer did not answer.">
        {err instanceof IndexerError ? "These stats are unknown, not zero." : "The stats could not be computed."} The verdict below is read from the chain and does not depend on it.
      </DataState>
    );
  }
  if (!s.hasHistory)
    return (
      <DataState kind="empty" title={`No trades in the last ${s.windowDays} days.`}>
        The indexer has no position changes for this account in the window{s.lastActiveAt ? `; last active ${utc(s.lastActiveAt)}` : ""}.
      </DataState>
    );
  return (
    <div className={styles.wrap}>
      <Ledger size="md" rows={rows(s)} />
      <p className={styles.rubric}>
        <span>What the validators read</span>
        <code>{riskRubric(s)}</code>
        {s.truncated && <span>Figures cover the most recent rows only (the row cap was reached).</span>}
      </p>
    </div>
  );
}

export function TraderStatsLoading() {
  return <DataState kind="loading" title="Reading 30 days of trades from the dreamDEX indexer…" />;
}

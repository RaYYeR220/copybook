"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getAddress } from "viem";
import type { RankedTrader, TraderStats } from "@copybook/stats";
import { fmtInt, shortHex } from "@/lib/format";
import type { TradersPayload } from "@/lib/server/traders";
import { fmtFixed, fmtPnl } from "@/lib/units";
import { PanelNote } from "./Panel";
import { DataState } from "./State";
import t from "./Table.module.css";

class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function load(): Promise<TradersPayload> {
  const res = await fetch("/api/traders");
  const body = (await res.json().catch(() => ({}))) as TradersPayload & { error?: string };
  if (!res.ok) throw new RouteError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

const dd = (s: TraderStats) => (s.maxDrawdownAbs30d === null ? "n/a" : fmtFixed(s.maxDrawdownAbs30d));
const utc = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

function Row({ r }: { r: RankedTrader }) {
  const a = getAddress(r.trader);
  const s = r.stats;
  return (
    <tr>
      <td className={t.rank}>{r.rank}</td>
      <td className={t.name}>
        <Link href={`/t/${a}`} title={a} className={t.addr} prefetch={false}>
          {shortHex(a)}
        </Link>
      </td>
      <td className={`${t.fig} ${t.num}`} data-label="PnL">
        {fmtPnl(r.realizedPnl30d)}
      </td>
      <td className={t.num} data-label="Trades">
        <b>{fmtInt(s.trades30d)}</b>
      </td>
      <td className={t.num} data-label="Days">
        {s.activeDays30d}
      </td>
      <td className={t.num} data-label="Markets">
        {s.marketsTraded}
      </td>
      <td className={t.num} data-label="Liq.">
        {s.liquidations30d}
      </td>
      <td className={t.num} data-label="Max DD">
        {dd(s)}
      </td>
    </tr>
  );
}

/**
 * Top dreamDEX traders by 30-day realized PnL (the /api/traders ranking), and Copybook's demo leader, labelled.
 * `initial` is the same ranking when the server had it cached at render time.
 */
export function TopTraders({ initial }: { initial?: TradersPayload }) {
  const q = useQuery({ queryKey: ["traders"], queryFn: load, staleTime: 300_000, retry: 1, initialData: initial });

  if (q.isPending)
    return (
      <DataState kind="loading" title="Ranking traders from the dreamDEX indexer…">
        Each candidate's 30-day history is read one request at a time. A cold ranking takes up to a minute; after that it is cached for five minutes.
      </DataState>
    );
  if (q.isError) {
    const indexer = q.error instanceof RouteError && q.error.status === 502;
    return (
      <DataState kind="unavailable" title={indexer ? "The dreamDEX indexer did not answer, so there is no ranking right now." : "The ranking could not be loaded."}>
        {indexer
          ? "This is not an empty market. The list returns when the indexer answers; trader and thesis pages still read the chain."
          : q.error.message}
      </DataState>
    );
  }

  const d = q.data;
  const r = d.rules;
  const demo = d.demo.stats;
  return (
    <>
      {d.traders.length === 0 ? (
        <DataState kind="empty" title={`No trader passed the filters over the last ${d.windowDays} days.`}>
          At least {r.minTrades} trades on {r.minActiveDays} days and at most {r.maxLiquidations} liquidation; {d.skipped.length} candidates could not be read.
        </DataState>
      ) : (
        <table className={t.table}>
          <caption className="sr-only">Top traders by realized PnL over {d.windowDays} days</caption>
          <thead>
            <tr>
              <th scope="col" className={t.rank}>
                #
              </th>
              <th scope="col">Trader</th>
              <th scope="col" className={t.num}>
                Realized PnL
              </th>
              <th scope="col" className={t.num}>
                Trades
              </th>
              <th scope="col" className={t.num}>
                Days
              </th>
              <th scope="col" className={t.num}>
                Markets
              </th>
              <th scope="col" className={t.num}>
                Liq.
              </th>
              <th scope="col" className={t.num}>
                Max DD
              </th>
            </tr>
          </thead>
          <tbody>
            {d.traders.map((x) => (
              <Row key={x.trader} r={x} />
            ))}
          </tbody>
        </table>
      )}

      <table className={`${t.table} ${t.sub}`}>
        <caption className="sr-only">Copybook's demo leader</caption>
        <tbody>
          <tr>
            <td className={t.rank} aria-hidden="true">
              ·
            </td>
            <td className={`${t.name} ${t.full}`}>
              <Link href={`/t/${d.demo.trader}`} title={d.demo.trader} className={t.addr} prefetch={false}>
                {shortHex(d.demo.trader)}
              </Link>
              <span className={t.tag}>demo leader · ours</span>
            </td>
            {demo ? (
              <>
                <td className={`${t.fig} ${t.num}`} data-label="PnL">
                  {fmtPnl(demo.realizedPnl30d)}
                </td>
                <td className={t.num} data-label="Trades">
                  <b>{fmtInt(demo.trades30d)}</b>
                </td>
                <td className={t.num} data-label="Days">
                  {demo.activeDays30d}
                </td>
                <td className={t.num} data-label="Markets">
                  {demo.marketsTraded}
                </td>
                <td className={t.num} data-label="Liq.">
                  {demo.liquidations30d}
                </td>
                <td className={t.num} data-label="Max DD">
                  {dd(demo)}
                </td>
              </>
            ) : (
              <td className={`${t.full} ${t.dim}`} colSpan={6}>
                the indexer did not answer for this wallet
              </td>
            )}
          </tr>
        </tbody>
      </table>

      <PanelNote>
        Ranked by realized PnL over {d.windowDays} days, in USDso, from the dreamDEX indexer, at {utc(d.asOf)}. Candidates are the {r.candidates} accounts behind the largest single gains; each
        needs {r.minTrades}+ trades on {r.minActiveDays}+ days and at most {r.maxLiquidations} liquidation. Max DD is the deepest fall of realized PnL. Copybook's own wallets and every wallet
        that follows through the hub are left out
        {d.removedFollowers.length > 0 && <> ({d.removedFollowers.length} removed)</>}
        {d.followerExclusion === "partial" && <>, as far as the hub&apos;s log had been read when this ranking ran</>}
        {d.followerExclusion === "unavailable" && <>; the hub&apos;s log could not be read for this ranking, so copy wallets may still be listed</>}. The demo leader is a wallet Copybook trades to show copies landing live; it is not ranked.
        {d.candidateShortfall && <> Fewer than {r.candidates} candidates turned up within the page budget, so the list can be shorter.</>}
        {d.skipped.length > 0 && <> {d.skipped.length} candidates could not be read and are left out.</>}
      </PanelNote>
    </>
  );
}

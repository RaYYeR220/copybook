import type { Address } from "viem";
import { addressUrl } from "@/lib/explorer";
import { fmtInt, shortHex } from "@/lib/format";
import type { Position } from "@/lib/positions";
import { openPositions } from "@/lib/server/indexer";
import { fmtPrice18, fmtUnits, fmtUsd18 } from "@/lib/units";
import { PanelNote } from "./Panel";
import { DataState } from "./State";
import t from "./Table.module.css";

const dash = <span className={t.dim}>—</span>;

/** The trader's open perp positions as the dreamDEX indexer last saw them. Following copies all of them. */
export async function Positions({ trader }: { trader: Address }) {
  let rows: Position[];
  try {
    rows = await openPositions(trader);
  } catch {
    return (
      <DataState kind="unavailable" title="The dreamDEX indexer did not answer.">
        Open positions are unknown right now, which is not the same as flat.
      </DataState>
    );
  }
  if (rows.length === 0)
    return (
      <DataState kind="empty" title="Flat: no open perp positions.">
        As the dreamDEX indexer last saw this account. A new follower starts with nothing to mirror until the trader opens a position.
      </DataState>
    );
  return (
    <>
      <table className={t.table}>
        <caption className="sr-only">Open positions</caption>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Side</th>
            <th scope="col" className={t.num}>
              Size
            </th>
            <th scope="col" className={t.num}>
              Entry
            </th>
            <th scope="col" className={t.num}>
              Mark
            </th>
            <th scope="col" className={t.num}>
              Notional
            </th>
            <th scope="col" className={t.num}>
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pool}>
              <td className={t.name}>
                {p.market ?? (
                  <a href={addressUrl(p.pool)} className={t.addr} target="_blank" rel="noopener noreferrer">
                    {shortHex(p.pool)}
                  </a>
                )}
              </td>
              <td data-label="Side">
                <b>{p.side}</b>
              </td>
              <td className={t.num} data-label="Size">
                <b>{p.decimals === null ? `${p.size} units` : fmtUnits(p.size, p.decimals)}</b>
              </td>
              <td className={t.num} data-label="Entry">
                {p.entryPrice ? fmtPrice18(p.entryPrice) : dash}
              </td>
              <td className={t.num} data-label="Mark">
                {p.markPrice ? fmtPrice18(p.markPrice) : dash}
              </td>
              <td className={t.num} data-label="Notional">
                {p.notional !== null ? fmtUsd18(p.notional) : dash}
              </td>
              <td className={t.num} data-label="Block">
                {p.updatedAtBlock ? `#${fmtInt(p.updatedAtBlock)}` : dash}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PanelNote>
        From the dreamDEX indexer; mark and notional use the indexer&apos;s last mark. A trader follow mirrors every open position, scaled by your multiplier, within your caps.
      </PanelNote>
    </>
  );
}

export function PositionsLoading() {
  return <DataState kind="loading" title="Reading open positions from the dreamDEX indexer…" />;
}

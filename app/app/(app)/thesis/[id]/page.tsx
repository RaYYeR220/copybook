import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { minOrderQty, sourceIdOf } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { FollowerStep } from "@/components/app/FollowerStep";
import { HubFeedProvider } from "@/components/app/HubFeed";
import { FeedStatusLine, TapeRows, type TapeNames } from "@/components/app/LiveTape";
import { NotFoundSource } from "@/components/app/NotFoundSource";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { SourceActs, SourceLedger, SourceLine, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { DataState } from "@/components/app/State";
import { RebalancePanel } from "@/components/thesis/Rebalance";
import t from "@/components/app/Table.module.css";
import { safeUri } from "@/lib/builder/basket";
import { addressUrl } from "@/lib/explorer";
import { shortHex } from "@/lib/format";
import { config } from "@/lib/server/config";
import { perpMarkets } from "@/lib/server/indexer";
import { registeredPools, registryBank, registryRules } from "@/lib/server/registry";
import { isOwner, loadThesis, type Thesis } from "@/lib/server/theses";
import { decimalsOf, grossBps, legSide, netBps, pctOfBps } from "@/lib/thesis";
import { toJsonSafe } from "@/lib/json";
import { fmtPrice18, fmtUnits, fmtUsd18 } from "@/lib/units";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
const ID_RE = /^[0-9]{1,9}$/;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  if (!ID_RE.test(id) || BigInt(id) === 0n) notFound();
  const thesis = await loadThesis(BigInt(id)).catch(() => undefined);
  if (thesis === undefined) return { title: `Thesis #${id}` };
  if (!thesis) notFound();
  const title = `${thesis.name} · thesis #${id}`;
  const description = `The legs, version and minimum allocation of thesis #${id} on dreamDEX perps.`;
  const image = { url: `/og/thesis/${id}`, width: 1200, height: 630, alt: `${thesis.name}: thesis #${id} on Copybook, its legs and the least allocation that opens them` };
  return { title, description, openGraph: { title, description, images: [image] }, twitter: { card: "summary_large_image", title, description, images: [image] } };
}

function legRows(thesis: Thesis, names: Record<string, { symbol: string }>) {
  const markets = new Map(thesis.minimum?.markets.map((m) => [m.pool.toLowerCase(), m]) ?? []);
  const per = new Map(thesis.minimum?.perLeg.map((p) => [p.pool.toLowerCase(), p]) ?? []);
  return thesis.legs.map((l) => {
    const key = l.pool.toLowerCase();
    const sym = names[key]?.symbol;
    const m = markets.get(key);
    const p = per.get(key);
    const dec = m ? decimalsOf(m.oneBase) : null;
    return {
      pool: l.pool,
      market: sym ? `${sym}-PERP` : null,
      ...legSide(l.weightBps),
      mark: m ? fmtPrice18(m.mark) : null,
      minOrder: m && dec !== null ? `${fmtUnits(minOrderQty(m), dec)}${sym ? ` ${sym}` : ""}` : null,
      opensFrom: p ? fmtUsd18(p.minAllocation, "up") : null,
      binding: thesis.minimum?.bindingPool.toLowerCase() === key,
    };
  });
}

export default async function ThesisPage({ params }: Params) {
  const raw = decodeURIComponent((await params).id);
  if (!ID_RE.test(raw) || BigInt(raw) === 0n) notFound();
  const id = BigInt(raw);
  const [thesisR, marketsR, rulesR, bankR] = await Promise.allSettled([loadThesis(id), perpMarkets(), registryRules(), registryBank()]);
  if (thesisR.status === "rejected")
    return (
      <NotFoundSource kick={`Thesis #${id}`} title="Registry unreadable">
        The ThemeRegistry could not be read from the chain just now, so this thesis is unknown, not missing. Reload in a moment.
      </NotFoundSource>
    );
  const thesis = thesisR.value;
  if (!thesis) notFound();

  const markets = marketsR.status === "fulfilled" ? marketsR.value : {};
  const registered = await registeredPools(Object.keys(markets)).catch(() => ({}) as Record<string, boolean>);
  const writeUp = thesis.uri ? safeUri(thesis.uri) : null;
  const legs = legRows(thesis, markets);
  const min = thesis.minimum;
  const byOwner = config.owner ? isOwner(thesis.creator, config.owner) : false;
  const net = netBps(thesis.legs);
  const ledger: LedgerRow[] = [
    { label: "Legs", value: `${thesis.legs.length} · gross ${pctOfBps(grossBps(thesis.legs))} · net ${pctOfBps(Math.abs(net))} ${net >= 0 ? "long" : "short"}` },
    { label: "Version", value: <b>v{thesis.version}</b>, note: "each rebalance bumps it" },
  ];
  if (min) {
    ledger.push(
      { label: "Opens from", value: <b>{fmtUsd18(min.allocation, "up")}</b>, note: "every leg opens at the marks as this page loaded" },
      { label: "With headroom", value: fmtUsd18(min.recommended, "up"), note: "10% over, for marks that move before your follow lands" },
      { label: "Cap per position", value: `at least ${fmtUsd18(min.maxNotional, "up")}`, note: "a lower cap clamps a leg below one order" },
    );
  }
  const names: TapeNames = {
    markets,
    theses: [{ id: id.toString(), name: thesis.name }],
    traders: { [config.demoLeader.toLowerCase()]: "demo leader" },
    wallets: config.owner ? { [config.owner.toLowerCase()]: "Copybook owner" } : {},
  };

  return (
    <HubFeedProvider pub={config.publicConfig} source={id.toString()}>
      <AppMain label={`Thesis ${thesis.name}`}>
        <Col>
          <Panel id="src-h" order={1}>
            <SourceTop kick={`Thesis #${id}`} stepNode={<FollowerStep sourceId={sourceIdOf("Theme", id)} />} />
            <SourceTitle id="src-h">{thesis.name}</SourceTitle>
            <SourceLine>
              <span>by</span>{" "}
              <a href={addressUrl(thesis.creator)} target="_blank" rel="noopener noreferrer" title={thesis.creator}>
                {shortHex(thesis.creator)}
              </a>
              {byOwner && <span> · Copybook&apos;s owner wallet</span>}
              <span> · ThemeRegistry</span>
              {writeUp && (
                <>
                  <span> · </span>
                  <a href={writeUp} target="_blank" rel="noopener noreferrer nofollow">
                    write-up ↗
                  </a>
                </>
              )}
            </SourceLine>
            <SourceLedger>
              <Ledger size="md" rows={ledger} />
            </SourceLedger>
            {!min && (
              <DataState kind="unavailable" title="No minimum right now.">
                A leg&apos;s market could not be read from the venue (or reports no usable mark), so the smallest allocation is unknown. The follow form checks it again before you sign.
              </DataState>
            )}
            <SourceActs>
              <Button size="md" href={`/follow/thesis/${id}`} prefetch={false} arrow>
                Follow this thesis
              </Button>
              <Button size="md" variant="quiet" href={addressUrl(config.deployments.themes)} target="_blank">
                Registry ↗
              </Button>
            </SourceActs>
            <PanelNote>
              A thesis follow sizes every leg from your allocation, short legs included. A rebalance resizes followers&apos; legs in the rebalance&apos;s own block; catchUp finishes any the
              handler had to defer. Between versions the legs drift with prices until you resync. Exits are always copied; the AI guard applies to trader follows only.
            </PanelNote>
          </Panel>
        </Col>

        <Col>
          <Panel id="legs-h" title="Legs" aside={<Kick>v{thesis.version} · marks from the venue</Kick>} order={2} d={0.05}>
            <table className={t.table}>
              <caption className="sr-only">Legs of {thesis.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col">Side</th>
                  <th scope="col" className={t.num}>
                    Weight
                  </th>
                  <th scope="col" className={t.num}>
                    Mark
                  </th>
                  <th scope="col" className={t.num}>
                    Min order
                  </th>
                  <th scope="col" className={t.num}>
                    Opens from
                  </th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l) => (
                  <tr key={l.pool}>
                    <td className={t.name}>
                      {l.market ?? (
                        <a className={t.addr} href={addressUrl(l.pool)} target="_blank" rel="noopener noreferrer">
                          {shortHex(l.pool)}
                        </a>
                      )}
                      {l.binding && legs.length > 1 && <span className={t.tag}>sets the minimum</span>}
                    </td>
                    <td data-label="Side">
                      <b>{l.side}</b>
                    </td>
                    <td className={t.num} data-label="Weight">
                      <b>{l.pct}</b>
                    </td>
                    <td className={t.num} data-label="Mark">
                      {l.mark ?? <span className={t.dim}>—</span>}
                    </td>
                    <td className={t.num} data-label="Min order">
                      {l.minOrder ?? <span className={t.dim}>—</span>}
                    </td>
                    <td className={t.num} data-label="Opens from">
                      {l.opensFrom ?? <span className={t.dim}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <PanelNote>
              Marks, lots and minimum orders are read from each dreamDEX pool as this page loaded. “Opens from” is the smallest allocation at which that leg reaches one minimum order;
              the thesis opens from the largest of them, because the hub opens every leg or none.
              {marketsR.status === "rejected" && " Market names are missing because the dreamDEX indexer did not answer."}
            </PanelNote>
          </Panel>

          {rulesR.status === "fulfilled" && marketsR.status === "fulfilled" && (
            <RebalancePanel
              pub={config.publicConfig}
              thesis={toJsonSafe({ id, creator: thesis.creator, version: thesis.version, legs: thesis.legs })}
              markets={markets}
              registered={registered}
              bank={bankR.status === "fulfilled" ? bankR.value : null}
              rules={rulesR.value.rules}
            />
          )}

          <Panel id="act-h" title={<>On <em>Copybook</em></>} aside={<FeedStatusLine extra="follows and copies · newest first" />} order={3} d={0.1}>
            <TapeRows names={names} label={`Copybook events about thesis ${thesis.name}, newest first`} empty="Nobody has followed this thesis yet." />
          </Panel>

          <Colophon>
            Thesis #{id.toString()} · source id <b>{shortHex(sourceIdOf("Theme", id), 6, 4)}</b> · ThemeRegistry <b>{shortHex(config.deployments.themes)}</b>
          </Colophon>
        </Col>
      </AppMain>
    </HubFeedProvider>
  );
}

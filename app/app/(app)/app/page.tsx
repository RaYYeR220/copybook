import type { Metadata } from "next";
import { Suspense } from "react";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { HubFeedProvider } from "@/components/app/HubFeed";
import { FeedStatusLine, TapeRows, type TapeNames } from "@/components/app/LiveTape";
import { SourceActs, SourceLead, SourceLedger, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { DataState } from "@/components/app/State";
import { ThesisList } from "@/components/app/ThesisList";
import { TopTraders } from "@/components/app/TopTraders";
import { Button } from "@/components/Button";
import { Ledger } from "@/components/Ledger";
import { addressUrl } from "@/lib/explorer";
import { fmtInt, shortHex } from "@/lib/format";
import { publicClient } from "@/lib/server/chain";
import { config } from "@/lib/server/config";
import { perpMarkets } from "@/lib/server/indexer";
import { rankingIfReady } from "@/lib/server/ranking";
import { loadTheses, thesisNames } from "@/lib/server/theses";
import type { MarketMeta } from "@/lib/tape";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Discover",
  description: "Top dreamDEX traders by realized PnL, the theses on chain, and every copy as it lands.",
};

const RULES = [
  { label: "One wallet", value: "one source at a time" },
  { label: "Exits", value: "always copied" },
  { label: "New size", value: "inside your band and caps" },
  { label: "AI guard", value: "trader follows · on by default" },
  { label: "Copied price", value: "the limit, not the fill" },
  { label: "Network", value: "Somnia Hideki testnet" },
];

/** The ThemeRegistry's theses with their minimums at live marks. */
async function ThesesBody({ markets, marketsMissing }: { markets: Record<string, MarketMeta>; marketsMissing: boolean }) {
  let theses;
  try {
    theses = await loadTheses();
  } catch {
    return (
      <DataState kind="unavailable" title="The ThemeRegistry could not be read from the chain.">
        Theses are read live from the contract; reload in a moment.
      </DataState>
    );
  }
  if (theses.length === 0) return <DataState kind="empty" title="No thesis has been published yet." />;
  return (
    <>
      <ThesisList theses={theses} markets={markets} />
      <PanelNote>
        Minimums are the smallest allocation that opens every leg at the venue&apos;s marks as this page loaded.
        {marketsMissing && " Market names are missing because the dreamDEX indexer did not answer; pools are shown by address."}
      </PanelNote>
    </>
  );
}

export default async function Discover() {
  // the theses' minimums read every leg's market: they stream in behind Suspense; names alone are cheap
  // a ranking already in the data cache renders with the page, so the panels below it never move when it arrives
  const [theses, markets, head, ranked] = await Promise.allSettled([thesisNames(), perpMarkets(), publicClient.getBlockNumber(), rankingIfReady()]);
  const marketMap = markets.status === "fulfilled" ? markets.value : {};
  const d = config.deployments;
  const names: TapeNames = {
    markets: marketMap,
    theses: theses.status === "fulfilled" ? theses.value : [],
    traders: { [config.demoLeader.toLowerCase()]: "demo leader" },
    wallets: config.owner ? { [config.owner.toLowerCase()]: "Copybook owner" } : {},
  };

  return (
    <HubFeedProvider pub={config.publicConfig}>
      <AppMain label="Discover">
        <Col>
          <Panel id="who-h" order={1}>
            <SourceTop kick="Discover" step={head.status === "fulfilled" ? `blk #${fmtInt(head.value)} at load` : "chain not answering"} quiet />
            <SourceTitle id="who-h">Who to follow</SourceTitle>
            <SourceLead>
              A wallet follows <b>one trader</b> or <b>one thesis</b>, a weighted basket of perps. Somnia validators copy each move into that wallet&apos;s own dreamDEX account, in the
              block the move lands in.
            </SourceLead>
            <SourceLedger>
              <Ledger size="md" rows={RULES} />
            </SourceLedger>
            <PanelNote>Use a dedicated wallet: following mirrors the source&apos;s whole book, positions already open included.</PanelNote>
          </Panel>

          <Panel id="theses-h" title="Theses" aside={<Kick>ThemeRegistry · on chain</Kick>} order={4} d={0.1}>
            <Suspense fallback={<DataState kind="loading" title="Reading the ThemeRegistry and each leg's market…" />}>
              <ThesesBody markets={marketMap} marketsMissing={markets.status === "rejected"} />
            </Suspense>
            <SourceActs>
              <Button size="md" variant="quiet" href="/thesis/new" prefetch={false}>
                Publish a thesis
              </Button>
              <Button size="md" variant="quiet" href="/leaderboard" prefetch={false}>
                Leaderboard
              </Button>
            </SourceActs>
          </Panel>
        </Col>

        <Col>
          <Panel id="top-h" title="Top traders" aside={<Kick>Realized PnL · 30 days · dreamDEX indexer</Kick>} order={2} d={0.06}>
            <TopTraders initial={ranked.status === "fulfilled" ? ranked.value : undefined} />
          </Panel>

          <Panel id="tape-h" title="Live tape" aside={<FeedStatusLine extra="followed sources · newest first" />} order={3} d={0.12}>
            <TapeRows names={names} followed label="Copybook events, newest first" empty="Nobody has followed a source yet, so nothing has been copied." />
          </Panel>

          <Colophon>
            Hub{" "}
            <a href={addressUrl(d.hub)} className="lnk">
              <b>{shortHex(d.hub)}</b>
            </a>{" "}
            · ThemeRegistry <b>{shortHex(d.themes)}</b> · RiskGate <b>{shortHex(d.gate)}</b> · Somnia Hideki testnet · exits always copied
          </Colophon>
        </Col>
      </AppMain>
    </HubFeedProvider>
  );
}

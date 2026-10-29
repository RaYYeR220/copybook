import type { Metadata } from "next";
import { Suspense } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { sourceIdOf } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { FollowerStep } from "@/components/app/FollowerStep";
import { GuardPanel } from "@/components/app/Guard";
import { HubFeedProvider } from "@/components/app/HubFeed";
import { FeedStatusLine, TapeRows, type TapeNames } from "@/components/app/LiveTape";
import { NotFoundSource } from "@/components/app/NotFoundSource";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { Positions, PositionsLoading } from "@/components/app/Positions";
import { SourceActs, SourceLine, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { TraderStats, TraderStatsLoading } from "@/components/app/TraderStats";
import { addressUrl } from "@/lib/explorer";
import { shortHex } from "@/lib/format";
import { copybook } from "@/lib/server/chain";
import { config } from "@/lib/server/config";
import { perpMarkets } from "@/lib/server/indexer";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ trader: string }> };

const parse = (raw: string): Address | null => (raw.length === 42 && isAddress(raw, { strict: false }) ? getAddress(raw) : null);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const a = parse((await params).trader);
  if (!a) return { title: "Not an address", robots: { index: false } };
  const title = `Trader ${shortHex(a)}`;
  const description = `30-day record, open positions, AI guard verdict and copies of ${a} on dreamDEX perps.`;
  const image = { url: `/og/trader/${a}`, width: 1200, height: 630, alt: `Trader ${shortHex(a)} on Copybook: 30-day record, the validators' verdict and followers` };
  return { title, description, openGraph: { title, description, images: [image] }, twitter: { card: "summary_large_image", title, description, images: [image] } };
}

export default async function TraderPage({ params }: Params) {
  const raw = decodeURIComponent((await params).trader);
  const trader = parse(raw);
  if (!trader)
    return (
      <NotFoundSource kick="Trader" title="Not an address">
        “{raw.slice(0, 80)}” is not a wallet address. Trader pages live at /t/ followed by a 0x address of 40 hex characters; pick one from Discover.
      </NotFoundSource>
    );

  const demo = trader === config.demoLeader;
  const [verdict, pending, fee, markets] = await Promise.allSettled([copybook.verdictOf(trader), copybook.reviewPendingOf(trader), copybook.reviewFee(), perpMarkets()]);
  const now = Math.floor(Date.now() / 1000);
  const v = verdict.status === "fulfilled" ? verdict.value : null;
  const tally = v && v.tier !== "None" ? config.shannonTally(v.shannonRequestId) : undefined;
  const names: TapeNames = {
    markets: markets.status === "fulfilled" ? markets.value : {},
    theses: [],
    traders: { [config.demoLeader.toLowerCase()]: "demo leader" },
    wallets: config.owner ? { [config.owner.toLowerCase()]: "Copybook owner" } : {},
  };

  return (
    <HubFeedProvider pub={config.publicConfig} source={trader}>
      <AppMain label={`Trader ${trader}`}>
        <Col>
          <Panel id="src-h" order={1}>
            <SourceTop kick={demo ? <>Demo leader · <b>run by Copybook</b></> : "Trader"} stepNode={<FollowerStep sourceId={sourceIdOf("Trader", trader)} />} />
            <SourceTitle id="src-h" address>
              {shortHex(trader)}
            </SourceTitle>
            <SourceLine>
              <a href={addressUrl(trader)} target="_blank" rel="noopener noreferrer">
                {trader}
              </a>{" "}
              <span>· dreamDEX perps · 30 days</span>
            </SourceLine>
            {demo && (
              <PanelNote>
                This wallet is ours: Copybook trades it in small sizes so copies can be watched landing live. It is not a ranked trader and its record says nothing about skill.
              </PanelNote>
            )}
            <Suspense fallback={<TraderStatsLoading />}>
              <TraderStats trader={trader} />
            </Suspense>
            <SourceActs>
              <Button size="md" href={`/follow/trader/${trader}`} prefetch={false} arrow>
                Follow this trader
              </Button>
              <Button size="md" variant="quiet" href={addressUrl(trader)} target="_blank">
                Explorer ↗
              </Button>
            </SourceActs>
          </Panel>

          <Panel id="guard-h" title="AI guard" aside={<Kick>Validators&apos; verdict · on chain</Kick>} order={2} d={0.08}>
            <GuardPanel
              trader={trader}
              pub={config.publicConfig}
              verdict={v}
              pending={pending.status === "fulfilled" ? pending.value : null}
              fee={fee.status === "fulfilled" ? fee.value : null}
              tally={tally}
              shannonExplorer={config.shannonExplorer}
              reviewerUrl={config.reviewerUrl}
              now={now}
            />
          </Panel>
        </Col>

        <Col>
          <Panel id="pos-h" title="Open positions" aside={<Kick>dreamDEX indexer</Kick>} order={3} d={0.05}>
            <Suspense fallback={<PositionsLoading />}>
              <Positions trader={trader} />
            </Suspense>
          </Panel>

          <Panel id="act-h" title={<>On <em>Copybook</em></>} aside={<FeedStatusLine extra="copies, refusals and reviews · newest first" />} order={4} d={0.1}>
            <TapeRows names={names} label={`Copybook events about ${trader}, newest first`} empty="Nobody has followed this trader through Copybook, and no review has been asked for." />
          </Panel>

          <Colophon>
            Source id <b>{shortHex(sourceIdOf("Trader", trader), 6, 4)}</b> · RiskGate <b>{shortHex(config.deployments.gate)}</b> · exits always copied
          </Colophon>
        </Col>
      </AppMain>
    </HubFeedProvider>
  );
}

import type { Metadata } from "next";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { SourceLead, SourceLedger, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { DataState } from "@/components/app/State";
import { ThesisBuilder } from "@/components/thesis/ThesisBuilder";
import { FollowerTerms } from "@/components/thesis/FollowerTerms";
import { bpsToPct } from "@/lib/builder/basket";
import { shortHex } from "@/lib/format";
import { config } from "@/lib/server/config";
import { perpMarkets } from "@/lib/server/indexer";
import { registeredPools, registryBank, registryRules } from "@/lib/server/registry";
import type { MarketMeta } from "@/lib/tape";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Publish a thesis",
  description: "Name a weighted basket of dreamDEX perps, long and short, and publish it on chain for others to follow.",
  robots: { index: false },
};

/** The thesis builder. The server reads what does not depend on the wallet: the registry's limits and the markets it accepts. */
export default async function NewThesis() {
  const [rulesR, marketsR, bankR] = await Promise.allSettled([registryRules(), perpMarkets(), registryBank()]);
  const { rules, from } = rulesR.status === "fulfilled" ? rulesR.value : { rules: undefined, from: "source" as const };
  const markets: Record<string, MarketMeta> = marketsR.status === "fulfilled" ? marketsR.value : {};
  const registered = await registeredPools(Object.keys(markets)).catch(() => ({}) as Record<string, boolean>);
  const bank = bankR.status === "fulfilled" ? bankR.value : null;
  const themes = config.deployments.themes;

  const ruleRows: LedgerRow[] = rules
    ? [
        { label: "Legs", value: `1 to ${rules.maxLegs}`, note: "one per market" },
        { label: "Each leg", value: `≥ ${bpsToPct(rules.minLegWeightBps)}%`, note: "long or short; no dust legs followers could only ever trim" },
        { label: "Gross", value: `≤ ${bpsToPct(rules.maxGrossBps)}%`, note: "long and short weights added together" },
        { label: "Markets", value: "registered perps", note: "the margin bank's isPerpPoolRegistered" },
        { label: "Rebalance", value: `once per ${rules.minRebalanceInterval} s`, note: "by the publishing wallet only" },
      ]
    : [];

  return (
    <AppMain label="Publish a thesis">
      <Col>
        <Panel id="new-h" order={1}>
          <SourceTop kick="New thesis" step="checked before you sign" quiet />
          <SourceTitle id="new-h">Publish a thesis</SourceTitle>
          <SourceLead>
            A thesis is a weighted basket of perps, long and short, that anyone can follow with an allocation. Followers&apos; legs open in one transaction, every leg or none, and your
            rebalances reach them in the block they land in.
          </SourceLead>
          <SourceLedger>
            <Ledger size="md" rows={ruleRows} />
          </SourceLedger>
          <PanelNote>
            {from === "registry"
              ? `Read from the ThemeRegistry's constants at ${shortHex(themes)}. The form checks every rule as you type, so a thesis the registry would refuse is never sent.`
              : `The registry did not answer, so these are the limits written in ThemeRegistry.sol. The wallet's gas estimate checks them again before you sign.`}
          </PanelNote>
        </Panel>

        <Panel id="terms-h" title={<>What <em>followers</em> get</>} aside={<Kick>CopyEngine</Kick>} order={3} d={0.06}>
          <FollowerTerms />
        </Panel>
      </Col>

      <Col>
        {marketsR.status === "rejected" || !rules ? (
          <Panel id="build-h" title="The thesis" order={2} d={0.03}>
            <DataState kind="unavailable" title={marketsR.status === "rejected" ? "The dreamDEX indexer did not answer, so there is no market list to build from." : "The registry's limits could not be read."}>
              Legs are chosen from the venue&apos;s live perp markets. Reload in a moment.
            </DataState>
          </Panel>
        ) : (
          <ThesisBuilder pub={config.publicConfig} markets={markets} registered={registered} bank={bank} rules={rules} />
        )}
        <Colophon>
          ThemeRegistry <b>{shortHex(themes)}</b> · margin bank <b>{bank ? shortHex(bank) : "unread"}</b> · Somnia Hideki testnet
        </Colophon>
      </Col>
    </AppMain>
  );
}

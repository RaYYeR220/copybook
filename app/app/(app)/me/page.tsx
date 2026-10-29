import type { Metadata } from "next";
import { Dashboard } from "@/components/me/Dashboard";
import { config } from "@/lib/server/config";
import { perpMarkets } from "@/lib/server/indexer";
import { thesisNames } from "@/lib/server/theses";
import { currentSiteUrl } from "@/lib/siteUrl";
import type { MarketMeta } from "@/lib/tape";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your follow on dreamDEX perps: your book against the source's, every copy and refusal, the AI guard and the gas tank, read from the chain.",
  robots: { index: false },
};

/**
 * The follower dashboard. The server hands down only what does not depend on the wallet (market and thesis names);
 * the wallet's follow is read in the browser, from the chain, for whichever account is connected.
 */
export default async function MePage() {
  const [markets, theses] = await Promise.all([
    perpMarkets().catch(() => ({}) as Record<string, MarketMeta>),
    thesisNames().catch(() => [] as { id: string; name: string }[]),
  ]);
  return (
    <Dashboard
      pub={config.publicConfig}
      markets={markets}
      theses={theses}
      traders={{ [config.demoLeader.toLowerCase()]: "demo leader" }}
      renderedAt={Math.floor(Date.now() / 1000)}
      site={currentSiteUrl()}
    />
  );
}

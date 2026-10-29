import type { Metadata } from "next";
import { getAddress, isAddress, type Address } from "viem";
import { FollowFlow, type FollowSource } from "@/components/follow/FollowFlow";
import { NotFoundSource } from "@/components/app/NotFoundSource";
import { shortHex } from "@/lib/format";
import { toJsonSafe } from "@/lib/json";
import { config } from "@/lib/server/config";
import { openPositions, perpMarkets } from "@/lib/server/indexer";
import { loadThesis } from "@/lib/server/theses";
import type { MarketMeta } from "@/lib/tape";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ kind: string; ref: string }> };

const ID_RE = /^[0-9]{1,9}$/;
const parseTrader = (raw: string): Address | null => (raw.length === 42 && isAddress(raw, { strict: false }) ? getAddress(raw) : null);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { kind, ref } = await params;
  if (kind === "trader") {
    const a = parseTrader(decodeURIComponent(ref));
    return { title: a ? `Follow ${shortHex(a)}` : "Not an address", robots: { index: false } };
  }
  if (kind === "thesis" && ID_RE.test(ref)) return { title: `Follow thesis #${ref}`, robots: { index: false } };
  return { title: "Nothing to follow", robots: { index: false } };
}

/**
 * The follow flow for one source. The server reads what does not depend on the wallet (the thesis and its minimum,
 * the trader's open markets, market names); everything about the wallet is read in the browser, fresh, each load.
 */
export default async function FollowPage({ params }: Params) {
  const { kind, ref: rawRef } = await params;
  const ref = decodeURIComponent(rawRef);
  const now = Math.floor(Date.now() / 1000);
  const marketsR = await perpMarkets().then(
    (m) => m,
    () => ({}) as Record<string, MarketMeta>,
  );

  let source: FollowSource;
  if (kind === "trader") {
    const trader = parseTrader(ref);
    if (!trader)
      return (
        <NotFoundSource kick="Follow" title="Not an address">
          “{ref.slice(0, 80)}” is not a wallet address. Follow links look like /follow/trader/ followed by a 0x address of 40 hex characters; pick a trader from Discover.
        </NotFoundSource>
      );
    const held = await openPositions(trader).then(
      (rows) => rows.map((p) => p.pool),
      () => null,
    );
    source = { kind: "Trader", trader, demo: trader === config.demoLeader, held };
  } else if (kind === "thesis") {
    if (!ID_RE.test(ref) || BigInt(ref) === 0n)
      return (
        <NotFoundSource kick="Follow" title="Not a thesis id">
          “{ref.slice(0, 80)}” is not a thesis id. Theses are numbered from 1; pick one from Discover.
        </NotFoundSource>
      );
    const id = BigInt(ref);
    let thesis;
    try {
      thesis = await loadThesis(id);
    } catch {
      return (
        <NotFoundSource kick={`Follow thesis #${id}`} title="Registry unreadable">
          The ThemeRegistry could not be read from the chain just now, so this thesis is unknown, not missing. Reload in a moment.
        </NotFoundSource>
      );
    }
    if (!thesis)
      return (
        <NotFoundSource kick={`Follow thesis #${id}`} title={`No thesis #${id}`}>
          The ThemeRegistry has no thesis with this id. Pick one from Discover.
        </NotFoundSource>
      );
    source = {
      kind: "Theme",
      themeId: id,
      name: thesis.name,
      version: thesis.version,
      creator: thesis.creator,
      legs: thesis.legs,
      minimum: thesis.minimum ? { allocation: thesis.minimum.allocation, recommended: thesis.minimum.recommended, maxNotional: thesis.minimum.maxNotional, bindingPool: thesis.minimum.bindingPool } : null,
    };
  } else {
    return (
      <NotFoundSource kick="Follow" title="Nothing to follow">
        Follow links name a trader (/follow/trader/0x…) or a thesis (/follow/thesis/1). Pick one from Discover.
      </NotFoundSource>
    );
  }

  return <FollowFlow pub={config.publicConfig} source={toJsonSafe(source)} markets={marketsR} renderedAt={now} />;
}

import { unstable_cache } from "next/cache";
import { getTraderStats, IndexerError, topTraders } from "@copybook/stats";
import { followerWallets } from "@/lib/followers";
import { hubLog } from "@/lib/server/chain";
import { config } from "@/lib/server/config";
import { rankTraders } from "@/lib/server/traders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE = "public, s-maxage=300, stale-while-revalidate=600";
/** How long the ranking waits on the hub log to learn which wallets are copy wallets. */
const LOG_BUDGET_MS = 20_000;

function json(body: unknown, status: number, cache?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(cache ? { "cache-control": cache } : {}) },
  });
}

/** One ranking per five minutes across instances; a failed ranking is never cached. */
const ranking = unstable_cache(
  () =>
    rankTraders({
      topTraders,
      getTraderStats,
      followerWallets: async () => followerWallets((await hubLog.read({ budgetMs: LOG_BUDGET_MS })).events),
      ownWallets: config.ownWallets,
      demoLeader: config.demoLeader,
      now: () => new Date(),
    }),
  ["top-traders", "v1"],
  { revalidate: 300 },
);

/** Top dreamDEX traders by realized PnL over 30 days, from the indexer, plus Copybook's labelled demo leader. */
export async function GET(): Promise<Response> {
  try {
    return json(await ranking(), 200, CACHE);
  } catch (err) {
    if (err instanceof IndexerError) return json({ error: "indexer unavailable" }, 502);
    console.error("traders route failed", err instanceof Error ? err.message : err);
    return json({ error: "internal error" }, 500);
  }
}

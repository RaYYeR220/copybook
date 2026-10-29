import { unstable_cache } from "next/cache";
import { getTraderStats, topTraders } from "@copybook/stats";
import { followerWallets } from "@/lib/followers";
import { hubLog } from "@/lib/server/chain";
import { config } from "@/lib/server/config";
import { rankTraders, type TradersPayload } from "@/lib/server/traders";

/** How long the ranking waits on the hub log to learn which wallets are copy wallets. */
const LOG_BUDGET_MS = 20_000;

/** One ranking per five minutes across instances; a failed ranking is never cached. Served by /api/traders. */
export const ranking = unstable_cache(
  () =>
    rankTraders({
      topTraders,
      getTraderStats,
      followerWallets: async () => {
        const log = await hubLog.read({ budgetMs: LOG_BUDGET_MS });
        return { wallets: followerWallets(log.events), complete: log.complete };
      },
      ownWallets: config.ownWallets,
      demoLeader: config.demoLeader,
      now: () => new Date(),
    }),
  ["top-traders", "v3"],
  { revalidate: 300 },
);

/**
 * The ranking when the data cache can answer within `waitMs` (a page renders it with the rest), else undefined and
 * the client loads it from /api/traders. A cold ranking takes up to a minute, which no page should wait for.
 */
export async function rankingIfReady(waitMs = 1_500): Promise<TradersPayload | undefined> {
  let ring: (v: undefined) => void = () => {};
  const late = new Promise<undefined>((resolve) => (ring = resolve));
  const timer = setTimeout(() => ring(undefined), waitMs);
  try {
    return await Promise.race([ranking().catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

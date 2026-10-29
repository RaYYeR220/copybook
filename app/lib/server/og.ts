import "server-only";
import type { Hex } from "viem";
import { followersOf } from "../followers";
import type { CardNames, FollowerFigure } from "../og/model";
import type { CardDeps } from "../og/respond";
import { copybook, hubLog } from "./chain";
import { config } from "./config";
import { perpMarkets, traderStats } from "./indexer";
import { loadThesis, thesisNames } from "./theses";

/** Market symbols, thesis names and our own wallets, for naming things on a card. A source that does not answer names nothing. */
export async function cardNames(): Promise<CardNames> {
  const [markets, theses] = await Promise.all([perpMarkets().catch(() => ({})), thesisNames().catch(() => [])]);
  return { markets, theses: Object.fromEntries(theses.map((t) => [t.id, t.name])), demoLeader: config.demoLeader, owner: config.owner };
}

/** Wallets following a source now, replayed from the hub's log; a floor while the log is still being read. */
async function followers(sourceId: Hex): Promise<FollowerFigure | null> {
  const log = await hubLog.read({ budgetMs: 8_000 });
  return { n: followersOf(log.events, sourceId).current.length, complete: log.complete };
}

const now = () => Math.floor(Date.now() / 1000);

export const liveCardDeps: CardDeps = { names: cardNames, followers, now };

export const traderCardDeps = {
  ...liveCardDeps,
  stats: traderStats,
  verdict: (t: `0x${string}`) => copybook.verdictOf(t),
};

export const thesisCardDeps = {
  ...liveCardDeps,
  thesis: async (id: bigint) => {
    const t = await loadThesis(id);
    return t ? { name: t.name, version: t.version, creator: t.creator, legs: t.legs, minimum: t.minimum?.allocation ?? null } : null;
  },
};

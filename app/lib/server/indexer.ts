import "server-only";
import { unstable_cache } from "next/cache";
import type { Address } from "viem";
import { getTraderStats, Indexer, type TraderStats } from "@copybook/stats";
import { toJsonSafe, fromJsonSafe } from "../json";
import { toMarketMeta, toPositions, type MarketRow, type Position, type PositionRow } from "../positions";
import type { MarketMeta } from "../tape";

const POSITIONS = `query Positions($account:String!){
  PerpPosition(where:{account:{_eq:$account},size:{_neq:"0"}},order_by:[{updatedAtBlock:desc}],limit:50){
    pool size isLong entryPriceX18 updatedAt updatedAtBlock market { baseSymbol baseDecimals markPrice }
  }}`;

const MARKETS = `query PerpMarkets{ Market(where:{marketType:{_eq:PERP}}){ poolAddress baseSymbol baseDecimals }}`;

const indexer = () => new Indexer({ delayMs: 0 });

/** The trader's open dreamDEX perp positions, as the indexer last saw them (15 s cache). Throws IndexerError. */
export const openPositions = (trader: Address): Promise<Position[]> =>
  unstable_cache(
    async () => toJsonSafe(toPositions((await indexer().query<{ PerpPosition: PositionRow[] }>("Positions", POSITIONS, { account: trader.toLowerCase() })).PerpPosition)),
    ["positions", trader.toLowerCase()],
    { revalidate: 15 },
  )().then((v) => fromJsonSafe<Position[]>(v));

/** Every perp market's symbol and decimals, by pool (one hour cache). Throws IndexerError. */
export const perpMarkets: () => Promise<Record<string, MarketMeta>> = unstable_cache(
  async () => toMarketMeta((await indexer().query<{ Market: MarketRow[] }>("PerpMarkets", MARKETS)).Market),
  ["perp-markets"],
  { revalidate: 3600 },
);

/** 30-day trader stats (the same figures the validators' rubric is drawn from), five-minute cache. Throws IndexerError. */
export const traderStats = (trader: Address): Promise<TraderStats> =>
  unstable_cache(() => getTraderStats(trader, { maxRows: 2_000 }), ["trader-stats", trader.toLowerCase()], { revalidate: 300 })();

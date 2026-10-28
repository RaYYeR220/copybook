import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, LeverageRow, LiquidationRow, MarketRow, PositionChangeRow } from "../src/indexer.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface TraderFixture {
  recordedAt: number;
  windowDays: number;
  trader: Address;
  truncated: boolean;
  changes: PositionChangeRow[];
  liquidations: LiquidationRow[];
  leverage: LeverageRow[];
  lastActiveTs: number | null;
}

export const LIQUIDATED: Address = "0xa14d4561f2697859ab6c2d5eb62e1172a6cc3d14";
export const LEVERAGED: Address = "0x5c4c43b6dca4a53ccea06a7e9c03afd6b03ea931";
export const STEADY: Address = "0x1cf35c559bd4e1d45b738b83041855c8634e5a56";

export const loadTrader = (a: Address): TraderFixture =>
  JSON.parse(readFileSync(join(dir, `${a}.json`), "utf8"));

export const markets: MarketRow[] = JSON.parse(readFileSync(join(dir, "markets.json"), "utf8")).markets;

/** Fixture time: every recording shares one clock so the 30-day window is identical. */
export const NOW = loadTrader(STEADY).recordedAt;

export interface StubCall {
  operationName: string;
  variables: Record<string, any>;
}

/**
 * A fetch that answers the indexer's GraphQL operations from recorded fixtures
 * (same filtering and paging the live Hasura applies for these queries).
 */
export function fixtureFetch(traders: Address[], opts: { candidates?: Address[] } = {}) {
  const calls: StubCall[] = [];
  const byAddr = new Map(traders.map((a) => [a, loadTrader(a)]));
  const fn = (async (_url: string, init: { body: string }) => {
    const { operationName, variables } = JSON.parse(init.body);
    calls.push({ operationName, variables });
    const fx = byAddr.get(variables.account);
    const slice = <T>(rows: T[]) => rows.slice(variables.offset, variables.offset + variables.limit);
    let data: unknown;
    switch (operationName) {
      case "Changes":
        data = { PerpPositionChange: slice(fx?.changes ?? []) };
        break;
      case "Liquidations":
        data = { LiquidationEvent: slice(fx?.liquidations ?? []) };
        break;
      case "Leverage":
        data = { PerpLeverageSetting: fx?.leverage ?? [] };
        break;
      case "LastActive":
        data = { PerpPosition: fx?.lastActiveTs ? [{ updatedAt: String(fx.lastActiveTs) }] : [] };
        break;
      case "Markets":
        data = { Market: markets };
        break;
      case "Candidates":
        data = { PerpPositionChange: (opts.candidates ?? traders).slice(0, variables.limit).map((account) => ({ account })) };
        break;
      default:
        return new Response(JSON.stringify({ errors: [{ message: `unexpected ${operationName}` }] }));
    }
    return new Response(JSON.stringify({ data }));
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

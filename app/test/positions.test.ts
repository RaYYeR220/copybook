import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { toMarketMeta, toPositions, type PositionRow } from "@/lib/positions";

// rows as the dreamDEX indexer returned them on 28 Oct 2026
const ROWS: PositionRow[] = [
  { pool: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0", size: "0", isLong: true, entryPriceX18: "0", updatedAt: "1793194638", updatedAtBlock: 35414612, market: { baseSymbol: "BTC", baseDecimals: 8, markPrice: "81162699458904647000000" } },
  { pool: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0", size: "9838000", isLong: false, entryPriceX18: "81316800000000000000000", updatedAt: "1793226666", updatedAtBlock: 35734790, market: { baseSymbol: "BTC", baseDecimals: 8, markPrice: "81162699458904647000000" } },
  { pool: "0xd6cb1dd58580b84d76068ac21594219ce03aeddf", size: "115765700000000000000", isLong: false, entryPriceX18: "2360722288298061964805", updatedAt: "1793226653", updatedAtBlock: 35734654, market: { baseSymbol: "ETH", baseDecimals: 18, markPrice: "2353957263831650000000" } },
  { pool: "0x2a73129f26917124bd2a47a9b355c395c537f050", size: "2824000000", isLong: true, entryPriceX18: "1297028707607169222847", updatedAt: "1793226665", updatedAtBlock: 35734774, market: null },
];

describe("positions from the indexer", () => {
  it("keeps open positions only, with side, size and the indexer's mark", () => {
    const p = toPositions(ROWS);
    expect(p.length).toBe(3);
    expect(p[0]).toMatchObject({ market: "ETH-PERP", side: "short", size: 115765700000000000000n, decimals: 18, entryPrice: 2360722288298061964805n, updatedAtBlock: 35734654 });
    // 115.7657 ETH × 2,353.957… = 272,507.… quote
    expect(p[0].notional! / 10n ** 18n).toBe(272507n);
    expect(p[1]).toMatchObject({ market: "BTC-PERP", side: "short", size: 9838000n });
    expect(p[1].notional! / 10n ** 18n).toBe(7984n);
  });

  it("a pool the indexer cannot name stays, without inventing a market or a notional", () => {
    const p = toPositions(ROWS).at(-1)!;
    expect(p).toMatchObject({ market: null, decimals: null, markPrice: null, notional: null, pool: getAddress("0x2a73129f26917124bd2a47a9b355c395c537f050") });
  });

  it("a flat book is an empty list", () => {
    expect(toPositions([ROWS[0]])).toEqual([]);
  });

  it("names markets by pool for the tape", () => {
    expect(toMarketMeta([{ poolAddress: "0x4181DD08E73BbCdd1Ba3E615A18f6abD941b94C0", baseSymbol: "BTC", baseDecimals: 8 }])).toEqual({
      "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0": { symbol: "BTC", decimals: 8 },
    });
  });
});

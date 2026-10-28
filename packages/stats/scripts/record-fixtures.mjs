// Records live indexer responses for a few traders into test/fixtures.
// Usage: node scripts/record-fixtures.mjs <0xTrader> [<0xTrader> ...]
// Node 24 runs the TypeScript sources directly.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Indexer } from "../src/indexer.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
mkdirSync(dir, { recursive: true });

const WINDOW_DAYS = 30;
const now = Math.floor(Date.now() / 1000);
const since = now - WINDOW_DAYS * 86400;
const ix = new Indexer({ maxRows: 1500, delayMs: 250 });

const markets = await ix.markets();
writeFileSync(join(dir, "markets.json"), JSON.stringify({ recordedAt: now, markets }, null, 1));

for (const trader of process.argv.slice(2)) {
  const changes = await ix.positionChanges(trader, since);
  const liquidations = await ix.liquidations(trader, since);
  const leverage = await ix.leverage(trader);
  const lastActiveTs = await ix.lastActiveTs(trader);
  const out = {
    recordedAt: now,
    windowDays: WINDOW_DAYS,
    trader: trader.toLowerCase(),
    truncated: changes.truncated || liquidations.truncated,
    changes: changes.rows,
    liquidations: liquidations.rows,
    leverage,
    lastActiveTs,
  };
  writeFileSync(join(dir, `${trader.toLowerCase()}.json`), JSON.stringify(out, null, 1));
  console.log(trader, "changes", changes.rows.length, "liqs", liquidations.rows.length, "lev", leverage.length, "truncated", out.truncated);
}

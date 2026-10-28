# @copybook/stats

Trader statistics for Copybook, computed from the dreamDEX indexer (Hasura GraphQL). Two consumers:

- the on-chain risk review: validators fetch `riskSummary(stats)` and classify the trader OK / CAUTION / BLOCK;
- the Discover page: `topTraders` ranks real traders worth following.

```ts
import { getTraderStats, riskSummary, topTraders } from "@copybook/stats";

const stats = await getTraderStats("0x...");
riskSummary(stats);
// trades30d=412 activeDays30d=14 markets=6 realizedPnl30d=+812.4 liquidations30d=3 maxDrawdownPct30d=31.2 avgLeverage=12.4 lastActive=2026-10-27

const best = await topTraders(10, 30, { exclude: [hub, ...demoWallets] });
```

Everything is read-only, sequential (one request at a time, 100 ms apart by default, 500-row pages) and uses no authentication.
Unknown values are `null` (and `n/a` in the summary), never a guess.

## Indexer fields used

| Table | Fields | Used for |
| --- | --- | --- |
| `PerpPositionChange` | `account, pool, kind, timestamp, blockNumber, logIndex, txHash, sizeBefore/After, entryPriceBefore/After, realizedPnl` | trades, active days, markets, realized PnL, drawdown, margin estimate |
| `LiquidationEvent` | `account, kind (AccountLiquidated, PositionLiquidated), timestamp, txHash` | liquidation count |
| `PerpLeverageSetting` | `account, pool, leverageX` | average leverage, margin estimate |
| `Market` (PERP) | `poolAddress, baseSymbol, baseDecimals, initialMarginBps` | size to notional, default margin ratio |
| `PerpPosition` | `account, updatedAt` | last activity |

Units: prices are 18-decimal, sizes use the market's `baseDecimals`, and `realizedPnl` is an 18-decimal quote amount (USDso).
All PnL figures in this package are in quote units.

## Definitions and approximations

- **Window.** The last 30 days by default (`windowDays`). The `30d` in field names is the default; `riskSummary` uses the real window length in its keys.
- **trades30d.** Position changes (open, increase, reduce, close) in the window. A fill that touches several counterparties can produce several rows, so this counts position changes, not orders. Rows inside a liquidation transaction are excluded: those are not the trader's decisions.
- **activeDays30d.** Distinct UTC calendar days with at least one such trade.
- **marketsTraded.** Distinct perp pools with at least one such trade.
- **realizedPnl30d.** Sum of `realizedPnl` over all position changes in the window, liquidation transactions included, so a liquidation loss counts. Funding payments and fees are not included, and unrealized PnL of open positions is not included.
- **liquidations30d.** Distinct transactions carrying an `AccountLiquidated` or `PositionLiquidated` event for the account.
- **maxDrawdownAbs30d.** The cumulative realized-PnL path is built from zero at the start of the window, in chain order; this is the largest peak-to-trough fall. It is a realized-only measure: it misses unrealized losses and funding, so the true equity drawdown is at least this large.
- **maxDrawdownPct30d.** `maxDrawdownAbs30d` divided by the peak estimated margin deployed in the window, capped at 100. Margin per pool is open notional (`|size| / 10^baseDecimals * entryPrice`) times `1/leverageX` when the trader set leverage for that pool, otherwise the market's initial margin ratio (`initialMarginBps / 10000`, the protocol minimum). Positions already open when the window starts are included. The indexer exposes no account equity or deposit history, so this is an estimate of the capital at risk, not a measured equity curve. It is `null` if a pool's size, price or market metadata is missing.
- **avgLeverage.** Trade-weighted average of the trader's explicit `leverageX` settings. The indexer only records leverage when it was changed from the default, so a trader with no settings, or with settings covering under 50% of their trades, gets `null`. This is the configured leverage, not realized leverage (the indexer has no equity snapshots to compute that).
- **lastActiveAt.** Latest `PerpPosition.updatedAt` for the account, over all time.
- **truncated.** Rows are read most recent first up to `maxRows` (default 5000) per table. If that cap is hit, figures cover only the most recent rows and `truncated` is true (`partial=1` in the summary). A history of exactly `maxRows` rows is also flagged, which errs on the side of caution.

## topTraders

`topTraders(n, windowDays = 30, { exclude, minTrades = 5, minActiveDays = 2, candidateLimit = 25 })`

The indexer has no per-account aggregate and the position-change table holds millions of rows, so a full scan is not an option.
Candidates are the accounts behind the largest single realized gains in the window; each candidate is then measured over the whole window and ranked on its realized PnL total.
A trader whose single gains are all small can be missed, and high-frequency accounts whose history exceeds the row cap are skipped because their window PnL would be partial.
`exclude` removes your own hub, test and demo wallets before any history is fetched.
Ranking is by PnL alone; read the attached `stats` (drawdown, liquidations) before promoting anyone.

## Tests and fixtures

```
npm test
npm run record-fixtures -- 0xTrader1 0xTrader2 0xTrader3   # re-record from the live indexer
```

`test/fixtures` holds live responses for three traders (one liquidated three times, one with explicit leverage, one steady and unlevered) and the perp market list; tests answer the indexer from those files, so they run offline against a fixed clock.

# Indexer: newest `MarginEvent` / `PerpPositionChange` by `blockNumber` fails with "database query error" after ~10 s

**Severity:** normal

**Area:** API

## Steps to reproduce

Read-only.

```sh
cd feedback/repro && npm ci && node 05-indexer-order-by-blocknumber.ts
```

Or post these to `https://hideki-dev.smk.somnia.host/v1/graphql`:

```graphql
{ MarginEvent(order_by: {blockNumber: desc}, limit: 1) { blockNumber timestamp txHash } }
{ MarginEvent(order_by: {timestamp: desc}, limit: 1) { blockNumber timestamp txHash } }
{ PerpPositionChange(order_by: {blockNumber: desc}, limit: 1) { blockNumber timestamp txHash } }
{ PerpPositionChange(order_by: {timestamp: desc}, limit: 1) { blockNumber timestamp txHash } }
```

## Expected

The schema exposes `blockNumber` in `MarginEvent_order_by` and `PerpPositionChange_order_by`, so "the newest
row by block" returns in about the same time as "the newest row by timestamp". `blockNumber` is the column
callers need to page by block or join with chain data. If the indexer cannot sort on it, it should not offer it
for `order_by`, or it should return an error that says the query timed out.

## Actual

- Ordered by `blockNumber`, both tables run about 10.3 s and return `database query error` (`code:
  unexpected`). The message gives no hint that this is a timeout or which column causes it.
- Ordered by `timestamp`, the same queries return in 0.3–1.2 s.
- With a filter (`kind = Credited` / `OPEN`), the `blockNumber` order sometimes completes, at 2–10 s. A
  `MarginEvent` query filtered on `Credited` failed the same way earlier the same day, so it sits at the edge of
  the limit.
- Other tables sort on `blockNumber` without trouble (`Fill` 2.5 s, `FundingPayment` 1.2 s, `LiquidationEvent`,
  `PerpFeeRecord`, `PerpOrderRejection` under 1 s), so this looks like a missing index on these two large
  tables rather than a general limit.
- The SDK's own queries order by `timestamp` (for example `MarginEvents` in the SDK's GraphQL documents), so SDK
  users are not hit. Bots and dashboards that query the indexer directly are.

## Evidence

2026-10-29, `https://hideki-dev.smk.somnia.host/v1/graphql`:

```
{ MarginEvent(order_by:{timestamp:desc}, limit:1){ blockNumber timestamp txHash } }
  1179 ms  data: {"MarginEvent":[{"blockNumber":"36222704","timestamp":"1793275472","txHash":"0x44a4fa49…9aa6"}]}

{ MarginEvent(order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }
  10321 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]

{ MarginEvent(where:{kind:{_eq:"Credited"}}, order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }
  10352 ms  data: {"MarginEvent":[{"blockNumber":"36221565",…}]}

{ PerpPositionChange(order_by:{timestamp:desc}, limit:1){ blockNumber timestamp txHash } }
  824 ms  data: {"PerpPositionChange":[{"blockNumber":"36222905",…}]}

{ PerpPositionChange(order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }
  10279 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]

{ PerpPositionChange(where:{kind:{_eq:"OPEN"}}, order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }
  2172 ms  data: {"PerpPositionChange":[{"blockNumber":"36222899",…}]}
```

Earlier the same day: `MarginEvent(where:{kind:{_eq:"Credited"}}, order_by:{blockNumber:desc}, limit:3)` returned
`database query error` after 10.8 s, three times in a row. An unfiltered `MarginEvent` sorted on `blockNumber`
failed on every try.

Docs checked:

- Networks and endpoints, "Somnia Markets deployments": the Hideki indexer is "development-grade" with "no
  alerting, so a stall can go unnoticed". That covers outages, not one sort order failing every time:
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/networks-and-endpoints.md (also
  https://prd.smk.somnia.host/docs/typescript/reference/networks-and-endpoints)
- Read tiers / indexer reads: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/read-tiers.md.
  It has no note on sortable columns.

## Environment

- Client: Node 24.13.0 `fetch` (plain GraphQL POST, no SDK); `@somnia-chain/markets-sdk` 0.32.1 referenced for
  its own query shape
- Network: Hideki testnet (chain 50383) indexer `https://hideki-dev.smk.somnia.host/v1/graphql`, head ~36.22M
- Wallet: none (read-only)

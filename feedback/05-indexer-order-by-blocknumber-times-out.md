# Indexer: `MarginEvent` ordered by `blockNumber` fails with "database query error" after ~11 s

**Severity:** normal

**Area:** API

## Steps to reproduce

Read-only.

```sh
cd feedback/repro && npm ci && node 05-indexer-order-by-blocknumber.ts
```

Or post these to `https://hideki-dev.smk.somnia.host/v1/graphql` (`<N>` = head − 10,000):

```graphql
{ MarginEvent(order_by: {blockNumber: desc}, limit: 1) { blockNumber timestamp txHash } }
{ MarginEvent(order_by: {blockNumber: asc}, limit: 1) { blockNumber timestamp txHash } }
{ MarginEvent(where: {blockNumber: {_gt: "<N>"}}, order_by: {blockNumber: desc}, limit: 1) { blockNumber timestamp txHash } }
{ MarginEvent(where: {blockNumber: {_gt: "<N>"}}, order_by: {timestamp: desc}, limit: 1) { blockNumber timestamp txHash } }
{ MarginEvent(order_by: {timestamp: desc}, limit: 1) { blockNumber timestamp txHash } }
```

## Expected

`MarginEvent_order_by` exposes `blockNumber`, so ordering on it returns in about the same time as ordering on
`timestamp`.

`blockNumber` is the column a client needs for paging. Hideki makes ~10 blocks per second and `timestamp` is
in whole seconds, so one timestamp value covers about 10 blocks. That makes `timestamp` an unstable cursor:
rows that share a second are skipped or repeated at page boundaries. The SDK says the same about
`blockTimestamp` in its price-feed stream ("`blockTimestamp` repeats … ticks would be dropped").

If the indexer cannot sort on `blockNumber`, it should not offer it in `order_by`, or it should return an error
that names the timeout.

## Actual

For `MarginEvent`, every ordering on `blockNumber` fails:

- `desc` and `asc` each run 10.8–11.1 s and return `database query error` (`code: unexpected`), 4 of 4 tries
  over two runs.
- Narrowing to the last 10,000 blocks (`blockNumber _gt`) does not help: still `database query error` after
  ~11 s.
- The same `_gt` filter ordered by `timestamp` returns in 0.8–1.1 s, and the unfiltered `timestamp` order in
  ~0.27 s.
- The error gives no hint that this is a timeout, or which part of the query causes it.

`PerpPositionChange` is slow but completes now. Ordered by `blockNumber` it took ~7.4 s and succeeded in both
runs. In an earlier run (about 2026-10-29T12:05Z) it failed with the same `database query error` after 10.3 s.

The SDK's own `MarginEvents` query orders by `timestamp`, so `client.getMarginEvents` callers are not hit. Bots
and dashboards that query the indexer directly are, and so is anyone paging by block.

## Evidence

Two runs, 2026-10-29 (chain head ~36.246M):

```
{ MarginEvent(order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }
  2026-10-29T12:44:08.460Z  11104 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]
  2026-10-29T12:44:52.100Z  10813 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]

{ MarginEvent(order_by:{blockNumber:asc}, limit:1){ blockNumber timestamp txHash } }
  2026-10-29T12:44:19.565Z  10838 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]
  2026-10-29T12:45:02.913Z  10818 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]

{ MarginEvent(where:{blockNumber:{_gt:"<head-10000>"}}, order_by:{blockNumber:desc}, limit:1){ … } }
  2026-10-29T12:44:30.403Z  11099 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]
  2026-10-29T12:45:13.731Z  11070 ms  errors: [{"message":"database query error","extensions":{"path":"$","code":"unexpected"}}]

{ MarginEvent(where:{blockNumber:{_gt:"<head-10000>"}}, order_by:{timestamp:desc}, limit:1){ … } }
  2026-10-29T12:44:41.503Z  1062 ms  data: {"MarginEvent":[{"blockNumber":"36246787","timestamp":"1793277882",…}]}
  2026-10-29T12:45:24.801Z  800 ms   data: {"MarginEvent":[{"blockNumber":"36247218","timestamp":"1793277925",…}]}

{ MarginEvent(order_by:{timestamp:desc}, limit:1){ blockNumber timestamp txHash } }
  2026-10-29T12:44:42.565Z  275 ms  data: {"MarginEvent":[{"blockNumber":"36246791","timestamp":"1793277882",…}]}
  2026-10-29T12:45:25.602Z  268 ms  data: {"MarginEvent":[{"blockNumber":"36247222","timestamp":"1793277925",…}]}

{ PerpPositionChange(order_by:{blockNumber:desc}, limit:1){ blockNumber timestamp txHash } }
  2026-10-29T12:44:42.840Z  7393 ms  data: {"PerpPositionChange":[{"blockNumber":"36246777",…}]}
  2026-10-29T12:45:25.869Z  7426 ms  data: {"PerpPositionChange":[{"blockNumber":"36247210",…}]}
  (earlier run about 2026-10-29T12:05Z: 10279 ms  errors: [{"message":"database query error",…}])

{ PerpPositionChange(order_by:{timestamp:desc}, limit:1){ blockNumber timestamp txHash } }
  2026-10-29T12:44:50.233Z  873 ms   data: {"PerpPositionChange":[{"blockNumber":"36246870",…}]}
  2026-10-29T12:45:33.296Z  1055 ms  data: {"PerpPositionChange":[{"blockNumber":"36247296",…}]}
```

In the first run, the two `timestamp`-ordered `MarginEvent` reads one second apart both report
`timestamp` 1793277882 but different blocks (36246787 and 36246791). That is the ~10-blocks-per-second overlap
that makes `timestamp` a poor cursor.

Docs checked:

- Networks and endpoints, "Somnia Markets deployments". The Hideki indexer is "development-grade" with "no
  alerting, so a stall can go unnoticed", which covers outages, not one sort order failing every time:
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/networks-and-endpoints.md (also
  https://prd.smk.somnia.host/docs/typescript/reference/networks-and-endpoints)
- Read tiers, which has no note on sortable columns: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/read-tiers.md
- The SDK's price-feed stream comment on `blockTimestamp` repeating:
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/priceFeed/query.ts

## Environment

- Client: Node 24.13.0 `fetch` (plain GraphQL POST, no SDK); `@somnia-chain/markets-sdk` 0.32.1 referenced for
  its own query shape
- Network: Hideki testnet (chain 50383) indexer `https://hideki-dev.smk.somnia.host/v1/graphql`
- Wallet: none (read-only)

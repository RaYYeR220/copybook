# Feedback: dreamDEX perps on Hideki

Issues found while building Copybook on dreamDEX perps (Somnia Hideki testnet, chain 50383). Each report
follows the template: title, severity, area, steps to reproduce, expected, actual, evidence, environment. Every
report was reproduced on 2026-10-29 against the public endpoints, and its doc check names the page read. Values
that drift (counts, block numbers, timings) carry the UTC time of the run.

| # | Report | Severity | Area |
|---|---|---|---|
| 01 | [Perp voucher: `getPerpVoucherEligibility` returns `eligible: true`, but `VoucherDistributor.claim()` reverts `0x3e31dcc2` for every account](01-voucher-self-claim-disabled.md) | major | SDK |
| 02 | [Hideki RPC: state reads addressed by block hash fail, so Foundry cannot fork the chain (`forge script`, `forge test --fork-url`, `cast run`)](02-rpc-block-hash-state-reads.md) | major | API |
| 03 | [Hideki RPC: `eth_getStorageAt` returns `"0x"` for a slot that holds zero](03-rpc-empty-storage-slot.md) | normal | API |
| 04 | [SDK: a write from a signer with no STT throws `ContractRevertError` instead of `RpcError`](04-sdk-unfunded-signer-reported-as-revert.md) | normal | SDK |
| 05 | [Indexer: `MarginEvent` ordered by `blockNumber` fails with "database query error" after ~11 s](05-indexer-order-by-blocknumber-times-out.md) | normal | API |
| 06 | [Docs: Hideki block time, explorer and Multicall3 are out of date](06-docs-hideki-network-facts-stale.md) | normal | docs |

## Running the reproductions

[`repro/`](repro/) holds one small script per report. They use public endpoints only, need no key, and send no
transaction. Report 04 generates a throwaway key in memory and never funds it, so nothing can be mined.

```sh
cd feedback/repro
npm ci
node 01-voucher-self-claim.ts    # Node 22.18+ runs TypeScript directly
```

`HIDEKI_RPC` and `HIDEKI_INDEXER` override the endpoints. Report 02 also needs Foundry for its `forge script`
and `cast run` steps.

Pinned versions: `@somnia-chain/markets-sdk` 0.32.1 (npm `latest` on 2026-10-29) and viem 2.57.12.

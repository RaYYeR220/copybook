# Docs: Hideki is documented as 10 ms blocks (~100 blocks/s), with no explorer and a non-canonical Multicall3; live it is 100 ms, has an explorer, and uses the canonical Multicall3

**Severity:** normal

**Area:** docs

## Steps to reproduce

Read-only.

```sh
cd feedback/repro && npm ci && node 06-hideki-network-facts.ts
```

1. Read the Hideki entries in the SDK docs: "Networks and endpoints", "Chains" and the `hidekiTestnet` chain
   definition.
2. Measure the block time from block timestamps over 1,000 / 100,000 / 864,000 blocks and over the whole chain.
3. Compare with the Tokyo explorer's own stats (`/tokyo/api/v2/stats`).
4. Check for Multicall3 code at the canonical `0xcA11bde05977b3631167028862bE2a173976CA11`.

## Expected

The Hideki docs match the live network, which builders use to size block windows, latency and polling.

## Actual

| claim in the docs | where | live, 2026-10-29 |
|---|---|---|
| block time "10 ms"; "~100 blocks/s"; `blockTime: 10` | Networks and endpoints table, Chains table and text, `hidekiTestnet` JSDoc and definition | **100 ms** (~10 blocks/s): 100,000 blocks took 10,003 s, 864,000 blocks 86,427 s, and the whole chain averages 100.19 ms since block 1 (2026-09-17). The explorer reports `average_block_time: 100`. |
| "Elwood, Hideki, and local carry no explorer"; "No public block explorer is known for Hideki" | Networks and endpoints; `hidekiTestnet` JSDoc (`blockExplorers` unset) | `https://explorer.testnet.somnia.network/tokyo` serves this chain (its stats show `total_blocks` 36,223,251 at the time of the run; the tx links in the other reports resolve there). |
| Hideki's Multicall3 is at a non-canonical address (`0x540B…D131`); "`0xcA11bde0…` is unreachable for good" | Chains, "Absences are deliberate"; Chains walkthrough | The canonical `0xcA11bde0…CA11` holds the 3,808-byte Multicall3 runtime and answers `getBlockNumber()`. The Networks page and the chain definition say the same, so the Chains pages contradict them. |

What this costs a perps builder on Hideki:

- Block counts converted to time are off by 10×. A 1,000-block `eth_getLogs` window (the documented RPC
  limit) is 100 s of history, not 10 s. A latency budget expressed in blocks is 10× longer than planned.
- "If you are measuring latency, measure here" sets an expectation of 10 ms inclusion that the chain does not
  meet.
- The chain definition carries no `blockExplorers`, so wallets and viem-based apps built on it show no explorer
  links.
- Following the Chains page means hand-writing a Multicall3 address that holds no code on this chain.

## Evidence

```
## SDK chain definition
{ id: 50383, blockTime: 10, blockExplorers: null,
  multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 1 } }

## block time from block timestamps (seconds)
1000 blocks before 36223223: 100 s  ->  100 ms per block
100000 blocks before 36223223: 10003 s  ->  100.03 ms per block
864000 blocks before 36223223: 86427 s  ->  100.031 ms per block
36223222 blocks before 36223223: 3629103 s  ->  100.187 ms per block

## the Tokyo explorer serves this chain and reports the same cadence
{ total_blocks: '36223251', average_block_time_ms: 100 }

## Multicall3 at the canonical address
code at 0xcA11bde05977b3631167028862bE2a173976CA11: 3808 bytes
Multicall3.getBlockNumber() -> 36223261
```

Docs checked:

- Networks and endpoints (Hideki row "10 ms"; "Elwood, Hideki, and local carry no explorer"):
  https://prd.smk.somnia.host/docs/typescript/reference/networks-and-endpoints and
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/networks-and-endpoints.md
- Chains (table "10 ms"; "Hideki is the low-latency Tokyo network — ~100 blocks/s"; "Absences are
  deliberate"): https://prd.smk.somnia.host/docs/typescript/chains and
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/CHAINS.md
- Chains walkthrough ("Hideki's arrived 2026-08-10, at a non-canonical address"):
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/CHAINS_WALKTHROUGH.md
- `hidekiTestnet` ("blocks land every 10 ms (~100 blocks/s)", "No public block explorer is known for Hideki"):
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/chains/definitions/hidekiTestnet.ts

## Environment

- SDK: `@somnia-chain/markets-sdk` 0.32.1 (`@somnia-chain/markets-sdk/chains`), Node 24.13.0
- Network: Hideki testnet, chain 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`; explorer
  `https://explorer.testnet.somnia.network/tokyo`
- Wallet: none (read-only)

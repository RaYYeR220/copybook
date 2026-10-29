# Hideki RPC: state reads addressed by block hash fail ("unable to load historical state" / `-32602`), so `forge script` and `cast run` cannot run

**Severity:** major

**Area:** API

## Steps to reproduce

Read-only.

```sh
cd feedback/repro && npm ci && node 02-rpc-block-hash-reads.ts
```

The script takes the latest block and asks five state methods about the dreamDEX MarginBank
(`0x478769E1177C0773c43A593DCCc4Ad15F15F1394`) at that block, naming it four ways: hex number, bare block hash,
EIP-1898 `{ blockHash }` and EIP-1898 `{ blockNumber }`.

With Foundry 1.8.3 against the public RPC:

```sh
RPC=https://api.hideki2.infra.testnet.somnia.network

# 1. any script, even a read-only one
cat > Read.s.sol <<'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IMarginBank { function getCreditGranter() external view returns (address); }
contract Read {
    function run() external view returns (address) {
        return IMarginBank(0x478769E1177C0773c43A593DCCc4Ad15F15F1394).getCreditGranter();
    }
}
EOF
forge script Read.s.sol --rpc-url $RPC

# 2. replay any mined transaction
cast run 0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d --rpc-url $RPC

# 3. the same balance read, by hash and by number
H=$(cast block latest --field hash --rpc-url $RPC)
cast balance 0x478769E1177C0773c43A593DCCc4Ad15F15F1394 --block $H --rpc-url $RPC
cast balance 0x478769E1177C0773c43A593DCCc4Ad15F15F1394 --block $(cast block $H --field number --rpc-url $RPC) --rpc-url $RPC
```

## Expected

- `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode` and `eth_getStorageAt` accept a block hash, as
  EIP-1898 defines and as `eth_call` already does on the same node. Foundry pins its fork to a block hash.
- If block hashes are not supported, the node says so (`-32602` with a message naming the block hash), and the
  limit is listed in the docs' "Somnia vs Ethereum Differences".

## Actual

The same block, named four ways:

| method | hex number | bare block hash | `{ blockHash }` | `{ blockNumber }` |
|---|---|---|---|---|
| `eth_getBalance` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_getTransactionCount` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_getCode` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_getStorageAt` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_call` | ok | ok | ok | `-32602` invalid parameters |

- "unable to load historical state" comes back even for the hash of the head block. The node does serve
  historical state by number. `eth_getCode` for a contract deployed in block 35024249 returns `0x` at 35024248
  and 22,395 bytes at 35024249. The message therefore points at the wrong cause: it reads as "this node has no
  archive state".
- `forge script` fails at its first state read, before any Solidity runs. It pins the fork to the latest block
  with `{"blockHash": …, "requireCanonical": false}`, and the node answers `-32602`.
- `cast run` fails with "unable to load historical state". It reads the parent block's state by bare hash.
- Workarounds today: `forge create` for deploys, `debug_traceTransaction` with `callTracer` for traces (it
  works), or a local proxy that rewrites block hashes to `latest` or a number. A Hideki perps builder who
  scripts contract deploys or debugs a reverted order the usual Foundry way hits this first.

## Evidence

Run on 2026-10-29 at block 36224892 (`0x228bf7c`, hash `0x17940c10…df38`):

```
eth_getBalance, hex number
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x478769E1177C0773c43A593DCCc4Ad15F15F1394","0x228bf7c"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x0"}
eth_getBalance, bare block hash
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x478769E1177C0773c43A593DCCc4Ad15F15F1394","0x17940c10efc0dc2c8a5c212ce58c31d02e560b9b5daa4c6709f7c9d4d897df38"]}
  <- {"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"unable to load historical state","data":null}}
eth_getBalance, EIP-1898 {blockHash}
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x478769E1177C0773c43A593DCCc4Ad15F15F1394",{"blockHash":"0x17940c10efc0dc2c8a5c212ce58c31d02e560b9b5daa4c6709f7c9d4d897df38","requireCanonical":false}]}
  <- {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid parameters","data":null}}
eth_getBalance, EIP-1898 {blockNumber}
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x478769E1177C0773c43A593DCCc4Ad15F15F1394",{"blockNumber":"0x228bf7c"}]}
  <- {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid parameters","data":null}}
```

`eth_call` on the same node accepts the hash (a later run, block `0x228bfc9`):

```
  -> {"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x478769E1177C0773c43A593DCCc4Ad15F15F1394","data":"0x6a5c0a70"},"0x7cd544c3e2d762a65de959dc10416117fb66a40af49c2ab533f37bc26e13901b"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000002acd9efda721450906bfe1bef3ede269636e42c4"}
```

The first request `forge script` sends after `eth_getBlockByNumber("latest")`, captured with a logging proxy:

```
-> {"method":"eth_getTransactionCount","params":["0x1804c8ab1f12e6bbf3894d4083f33e07309d1f38",{"blockHash":"0x0f8324ba9ebe478b955ac5933284e44822b1ab2b9c1cb8ddc5952234a1af61a9","requireCanonical":false}],"id":2,"jsonrpc":"2.0"}
<- {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"invalid parameters","data":null}}
```

Foundry output:

```
$ forge script Read.s.sol --rpc-url https://api.hideki2.infra.testnet.somnia.network
Error: server returned an error response: error code -32602: invalid parameters, data: null

$ cast run 0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d --rpc-url ...
ERROR sharedbackend: Failed to send/recv `basic` err=failed to get account for 0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d: server returned an error response: error code -1: unable to load historical state, data: null
Error: EVM error

$ cast balance 0x4787…1394 --block <hash of the latest block>
Error: server returned an error response: error code -1: unable to load historical state, data: null
$ cast balance 0x4787…1394 --block <number of the same block>
0
```

The same answers come from Shannon (`https://dream-rpc.somnia.network`), so this is the node software, not one
deployment.

Docs checked:

- Somnia JSON-RPC API, https://docs.somnia.network/developer/json-rpc-api. "Account State" lists the block
  parameter of `eth_getBalance`, `eth_getCode`, `eth_getStorageAt` and `eth_getTransactionCount` as
  `blockLabel`, and `eth_call` takes `blockLabelOrHash`. Neither "Block Labels" nor "Somnia vs Ethereum
  Differences" mentions EIP-1898, block-hash parameters, or the Foundry impact.
- EIP-1898: https://eips.ethereum.org/EIPS/eip-1898

## Environment

- Tools: Foundry `forge`/`cast` 1.8.3 (cae51ad), Node 24.13.0 (`fetch`); the SDK is not involved
  (`@somnia-chain/markets-sdk` 0.32.1 is installed for the other reports)
- Network: Hideki testnet, chain 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`
  (`somnia-f9f7a5cd6b146b6-release`); also Shannon 50312 (`somnia-d151af8758cbbcb-release`)
- Wallet: none (read-only calls)

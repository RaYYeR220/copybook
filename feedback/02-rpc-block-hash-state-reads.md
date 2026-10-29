# Hideki RPC: state reads addressed by block hash fail ("unable to load historical state" / `-32602`), so Foundry cannot fork the chain (`forge script`, `forge test --fork-url`, `cast run`)

**Severity:** major

**Area:** API

## Steps to reproduce

Read-only.

```sh
cd feedback/repro && npm ci && node 02-rpc-block-hash-reads.ts
```

The script takes the latest block and asks five state methods about the dreamDEX MarginBank
(`0x478769E1177C0773c43A593DCCc4Ad15F15F1394`) at that block, naming it four ways: hex number, bare block hash,
EIP-1898 `{ blockHash }` and EIP-1898 `{ blockNumber }`. It then makes the same reads through viem's typed
`blockHash` parameter.

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

# 2. any fork test, with or without a pinned block
forge test --fork-url $RPC
forge test --fork-url $RPC --fork-block-number $(cast block-number --rpc-url $RPC)

# 3. replay a mined transaction
cast run 0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d --rpc-url $RPC

# 4. the same balance read, by hash and by number
H=$(cast block latest --field hash --rpc-url $RPC)
cast balance 0x478769E1177C0773c43A593DCCc4Ad15F15F1394 --block $H --rpc-url $RPC
cast balance 0x478769E1177C0773c43A593DCCc4Ad15F15F1394 --block $(cast block $H --field number --rpc-url $RPC) --rpc-url $RPC
```

The transaction in step 3 is a dreamDEX perps order:
[0x6880ee77…7f44d](https://explorer.testnet.somnia.network/tokyo/tx/0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d).

## Expected

The Ethereum JSON-RPC spec (ethereum/execution-apis) types the block parameter of `eth_getBalance`,
`eth_getStorageAt`, `eth_getTransactionCount` and `eth_getCode` as `BlockNumberOrTagOrHash`
(`src/schemas/block.yaml`): a number, a tag, a block hash, an EIP-1898 `{ blockNumber }` object, or an EIP-1898
`{ blockHash, requireCanonical }` object. Foundry pins its fork by block hash, so it needs these forms.

Somnia's JSON-RPC page documents a narrower parameter for these methods: `blockLabel` (`"latest"`,
`"earliest"`, `"pending"`, or hex block number). A node that keeps that narrower contract should still:

- answer an unsupported block-hash parameter with `-32602`, which Somnia's own error table maps to "Wrong number
  or types of params", instead of an application error that blames missing history;
- accept `{ blockNumber }` on `eth_call`, whose documented parameter is `blockLabelOrHash`;
- list the restriction, and its effect on Foundry, under "Somnia vs Ethereum Differences".

## Actual

The same block, named four ways:

| method | hex number | bare block hash | `{ blockHash }` | `{ blockNumber }` |
|---|---|---|---|---|
| `eth_getBalance` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_getTransactionCount` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_getCode` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_getStorageAt` | ok | `-1` unable to load historical state | `-32602` invalid parameters | `-32602` invalid parameters |
| `eth_call` | ok | ok | ok | `-32602` invalid parameters |

Not covered by the docs:

1. **A bare block hash gets `-1` "unable to load historical state", even for the head block.** Somnia's error
   table reserves `-1` for "Handler-specific errors" and maps wrong parameter types to `-32602`. The node does
   serve historical state by number: `eth_getCode` for a contract deployed in block 35024249 returns `0x` at
   35024248 and 22,395 bytes at 35024249. The message points at the wrong cause. It reads as "this node has no
   archive state", and that is how we first diagnosed it.
2. **`{ blockNumber }` is refused even by `eth_call`**, whose documented parameter is `blockLabelOrHash` and
   which accepts both hash forms.
3. **Foundry cannot fork the chain:**
   - `forge script` pins the fork with `{"blockHash": …, "requireCanonical": false}`, and the node answers
     `-32602` at its first state read, before any Solidity runs.
   - `forge test --fork-url` fails the same way. Its first failing request is
     `eth_getCode(0x4e59b448…956c, {blockHash, requireCanonical: false})`.
   - `--fork-block-number N` does not help: Foundry looks the block up by number and then pins it by hash.
   - `cast run` reads the parent block's state by bare hash and fails with "unable to load historical state".
4. **viem's typed `blockHash`** on `getBalance`, `getCode`, `getTransactionCount` and `getStorageAt` throws
   "Invalid parameters were provided to the RPC method".
5. **It is the node software, not one deployment.** Somnia mainnet (5031, `somnia-51da1ad2477251c-release`) and
   Shannon (50312) give the same answers.

Workarounds that work today:

- `anvil --fork-url $RPC`: anvil pins its fork by hex number, and reads through it succeed;
- `forge create` for deploys;
- `debug_traceTransaction` with `callTracer` for traces;
- a local proxy that rewrites block hashes to numbers or `latest`.

## Evidence

Run as of 2026-10-29T12:43Z, block 36245881 (`0x2291179`, hash `0xe9792e45…b21d`):

```
eth_getBalance, hex number
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x478769E1177C0773c43A593DCCc4Ad15F15F1394","0x2291179"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x0"}
eth_getBalance, bare block hash
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x478769E1177C0773c43A593DCCc4Ad15F15F1394","0xe9792e45af4687a7830d6c4dc0322f0b2f25e20db8657bc7a7df85aa43ffb21d"]}
  <- {"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"unable to load historical state","data":null}}
eth_getBalance, EIP-1898 {blockHash}
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x478769E1177C0773c43A593DCCc4Ad15F15F1394",{"blockHash":"0xe9792e45af4687a7830d6c4dc0322f0b2f25e20db8657bc7a7df85aa43ffb21d","requireCanonical":false}]}
  <- {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid parameters","data":null}}
eth_call, bare block hash (same block)
  -> {"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x478769E1177C0773c43A593DCCc4Ad15F15F1394","data":"0x6a5c0a70"},"0xe9792e45af4687a7830d6c4dc0322f0b2f25e20db8657bc7a7df85aa43ffb21d"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000002acd9efda721450906bfe1bef3ede269636e42c4"}
eth_call, EIP-1898 {blockNumber} (same block)
  -> {"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x478769E1177C0773c43A593DCCc4Ad15F15F1394","data":"0x6a5c0a70"},{"blockNumber":"0x2291179"}]}
  <- {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid parameters","data":null}}

viem 2.57.12
getBalance({ blockHash }): threw "Invalid parameters were provided to the RPC method." (details: invalid parameters)
getCode({ blockHash }): threw "Invalid parameters were provided to the RPC method." (details: invalid parameters)
getTransactionCount({ blockHash }): threw "Invalid parameters were provided to the RPC method." (details: invalid parameters)
getStorageAt({ blockHash }): threw "Invalid parameters were provided to the RPC method." (details: invalid parameters)
getBalance({ blockNumber }): ok -> 0n
```

Foundry's first failing requests, captured with a logging proxy on 2026-10-29:

```
forge script
-> {"method":"eth_getTransactionCount","params":["0x1804c8ab1f12e6bbf3894d4083f33e07309d1f38",{"blockHash":"0x0f8324ba9ebe478b955ac5933284e44822b1ab2b9c1cb8ddc5952234a1af61a9","requireCanonical":false}],"id":2,"jsonrpc":"2.0"}
<- {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"invalid parameters","data":null}}

forge test --fork-url
-> {"method":"eth_getCode","params":["0x4e59b44847b379578588920ca78fbf26c0b4956c",{"blockHash":"0xfb91ce5b6a8126e30a38032d7485383c5398d4199c6770f8c44dbdb9f5576eec","requireCanonical":false}],"id":2,"jsonrpc":"2.0"}
<- {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"invalid parameters","data":null}}

forge test --fork-url --fork-block-number 36242938
-> {"method":"eth_getBlockByNumber","params":["0x22905fa",false], …}            (ok)
-> {"method":"eth_getCode","params":["0x4e59b44847b379578588920ca78fbf26c0b4956c",{"blockHash":"0x3ab5df768a568d1c39d075d29d6483402a1efe5037ca0a8dd667f14d170d1ef7","requireCanonical":false}],"id":2,"jsonrpc":"2.0"}
<- {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"invalid parameters","data":null}}

anvil --fork-url (works)
-> {"method":"eth_getBalance","params":["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","0x22906ea"], …}   (ok)
   cast call <bank> "getCreditGranter()(address)" against the anvil fork -> 0x2ACD9EFdA721450906bfE1bef3edE269636E42C4
```

Foundry output (2026-10-29T12:39Z):

```
$ forge script Read.s.sol --rpc-url https://api.hideki2.infra.testnet.somnia.network
Error: server returned an error response: error code -32602: invalid parameters, data: null

$ forge test --fork-url https://api.hideki2.infra.testnet.somnia.network
Error: server returned an error response: error code -32602: invalid parameters, data: null

$ cast run 0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d --rpc-url https://api.hideki2.infra.testnet.somnia.network
Executing previous transactions from the block.
ERROR sharedbackend: Failed to send/recv `basic` err=failed to get account for 0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d: server returned an error response: error code -1: unable to load historical state, data: null address=0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d
Error: EVM error
Context:
- database error: failed to get account for 0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d: server returned an error response: error code -1: unable to load historical state, data: null

$ cast balance 0x4787…1394 --block <hash of the latest block>
Error: server returned an error response: error code -1: unable to load historical state, data: null
$ cast balance 0x4787…1394 --block <number of the same block>
0
```

Somnia mainnet (`https://api.infra.mainnet.somnia.network`, 5031):

```
eth_getBalance(<multicall>, <latest hash>)         -> {"code":-1,"message":"unable to load historical state"}
eth_getBalance(<multicall>, {blockHash: <latest>}) -> {"code":-32602,"message":"invalid parameters"}
eth_call(..., {blockNumber: "0x1"})                -> {"code":-32602,"message":"invalid parameters"}
```

Docs and spec checked:

- Somnia JSON-RPC API, https://docs.somnia.network/developer/json-rpc-api:
  - "Account State": `eth_getBalance` takes "`address`, `blockLabel` (`"latest"`, `"earliest"`, `"pending"`, or
    hex block number)", and `eth_getCode`, `eth_getStorageAt` and `eth_getTransactionCount` take `blockLabel`;
  - "Calls and Estimation": `eth_call` takes "`TransactionRequest`, `blockLabelOrHash`";
  - "Error Codes": `-32602` "Invalid parameters" / "Wrong number or types of params"; `-1` "Application error" /
    "Handler-specific errors";
  - "Somnia vs Ethereum Differences" mentions neither block hashes, EIP-1898 nor Foundry.
- ethereum/execution-apis, `BlockNumberOrTagOrHash`:
  https://github.com/ethereum/execution-apis/blob/main/src/schemas/block.yaml. It is the block parameter of
  `eth_getBalance`, `eth_getStorageAt`, `eth_getTransactionCount` and `eth_getCode` in
  https://github.com/ethereum/execution-apis/blob/main/src/eth/state.yaml.
- EIP-1898: https://eips.ethereum.org/EIPS/eip-1898

## Environment

- Tools: Foundry `forge`/`cast`/`anvil` 1.8.3 (cae51ad), viem 2.57.12, Node 24.13.0 (`fetch`); the Markets SDK
  is not involved
- Network: Hideki testnet, chain 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`
  (`somnia-f9f7a5cd6b146b6-release`); also Shannon 50312 (`somnia-d151af8758cbbcb-release`) and Somnia
  mainnet 5031 (`somnia-51da1ad2477251c-release`)
- Wallet: none (read-only calls)

# Hideki RPC: `eth_getStorageAt` returns `"0x"` for a slot that holds zero, not a 32-byte word

**Severity:** normal

**Area:** API

## Steps to reproduce

Read-only.

```sh
cd feedback/repro && npm ci && node 03-rpc-empty-storage-slot.ts
```

Or by hand, read two EIP-1967 slots of the VoucherDistributor proxy (`0x2ACD9EFdA721450906bfE1bef3edE269636E42C4`,
the address `MarginBank.getCreditGranter()` returns). The implementation slot is set; the admin slot is zero.

```sh
curl -s https://api.hideki2.infra.testnet.somnia.network -H 'content-type: application/json' -d \
 '{"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103","latest"]}'
```

## Expected

`0x0000000000000000000000000000000000000000000000000000000000000000`, a 32-byte word.

The spec's result schema is `bytes`, so `"0x"` is not strictly invalid. Every reference point shows the
32-byte zero, though:

- The ethereum/execution-apis example for `eth_getStorageAt` reads slot `0x0` and returns the 32-byte zero word.
- Somnia's own `eth_getStorageAt` reference shows a 32-byte left-padded word.
- Ethereum clients return the 32-byte zero for an unset slot.

Callers decode the result as a `bytes32`/`uint256` word.

## Actual

`"0x"` (zero bytes) for any slot whose value is zero. A slot that holds a value comes back as a normal 32-byte
word. Somnia mainnet (5031) and Shannon (50312) answer the same way.

Who it breaks:

- **JavaScript consumers.** viem `getStorageAt` passes `"0x"` through. `hexToBigInt("0x")` and `BigInt("0x")`
  throw "Cannot convert 0x to a BigInt", and `decodeAbiParameters([{ type: "uint256" }], "0x")` throws
  `AbiDecodingZeroDataError`.
- **Proxy detection** that reads the EIP-1967 implementation, admin and beacon slots gets `"0x"` for the slots a
  proxy does not use. The Markets SDK guards its own proxy read for this (`raw.length < 42` in
  `src/markets.ts`), so every other consumer needs the same special case.

Scope, to be precise: Foundry pads the answer. `cast storage` and `cast admin` print the 32-byte zero / zero
address, and an `anvil --fork-url` fork returns a 32-byte zero for the same slot. So this is a JS/TS-side
breakage, not a Foundry one.

## Evidence

As of 2026-10-29T12:43Z, Hideki:

```
a slot that holds a value (EIP-1967 implementation slot):
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc","latest"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000009657f0fd53efc01cd108d93c835bb4b517732b43"}
a slot that holds zero (EIP-1967 admin slot):
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103","latest"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x"}
```

Other Somnia networks (slot `0x0` of `0x…dEaD`):

```
https://api.infra.testnet.somnia.network   <- {"jsonrpc":"2.0","id":1,"result":"0x"}
https://api.infra.mainnet.somnia.network   <- {"jsonrpc":"2.0","id":1,"result":"0x"}
```

The same request against an Ethereum mainnet node (`https://ethereum-rpc.publicnode.com`), where that slot is
also empty:

```
  <- {"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000000000000000000000000000000000000000000000"}
```

viem 2.57.12 on the Hideki answer:

```
getStorageAt -> "0x"
hexToBigInt(word) threw: Cannot convert 0x to a BigInt
decodeAbiParameters([uint256], word) threw: Cannot decode zero data ("0x") with ABI parameters.
BigInt(word) threw: Cannot convert 0x to a BigInt
```

Foundry 1.8.3 on the same slot:

```
$ cast storage 0x2ACD…42C4 0xb531…6103 --rpc-url <hideki>   -> 0x0000000000000000000000000000000000000000000000000000000000000000
$ cast admin 0x2ACD…42C4 --rpc-url <hideki>                  -> 0x0000000000000000000000000000000000000000
$ cast storage 0x2ACD…42C4 0xb531…6103 --rpc-url <anvil --fork-url hideki>  -> 0x0000…0000 (32 bytes)
```

Docs and spec checked:

- ethereum/execution-apis `eth_getStorageAt` (result schema `bytes`; the example returns
  `0x0000000000000000000000000000000000000000000000000000000000000000` for slot `0x0`):
  https://github.com/ethereum/execution-apis/blob/main/src/eth/state.yaml
- Somnia JSON-RPC API, `eth_getStorageAt`, https://docs.somnia.network/developer/json-rpc-api:
  - it returns "`bytes` (hex)", and its example result is the 32-byte word
    `0x000000000000000000000000d6b03d71e401479cc976fc94a41a37576404e7bd`;
  - "Missing Resource Semantics" covers transactions, blocks, receipts and filters, not storage slots, and
    "Somnia vs Ethereum Differences" does not mention this.

## Environment

- viem 2.57.12, Node 24.13.0, Foundry 1.8.3; `@somnia-chain/markets-sdk` 0.32.1 source referenced for its own guard
- Network: Hideki testnet, chain 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`
  (`somnia-f9f7a5cd6b146b6-release`); also Shannon 50312 and Somnia mainnet 5031
- Wallet: none (read-only)

# Hideki RPC: `eth_getStorageAt` returns `"0x"` for a slot that holds zero, not a 32-byte word

**Severity:** normal

**Area:** API

## Steps to reproduce

Read-only.

```sh
cd feedback/repro && npm ci && node 03-rpc-empty-storage-slot.ts
```

Or by hand: read two EIP-1967 slots of the VoucherDistributor proxy (`0x2ACD9EFdA721450906bfE1bef3edE269636E42C4`,
the address `MarginBank.getCreditGranter()` returns). The implementation slot is set and the admin slot is zero.

```sh
curl -s https://api.hideki2.infra.testnet.somnia.network -H 'content-type: application/json' -d \
 '{"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103","latest"]}'
```

## Expected

`0x0000000000000000000000000000000000000000000000000000000000000000`, a 32-byte word. That is what the
example in Somnia's own `eth_getStorageAt` reference shows (a left-padded 32-byte value) and what Ethereum
clients return for an unset slot. Callers decode the result as `bytes32`/`uint256`.

## Actual

`"0x"` (zero bytes) for any slot whose value is zero. A slot that holds a value comes back as a normal 32-byte
word.

Generic code breaks on it:

- viem `getStorageAt` passes `"0x"` through. `hexToBigInt("0x")` throws "Cannot convert 0x to a BigInt", and
  `decodeAbiParameters([{ type: "uint256" }], "0x")` throws `AbiDecodingZeroDataError`.
- Proxy detection, which reads the EIP-1967 implementation, admin and beacon slots, gets `"0x"` for the slots a
  proxy does not use. The Markets SDK guards its own proxy read for this (`raw.length < 42` in `markets.ts`), so
  every other consumer has to add the same special case.

The same answer comes from Shannon (`https://dream-rpc.somnia.network`, `https://api.infra.testnet.somnia.network`).

## Evidence

2026-10-29, Hideki:

```
a slot that holds a value (EIP-1967 implementation slot):
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc","latest"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000009657f0fd53efc01cd108d93c835bb4b517732b43"}
a slot that holds zero (EIP-1967 admin slot):
  -> {"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103","latest"]}
  <- {"jsonrpc":"2.0","id":1,"result":"0x"}
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
```

Docs checked:

- Somnia JSON-RPC API, `eth_getStorageAt`: https://docs.somnia.network/developer/json-rpc-api. It returns
  "`bytes` (hex)", and its example result is the 32-byte word
  `0x000000000000000000000000d6b03d71e401479cc976fc94a41a37576404e7bd`. "Missing Resource Semantics" covers
  transactions, blocks, receipts and filters, not storage slots, and "Somnia vs Ethereum Differences" does not
  mention this. An unset slot is a zero value, not a missing resource.

## Environment

- viem 2.57.12, Node 24.13.0; `@somnia-chain/markets-sdk` 0.32.1 source referenced for its own guard
- Network: Hideki testnet, chain 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`
  (`somnia-f9f7a5cd6b146b6-release`); also Shannon 50312
- Wallet: none (read-only)

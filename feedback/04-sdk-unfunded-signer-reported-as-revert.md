# SDK: a write from a signer with no STT throws `ContractRevertError` ("… reverted: Missing or invalid parameters") instead of `RpcError`

**Severity:** normal

**Area:** SDK

## Steps to reproduce

No transaction can be mined: the script generates a key in memory and never funds it.

```sh
cd feedback/repro && npm ci && node 04-sdk-unfunded-signer.ts
```

1. `new SomniaMarkets({ chain: hidekiTestnet, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey })` with a
   new private key (balance 0).
2. `trader.setOperatorApprovalGlobal({ operator, selectors: ["0x80054449"], approved: true, operatorRegistry })`.
   This is the Link-a-Bot grant, usually a new bot account's first write.
3. `trader.claimPerpVoucher({ marginBank })`.
4. Send a signed 0-value transfer from the same key with `eth_sendRawTransaction`, to see the node's own answer.

## Expected

The errors reference says `RpcError` covers the case where "the node refused the transaction (nonce too low,
insufficient funds)". The `RpcError` JSDoc adds that "a call that *did* reach the chain and was rejected by a
contract is a `ContractRevertError` instead". An unfunded signer should therefore get an `RpcError` whose
message says the account cannot pay for gas.

## Actual

Both writes throw `ContractRevertError` with `errorName: undefined`, `data: "0x02"` and the message
`@somnia-chain/markets-sdk: setOperatorApprovalGlobal reverted: Missing or invalid parameters.` (`claim reverted: …`
for the voucher). No contract was called. The cause chain holds the node's refusal: `-32000 account does not exist`.

Two things combine:

- The node refuses a transaction from a never-funded account with `-32000 "account does not exist"` and
  `data: "0x02"`. Ethereum nodes say "insufficient funds for gas * price + value" here.
- The SDK's `isRevert()` (`src/revert.ts`) treats any hex `data` found in the cause chain as revert data, so the
  refusal becomes a `ContractRevertError` with `data: "0x02"`.

A new bot that forgot to fund its key is told its approval "reverted" because of "invalid parameters". The
`RpcError` docs say to check for `ContractRevertError` first when branching. Code that does so treats this as a
contract rejection that "fails again unless state changes", and never prompts the user to fund the key.

## Evidence

2026-10-29, signer `0x70364bfb6DfF017bFc45261f62BBE870e59A370f` (balance `0x0`):

```
trader.setOperatorApprovalGlobal: {
  class: 'ContractRevertError',
  'instanceof ContractRevertError': true,
  'instanceof RpcError': false,
  errorName: undefined,
  data: '0x02',
  message: '@somnia-chain/markets-sdk: setOperatorApprovalGlobal reverted: Missing or invalid parameters.'
}
   cause 0: InvalidInputRpcError code=-32000 details=account does not exist
   cause 1: RpcRequestError code=-32000 details=account does not exist
trader.claimPerpVoucher: {
  class: 'ContractRevertError',
  'instanceof ContractRevertError': true,
  'instanceof RpcError': false,
  errorName: undefined,
  data: '0x02',
  message: '@somnia-chain/markets-sdk: claim reverted: Missing or invalid parameters.'
}
   cause 0: InvalidInputRpcError code=-32000 details=account does not exist

eth_sendRawTransaction (0-value transfer, same key):
  <- {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"account does not exist","data":"0x02"}}
```

Docs checked:

- Errors reference, the `RpcError` and `ContractRevertError` rows:
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/errors.md
- Handle errors and reverts: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/how-to/handle-errors.md
- `RpcError` JSDoc ("For a write, the node can also have answered with a refusal (nonce too low, insufficient
  funds)"): https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/errors.ts
- Somnia JSON-RPC API, error codes: https://docs.somnia.network/developer/json-rpc-api. It does not list
  "account does not exist".

## Environment

- SDK: `@somnia-chain/markets-sdk` 0.32.1, viem 2.57.12, Node 24.13.0
- Network: Hideki testnet, chain 50383, default SDK transport for `hidekiTestnet`
- Wallet: SDK local private-key signer (`privateKey` config), a new EOA with no STT

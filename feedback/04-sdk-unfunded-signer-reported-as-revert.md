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

The SDK's own docs describe this case and say it is an `RpcError`.

`docs/how-to/handle-errors.md`:

> From the local-signer and session-key executors, a plain `RpcError` from a write means the node refused the
> transaction or nothing was sent. Fix the cause (for example a stale nonce or an unfunded account), then send
> again.

`docs/NATIVE.md`, "Read the node's message, not viem's", uses this exact refusal as its example. Somnia
reports mempool rejections as `-32000` with a `MempoolStatusCode` byte in `data`, and an unfunded sender shows
up as `"account does not exist"`. `src/native/errors.ts` decodes that byte (`SomniaMempoolStatus.accountDoesNotExist = 2`),
and `src/txSend.ts` already has `isNodeRefusal(e)`, defined as `getSomniaRpcError(e)?.mempoolStatus != null`.

So an unfunded signer should get an `RpcError` (a node refusal that a retry after funding fixes), with the
node's message "account does not exist".

## Actual

Both writes throw `ContractRevertError` with `errorName: undefined`, `data: "0x02"` and the message
`@somnia-chain/markets-sdk: setOperatorApprovalGlobal reverted: Missing or invalid parameters.` (`claim reverted: …`
for the voucher). No contract was called. The cause chain holds the node's refusal: `-32000 account does not exist`.

The code path (from reading the 0.32.1 source):

- `executor/local.ts` sends with `decorateError: (e, method) => Revert.toSdkError(e, method, context)`.
- `revert.ts` `toSdkError` calls `isRevert(caught)` before anything else.
- `isRevert` → `findRevertData` returns the first hex `data` in the cause chain, and here that is the mempool
  status byte `"0x02"`.
- So the refusal becomes `decodeRevert(...)`, a `ContractRevertError` carrying `data: "0x02"`.

By the same reading, every refusal that carries a status byte takes this path:
`insufficientBalance` `0x03`, `nonceTooSmall` `0x04`, `gasPriceBelowBaseFee` `0x0c`, and the rest.

Effect: a new bot that forgot to fund its key is told its approval "reverted" because of "invalid parameters".
Code that branches the way the docs suggest (check for `ContractRevertError` first) treats it as a contract
rejection that "fails again unless state changes", and never prompts the user to fund the key.

A possible fix: in `toSdkError`, return an `RpcError` when `getSomniaRpcError(caught)?.mempoolStatus != null`
(the existing `isNodeRefusal`), before the `isRevert` check.

## Evidence

As of 2026-10-29T12:43Z, signer `0x285a15cAD9559af17fb051CE0dcCBC237EE48908` (balance `0x0`):

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

Docs and source checked (SDK 0.32.1):

- Handle errors and reverts: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/how-to/handle-errors.md
- Native RPC, "Read the node's message, not viem's": https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/NATIVE.md
- Errors reference (`RpcError`: "the node refused the transaction (nonce too low, insufficient funds)"):
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/errors.md
- `SomniaMempoolStatus` / `getSomniaRpcError`: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/native/errors.ts
- `isNodeRefusal`: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/txSend.ts
- `toSdkError` / `isRevert` / `findRevertData`: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/revert.ts
- `decorateError`: https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/executor/local.ts
- Minor: Somnia's JSON-RPC page lists common `-32000` transaction errors ("insufficient balance", …), but not
  "account does not exist" (https://docs.somnia.network/developer/json-rpc-api, "Error Codes").

## Environment

- SDK: `@somnia-chain/markets-sdk` 0.32.1, viem 2.57.12, Node 24.13.0
- Network: Hideki testnet, chain 50383, default SDK transport for `hidekiTestnet`
- Wallet: SDK local private-key signer (`privateKey` config), a new EOA with no STT

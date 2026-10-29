# Perp voucher: `getPerpVoucherEligibility` returns `eligible: true`, but `VoucherDistributor.claim()` reverts `0x3e31dcc2` for every account

**Severity:** major

**Area:** SDK

## Steps to reproduce

Read-only; no key and no transaction needed.

```sh
cd feedback/repro && npm ci && node 01-voucher-self-claim.ts
```

The script does the following with `@somnia-chain/markets-sdk` 0.32.1 against the public Hideki RPC:

1. `client.getPerpVoucherCampaign(marginBank)` with `SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank`
   (`0x478769E1177C0773c43A593DCCc4Ad15F15F1394`). It returns distributor
   `0x2ACD9EFdA721450906bfE1bef3edE269636E42C4`, an open campaign window and 189,873 claims left (as of
   2026-10-29T12:43Z; the number falls as grants go out).
2. `client.getPerpVoucherEligibility(marginBank, account)` for a random new address.
3. Simulates the transaction `trader.claimPerpVoucher` sends: `eth_call` (and `eth_estimateGas`) of
   `claim()` (`0x4e71d92d`) on the distributor with `from` = that address.
4. Decodes the revert with the SDK's `decodeRevert` and looks the selector up in `contractErrorsAbi`.
5. Repeats 2–4 for an account that holds open positions, where the SDK answers `notFlat`.

## Expected

The SDK documents `eligible: true` as "A claim sent now would succeed, unless state changes before it lands",
and documents the reasons as "checked in the order `VoucherDistributor.claim()` checks them, so the reason names
the revert a claim would produce at the same block". The Perps guide says "Check eligibility before you claim"
and shows `if (eligibility.eligible) await trader.claimPerpVoucher({ marginBank })`.

So either the claim succeeds for an eligible account, or, if self-claims are switched off on this deployment
on purpose (grants pushed by an operator instead):

- `getPerpVoucherEligibility` returns `eligible: false` with a reason for it (the distributor exposes a claim
  policy the SDK could read);
- the revert is in `contractErrorsAbi`, so `ContractRevertError.errorName` names it;
- the Perps guide says how a testnet account gets its grant.

## Actual

- `getPerpVoucherEligibility` returns `{ eligible: true, grantAmount: 1000000000000000000000n }` for any new
  address.
- `claim()` reverts with custom error data `0x3e31dcc2` for every account tried, including an account the SDK
  reports as `notFlat`, where `ClaimantNotFlat` would be the expected revert. The check behind `0x3e31dcc2`
  runs before every condition the SDK models.
- `0x3e31dcc2` is `keccak256("SelfClaimDisabled()")[0:4]`. The distributor's implementation
  (`0x9657f0fd53efc01cd108d93c835bb4b517732b43`, behind the EIP-1967 proxy) is not verified on the explorer, so
  this name, and `getClaimPolicy()` for selector `0x6c87f4b2`, are selector matches rather than published
  names. `getClaimPolicy()` returns `(604800, true, false, true)`.
- `decodeRevert` returns `errorName: undefined`. `contractErrorsAbi` (546 errors) has no entry for
  `0x3e31dcc2`. The `claimPerpVoucher` JSDoc already notes that `ClaimantNotFlat` and `ClaimantIsMainFunded`
  are missing from the table. This selector is missing too, and it is the one every caller hits.
- Grants are being issued, but not through `claim()`. Operator `0x792182e6b2bd50deb22dc5436f7c518b34f9bd12`
  calls selector `0x0677d0a3` on the distributor with a list of addresses: 144 accounts in
  `0xe3a89e81…a415f`, each credited 1,000 USDso (`MarginEvent` `Credited`).
- A builder who follows the guide sends a transaction that cannot succeed. It mines, reverts and costs gas. On
  2026-10-27 the SDK's `claimPerpVoucher` sent three such claims from three new accounts. The SDK reported
  "claim reverted: for an unknown reason".

## Evidence

Requests and responses as of 2026-10-29T12:43Z (random new address `0x6066eea1695fc235a4560b96909f80cd289b5d6c`):

```
SDK getPerpVoucherEligibility: { eligible: true, grantAmount: 1000000000000000000000n }

-> {"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"from":"0x6066eea1695fc235a4560b96909f80cd289b5d6c","to":"0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","data":"0x4e71d92d"},"latest"]}
<- {"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x3e31dcc2"}}

-> {"jsonrpc":"2.0","id":1,"method":"eth_estimateGas","params":[{"from":"0x6066eea1695fc235a4560b96909f80cd289b5d6c","to":"0x2ACD9EFdA721450906bfE1bef3edE269636E42C4","data":"0x4e71d92d"}]}
<- {"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x3e31dcc2"}}

SDK decodeRevert: { errorName: undefined, data: '0x3e31dcc2' }
```

Account with open positions (`0x47537e3a3ea6e9391f3b26ea45618db6828c8bff`):

```
SDK getPerpVoucherEligibility: { eligible: false, reason: 'notFlat' }
<- {"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x3e31dcc2"}}
```

Selector and policy:

```
contractErrorsAbi: 546 errors, 0x3e31dcc2 -> not present
toFunctionSelector('SelfClaimDisabled()') = 0x3e31dcc2
toFunctionSelector('getClaimPolicy()')    = 0x6c87f4b2
eth_call 0x6c87f4b2 on the distributor, decoded as (uint64,bool,bool,bool): [ 604800n, true, false, true ]
```

Operator batch grant: [`0xe3a89e819ea86a0beea80e39b9e0ba768a178ee868949958d54722b34faa415f`](https://explorer.testnet.somnia.network/tokyo/tx/0xe3a89e819ea86a0beea80e39b9e0ba768a178ee868949958d54722b34faa415f)
(from `0x7921…bd12`, to the distributor, selector `0x0677d0a3`, 144 addresses).

Claims sent by `trader.claimPerpVoucher` on 2026-10-27 from new accounts. All three have status 0 and 22,781 gas
used. Replaying the first as `eth_call` at block 34692562 returns the same `0x3e31dcc2`.

| tx | block | from |
|---|---|---|
| [`0xd67564f2…6b9d9`](https://explorer.testnet.somnia.network/tokyo/tx/0xd67564f2eef8e44058cba8105e7bef6e435fd187bc70bdccacdbdcde9b16b9d9) | 34692563 | `0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d` |
| [`0x2e21ed1f…627d9`](https://explorer.testnet.somnia.network/tokyo/tx/0x2e21ed1f23f9efcb9a45eb6bb34d0924f9da31305cd5675d9fa6474fc57627d9) | 34692601 | `0x7d736A88978e94E60494Ff91C49Ba838EDfb1932` |
| [`0x5cf63fa6…31412`](https://explorer.testnet.somnia.network/tokyo/tx/0x5cf63fa676dc8d41e70e069a6e2ea543225a64804503777fb667f01ed1631412) | 34692643 | `0xcee40D3C7709404Cf60916BFEa39925fcB1f09Ed` |

Docs checked (none mentions self-claims being off, a claim policy, or operator-pushed grants):

- Perps guide, "Credit vouchers (house money)", shipped with the SDK:
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/PERPS.md
- `PerpVoucherEligibility` / `PerpVoucherIneligibleReason`:
  https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/perp/voucher.ts
- `Trader.claimPerpVoucher` (throws list): https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/src/trade.ts
- Errors reference, which calls `contractErrorsAbi` "the generated ABI of every custom error the protocol
  contracts declare": https://unpkg.com/@somnia-chain/markets-sdk@0.32.1/docs/reference/errors.md
- The docs site's Perps page (https://prd.smk.somnia.host/docs/typescript/perps) has no "Credit vouchers"
  or `claimPerpVoucher` section.

The same run against `@somnia-chain/markets-sdk@0.32.2-canary.38575926931.ge4550933d36d` (the current `canary`
tag) gives the same results: `eligible: true`, `errorName: undefined`, and 547 errors in `contractErrorsAbi`
without `0x3e31dcc2`. npm `latest` is 0.32.1.

## Environment

- SDK: `@somnia-chain/markets-sdk` 0.32.1 (npm `latest` on 2026-10-29; the 0.32.2 canary behaves the same),
  viem 2.57.12, Node 24.13.0
- Network: Hideki testnet, chain 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`
  (`web3_clientVersion` `somnia-f9f7a5cd6b146b6-release`), head block ~36.25M at 2026-10-29T12:43Z
- Wallet: none for the reproduction (`eth_call` from a random address). The 2026-10-27 transactions came from
  the SDK's private-key signer (`privateKey` config) on new EOAs that held only STT.

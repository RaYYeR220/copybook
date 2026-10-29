# Limits

What Copybook does not do, what has not been shown on chain, and what it depends on. The evidence for what it does
is in [CLAIMS.md](CLAIMS.md) and [PROOF.md](PROOF.md).

## Testnet only

Everything runs on Somnia testnets: Hideki (chain 50383) for the hub, the theses, the gate and dreamDEX's perps, and
Shannon (chain 50312) for the review committees. STT and USDso have no market value, and nothing is deployed on a
mainnet. dreamDEX's perps are themselves on testnet only (its
[docs](https://app.testnet.dreamdex.io/docs/trading/perps-testnet/README.md), read 2026-10-29).

## Our wallets, no outside users

Every wallet that follows, leads, creates a thesis or acts as the agent in the recorded runs is ours, listed in
`demoWallets` in [`deployments/hideki.json`](../deployments/hideki.json). The app marks each one ours and leaves it
out of every ranking. The traders the AI guard reviewed are real dreamDEX accounts. No outside users are claimed.

| Role | Address |
| --- | --- |
| owner (deploys and owns the contracts) | `0x5397812d66F3233E0972b7AEB5e195a945504632` |
| demo leader | `0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d` |
| demo follower (e2e and risk runs) | `0x7d736A88978e94E60494Ff91C49Ba838EDfb1932` |
| demo follower (app run) | `0xDe52dd7f81F67D2124ae0fBd8567f405cFAEeaAB` |
| demo thesis follower | `0xcee40D3C7709404Cf60916BFEa39925fcB1f09Ed` |
| demo thesis creator | `0xA969Dd0B79Ca1d4571E45d97A8f4981805eBaEd3` |
| demo agent (MCP) | `0xCDE791006eA6E99e9A614Bc9d0995879E2Cc5E72` |

The demo leader moves only when we trade it, so its followers get a copy only then. During judging (until
2026-11-21) a bot of ours trades it: a small BTC or ETH position about every 25 minutes.

## What is mocked

Nothing in the paths a user or an agent runs. The app, the SDK and the MCP server use the deployed contracts, Hideki's
public RPC and WebSocket, and dreamDEX's public indexer. Reviews run on the live Somnia Agents platform on Shannon and
cross the live Hyperlane testnet lane.

Mocks and recordings exist in tests only:

- contracts: `contracts/test/mocks/` (perp pool, margin bank, Reactivity precompile) and `contracts/test/risk/mocks/`
  (agent platform, Hyperlane mailbox);
- the SDK's unit tests run against a scripted chain (`packages/sdk/test/fake.ts`, `packages/sdk/test/world.ts`);
  `COPYBOOK_LIVE=1` adds a read-only pass over the live contracts;
- the MCP server's tests use mocked SDK and stats clients;
- app and stats tests replay chain and indexer answers recorded from Hideki (`app/test/fixtures/`,
  `packages/stats/test/fixtures/`).

The landing page's proof figures are recorded transactions (`app/content/proof.ts`), each checked in
[PROOF.md](PROOF.md#the-landing-pages-proof). Its example thesis ("Majors over memes") is an illustration, not a thesis
on chain. Its AI-guard example uses the figures of a recorded refusal and exit: the leader adds 0.0003 BTC and the
guarded follower is refused ([row](PROOF.md#guard-blocked)), then the follower's 0.0005 BTC closes with the leader's
exit ([row](PROOF.md#guard-exit)).

## Copying

- **Same block is the rule, not a guarantee.** A copy is placed in the source's block when Reactivity delivers the
  event and the handler's gas covers the follower. A follower it cannot cover is deferred and synced by `catchUp`, which is
  not a same-block copy and is never labelled one. All 23 recorded pairs are same-block
  ([PROOF](PROOF.md#same-block-copies)). The hub's whole event log through Hideki block 36,282,657 (read from
  `/api/history` on 2026-10-29) holds no `Deferred` or `GroupDeferred`, so the deferral path is shown by tests only
  (`contracts/test/HubEdgeCases.t.sol::test_exitsOutOfGas_deferredUnbilled`).
- **A close can go unfilled.** Exits are never gated: no cap, tank, pause or AI verdict holds back a close. A close is
  one immediate-or-cancel order within max(2× the follower's band, 1%) of the mark (`_reduce` in
  `contracts/src/CopyEngine.sol`, `exitBand` in `contracts/src/PolicyLib.sol`). If the book cannot fill it there, it
  is recorded as `Refused(BandUnfilled)` (or `VenueRejected` when the venue rejects the order), and the position syncs
  at the source's next move or a `catchUp` (`contracts/test/HubFollow.t.sol::test_iocSuccessWithoutFill_isBandUnfilled`).
  A residue below one lot or the venue's minimum order is dust the venue cannot take; it stays in the account until a
  later order that crosses zero takes it along.
- **A whole-book follow opens nothing by itself.** The positions the trader already holds open through `catchUp` or at
  the trader's next move in each market ([catchUp](PROOF.md#app-catchup), [next move](PROOF.md#app-live)).
- **A copy copies the outcome too.** Scale, caps, the band and the equity floor bound the size and price of each copy,
  not whether the trade makes money. The equity floor acts when someone calls `poke` or at the follower's next
  increase; the app and the SDK report the call, but nothing sends it on a schedule.
- **One source per wallet.** A second follow from the same wallet reverts. A follow manages every market its source
  trades in that wallet, including a position the wallet opened by hand there; use a dedicated wallet.
- **Paper USDso has an allowlist.** dreamDEX's Perps Arena credit opens positions only in some markets. A copy into
  another market fails at the venue and is recorded as a refusal.
- **Recorded prices are limits.** `Copied` carries the limit price of the order that moved the position, not its
  fill.
- **Thesis books drift between versions.** Marks move between rebalances; a thesis follower's `resync` brings the book
  back to the current weights.
- **No builder fee.** Every order the hub places carries no builder address and no fee.

## Refusals: what is on chain and what is tested

Every refusal reason is written on chain as `Refused(reason)` when it happens. Three have been recorded live:

| Reason | Recorded |
| --- | --- |
| `BandUnfilled` | [the 1000PEPE increase with a 5 bps band](PROOF.md#refusal-band) |
| `RiskGate` | [a guarded follower under a BLOCK](PROOF.md#guard-blocked), and [the app run's guarded follower](PROOF.md#app-live) |
| The equity floor | as a `Stopped` from `poke`, which closed the copy ([row](PROOF.md#floor-poke)); no `Refused(EquityFloor)` has been recorded |

The hub's whole log through block 36,282,657 holds 6 refusals, 1 `BandUnfilled` and 5 `RiskGate`, and 1 `Stopped`.
TotalCap, EquityFloor (as a refusal), TankEmpty, BelowMinimum, AtCap, MarketNotAllowed, VenueRejected, LegFailed and
Paused are shown by contract tests only, each listed in [CLAIMS.md](CLAIMS.md#exits-policy-and-refusals).

## The operator grant

The follower grants the hub one selector, `placeOrderFor` (`0x80054449`), on dreamDEX's operator registry
([app approval](PROOF.md#app-approve)). That this grant cannot withdraw or move funds is dreamDEX's operator model,
not something Copybook enforces. The grant the app and the MCP server ask for is global: it covers every perps market
of the wallet and stays after unfollow until revoked ([revoke](PROOF.md#app-revoke)).

## The AI guard

- **The verdict lane is a dev lane.** The Hyperlane lane between Shannon and Hideki has a single validator on each
  side's ISM, the same key on both. Whoever holds that key could deliver a forged verdict, a BLOCK included. The
  committee's work can be checked on Shannon; the gate on Hideki trusts the lane.
- **A verdict is a risk tier, not advice.** An LLM committee applies a published rubric to data from Copybook's own
  endpoint. The data committee attests that its members fetched the same bytes, not that the bytes are true; the
  risk line is built from the dreamDEX indexer with a 2,000-row cap (`partial=1` beyond it).
- **The scorecard is small.** Each run reviews 20 traders once. Run v3 is not an out-of-sample estimate; run v4, on
  20 traders no earlier run had seen, scored 19 of 20 (95% interval 76–99%). Run-to-run stability was not tested, and the thin-data rule was
  applied to 1 of 3 thin traders in run v3 and to run v4's single thin trader
  ([scorecard limitations](../eval/SCORECARD.md#limitations)).
- **The committee can miss a BLOCK.** In run v4 a trader with 10 liquidations got CAUTION, 3 votes of 3. The gate then
  lets guarded followers add size to that trader until a new review says BLOCK.
- **Verdicts change.** A trader's tier is whatever the last review returned, held by the gate's 24-hour BLOCK hold and
  7-day expiry. Read the current one on the trader's page in the app, not in these docs.
- **A BLOCK is cheaper to get than to lose.** A new BLOCK replaces a stored one at any time; a milder verdict waits out
  the hold. Each review costs 0.5 STT and a trader can be reviewed again 10 minutes after a verdict.
- **Reviews need a funded reviewer.** The reviewer pays the committees' deposits on Shannon (0.36 STT held per review,
  about 0.215 STT spent, in runs v3 and v4). An unfunded reviewer answers with no verdict, which leaves the stored one as it
  was.
- **The guard covers trader follows only,** and refuses increases only. Exits are never gated.

## Trust in the contracts' owners

The hub's owner (ours) can point the hub at another gate (a gate can only refuse increases), tune the handler's gas
budget and billing overhead within the contract's bounds, change subscription fees for groups opened later, and pause
new follows. It cannot take a follower's tank or place orders.

The gate's owner (ours) can switch the reviewer with `setReviewer`, and with it whose messages count as verdicts. The
reviewer's owner on Shannon (ours) can change the endpoint the data committee fetches (`setBaseUrl`), the field it
reads (`setSummarySelector`), the rubric sent to the LLM committee (`setSystemPrompt`), the agents (`setAgents`) and
the gate it answers (`setGate`), and withdraw the reviewer's balance. None of the three contracts can renounce
ownership, so these settings stay reachable. See [who can do what](ARCHITECTURE.md#who-can-do-what).

## Shown in code, not by a test or a transaction

- The app has no backend database: it has no database dependency (`app/package.json`).
- The app and the MCP server go on chain through `@copybook/sdk` (`app/lib/server/chain.ts`,
  `app/components/follow/hooks.ts`, `packages/mcp/src/config.ts`).
- Wallet discovery through EIP-6963 (`app/lib/wallet/config.ts`, wagmi's injected connector); adding the network has a
  test, discovery does not.
- The CAUTION flag on the dashboard (`app/components/me/GuardCard.tsx`); the feed's verdict rows have a test.

## Dependencies

- **Hideki's public RPC and WebSocket.** The app, the SDK and the MCP server read through them; the live tape needs
  the WebSocket.
- **The dreamDEX indexer.** Discover, trader statistics and the risk line come from it. When it is down, those
  routes answer with an error once their caches run out, and a review whose committee cannot fetch the line ends with
  no verdict.
- **The app on Vercel.** It also serves the risk endpoint the validators read.
- **STT balances.** The hub keeps the Reactivity precompile's 32 STT subscription balance; the reviewer on Shannon
  pays each review's deposits.

## Costs

Gas figures are single testnet runs at 6 gwei ([gas](PROOF.md#gas)). They are not a mainnet estimate.

## The MCP server

- It is not published to npm; it runs from a clone.
- It has no tool for `catchUp`, `poke`, `resume` or `resync`. `get_follow` names the call a stuck follow needs; send it
  from the app or the SDK.
- `get_copy_history` reads the last 50,000 blocks (about 80 minutes at Hideki's 100 ms blocks) unless given
  `fromBlock`.

## Verification and review

- The Shannon contracts' sources are read back from Shannon's explorer on every ledger run. The Tokyo explorer's API
  does not answer verification queries, so the Hideki contracts rest on the `forge verify-contract` result recorded at
  deploy time ([contracts](PROOF.md#contracts)).
- The contracts have unit tests, invariant tests and live runs. They have not been audited.

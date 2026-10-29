# Copybook e2e on Hideki

A live run of Copybook against dreamDEX perps on Somnia's Hideki testnet (chain 50383). It deploys the
contracts, follows a real trader account and a thesis, trades with the SDK, and checks every reaction on
chain: the copy lands in the leader's own block, the band refuses an unfillable increase, a thesis opens
both legs in one transaction, the equity stop flattens, and so on. Every transaction and every check
goes to `e2e/out/proof.json`.

## Prerequisites

- Node 24 and npm.
- Foundry (`forge`, `cast`); the contracts build with solc 0.8.30 (via IR).
- Four testnet wallets, funded on Hideki:
  - **hub owner**: deploys, owns the hub, creates the e2e thesis and funds the others. Needs about
    45 STT for the deploy and the hub's subscription balance (the Reactivity precompile requires a
    subscription owner to hold 32 STT; the script sends 40), plus USDso for the other wallets' margin.
  - **leader**: the trader being copied.
  - **follower**: follows the leader.
  - **follower2**: follows the thesis (a fresh wallet: it grants the hub globally, not per market).

  The `setup` scenario tops each of the three up from the hub owner: STT to 3 for gas, and USDso margin
  (leader 20, follower 25, follower2 40) whenever a wallet's equity is below half of that.

## Keys: `COPYBOOK_ENV`

Keys never live in the repo. Copy `../.env.example` to a file outside the repo, fill it in, and point
`COPYBOOK_ENV` at it:

```
HUB_OWNER_PK=0x...
LEADER_PK=0x...
FOLLOWER_PK=0x...
FOLLOWER2_PK=0x...
# optional
# HIDEKI_RPC=https://api.hideki2.infra.testnet.somnia.network
# HIDEKI_INDEXER=https://hideki-dev.smk.somnia.host/v1/graphql
```

The file is read only when a key is first needed, so `record-deploy`, the RPC shim and `typecheck` run
without it.

## 1. Build

```sh
cd contracts && npm ci && forge build    # e2e reads the ABIs from contracts/out
cd ../e2e && npm ci                      # links packages/stats as @copybook/stats; no install at the repo root needed
```

`npm run typecheck` and the eval (`npm run eval:test`, `npm run eval score`) need only these two installs; the
`risk` and `live` steps also read the ABIs from `contracts/out`.

## 2. Deploy

`forge script` cannot talk to a Hideki node directly. The node refuses state reads addressed by block
hash. A bare hash gets `-1` "unable to load historical state", and an EIP-1898 object (`{"blockHash": ...}`
or `{"blockNumber": ...}`) gets `-32602`. Reads by block number work, historical ones included. Forge pins
its fork by block hash, so its first state read fails. Details are in
[`feedback/02`](../feedback/02-rpc-block-hash-state-reads.md).

`npm run rpc-shim` starts a local JSON-RPC proxy on `127.0.0.1:8547` that sends every state read to
`latest`. It also pads the node's `"0x"` answer for an empty storage slot into a 32-byte zero word (see
[`feedback/03`](../feedback/03-rpc-empty-storage-slot.md)). Foundry copes with that one on its own, so the
padding is only a safeguard. The shim is for broadcasting from your own machine only.

Forge's local gas estimate is also about 10x below what Somnia charges, so the script runs with
`--skip-simulation`: each transaction is estimated by the node itself. Contract creation costs 3,125 gas
per deployed byte on Somnia, and the hub's deploy used 75,383,438 gas for 22,395 bytes of runtime, about
3,366 per byte with its constructor.

```sh
cd e2e && npm run rpc-shim                     # terminal 1, leave it running

cd contracts                                   # terminal 2
export PRIVATE_KEY="$(grep '^HUB_OWNER_PK=' "$COPYBOOK_ENV" | cut -d= -f2)"
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8547 \
  --broadcast --skip-simulation --slow -g 150 --private-key "$PRIVATE_KEY"
unset PRIVATE_KEY
cd ../e2e && npm run record-deploy             # writes deployments/hideki.json from the broadcast
```

`Deploy.s.sol` deploys ThemeRegistry and CopybookHub (forge deploys and links the CopyEngine library)
and funds the hub. Optional env: `MARGIN_BANK`, `GROUP_SIZE` (8), `OWNER` (the broadcaster) and
`HUB_FUNDING` (40 STT). `record-deploy` takes the chain id, margin bank, group size and owner from the
broadcast itself; `CHAIN_ID` and `DEPLOYMENT_NAME` pick another broadcast or output file.

To verify on the Tokyo explorer (Blockscout-compatible; its `getabi` endpoint answers "Not available",
hence `--skip-is-verified-check`):

```sh
cd contracts
V="--verifier blockscout --verifier-url https://explorer.testnet.somnia.network/tokyo/api/ --skip-is-verified-check"
forge verify-contract <engine> src/CopyEngine.sol:CopyEngine $V
forge verify-contract <themes> src/ThemeRegistry.sol:ThemeRegistry $V \
  --constructor-args $(cast abi-encode "f(address)" <bank>)
forge verify-contract <hub> src/CopybookHub.sol:CopybookHub $V \
  --libraries src/CopyEngine.sol:CopyEngine:<engine> \
  --constructor-args $(cast abi-encode "f(address,address,uint32,address)" <bank> <themes> 8 <owner>)
# a group relay, once a follow has opened it (GroupOpened names it)
forge verify-contract <relay> src/GroupRelay.sol:GroupRelay $V \
  --constructor-args $(cast abi-encode "f(address,bytes32,uint32)" <hub> <sourceId> <group>)
```

## 3. Run

```sh
cd e2e
COPYBOOK_ENV=/path/to/keys.env npm run live                 # every scenario, in order
COPYBOOK_ENV=/path/to/keys.env npm run live theme floor     # only these (setup always runs first)
```

| scenario | what it checks |
|---|---|
| `setup` | reads the markets from the indexer, tops the wallets up |
| `approvals` | follower grants the hub `placeOrderFor` on BTC; follower2 grants it globally |
| `follow` | follower follows the leader on every market; a group relay and a hub-owned subscription open |
| `open`, `close` | the leader opens and closes 0.0005 BTC; the follower's copy lands in the leader's block |
| `sameblock` | three more leader trades (open, add, close), each copied in the same block |
| `residue` | the follower holds a residue below the venue minimum on the other side; the leader's next trade is copied with one order that crosses zero |
| `band` | on the thinnest market, a 5 bps band makes the increase unfillable: `Refused(BandUnfilled)` with the venue's error |
| `theme` | the owner creates "BTC vs ETH"; follower2 follows and both legs open in one tx; a rebalance resizes both legs in the rebalance's block |
| `floor` | an equity floor above equity: `poke` stops and flattens; lowering it lets the follower `resume` |
| `unsubscribe` | the last member leaves group 0: the hub cancels its subscription; `ensureSubscribed` leaves the empty group alone |
| `guaranteed` | an `isGuaranteed` subscription is accepted and copies in the same block |
| `gas` | sets the handler floor and `chargeOverhead` from the member gas measured above |
| `idle` | the same copies after the keys sit idle |
| `summary` | same-block ratio, handler origin, balances |

## Output

`e2e/out/proof.json` (gitignored) holds, per scenario, the transactions (hash, block, index, gas, explorer
link), the checks and the data read; `sameBlock` lists every trigger with the hub's handler transaction
and the block delta; `measurements` holds gas figures and venue behaviour. When the deployment changes,
the previous hub's proof is kept beside it as `out/proof-<hub>.json`.

`npm run typecheck` checks the TypeScript.

## After a fresh deploy

Before the first follow, the owner applies the gas parameters measured on Hideki (handler floor, charge overhead, risk-gate budget) with `setGasParams`, and the subscription parameters (fees, gas limits, guaranteed delivery) with `setSubParams`. The current deployment uses: `setGasParams` floor 12,000,000 · per-follower cap 20,000,000 · theme per-follower cap 90,000,000 · tail base 1,200,000 · per-deferral 30,000 · charge overhead 150,000 · risk-gate budget 2,000,000; `setSubParams` priority fee 0 · max fee 20 gwei · trader and theme gas limits 200,000,000 · guaranteed delivery on.

## Risk module (Shannon and Hideki)

The risk gate spans two chains: `RiskReviewer` on Shannon (50312) runs the validator committees, `RiskGate` on
Hideki (50383) holds the verdicts the hub consults. They talk over the Hyperlane lane between the two testnets.

**Deploy**, Shannon first. Both nodes need the shim, one per chain:

```sh
cd e2e && npm run rpc-shim 8547                                    # Hideki
cd e2e && HIDEKI_RPC=https://dream-rpc.somnia.network npm run rpc-shim 8548   # Shannon

cd contracts
export PRIVATE_KEY="$(grep '^HUB_OWNER_PK=' "$COPYBOOK_ENV" | cut -d= -f2)"
BASE_URL=https://<app>/api/risk/ forge script script/DeployRisk.s.sol --rpc-url http://127.0.0.1:8548 \
  --broadcast --skip-simulation --slow -g 150 --private-key "$PRIVATE_KEY"          # RiskReviewer
REVIEWER=<reviewer> forge script script/DeployRisk.s.sol --rpc-url http://127.0.0.1:8547 \
  --broadcast --skip-simulation --slow -g 150 --private-key "$PRIVATE_KEY"          # RiskGate + setReviewer
unset PRIVATE_KEY
```

**Verify**: Shannon's explorer is Blockscout, so the same verifier works there:

```sh
forge verify-contract <reviewer> src/risk/RiskReviewer.sol:RiskReviewer --verifier blockscout \
  --verifier-url https://shannon-explorer.somnia.network/api/ --chain-id 50312 --constructor-args \
  $(cast abi-encode "f(address,address,address,uint32,address,string)" <owner> <platform> <shannon mailbox> 50383 <gate> <base url>)
forge verify-contract <gate> src/risk/RiskGate.sol:RiskGate --verifier blockscout \
  --verifier-url https://explorer.testnet.somnia.network/tokyo/api/ --skip-is-verified-check --chain-id 50383 \
  --constructor-args $(cast abi-encode "f(address,address,uint32)" <owner> <hideki mailbox> 50312)
```

**Wire and run** with `COPYBOOK_ENV=/path/to/keys.env npm run risk <step>`:

| step | what it does |
|---|---|
| `bridge <stt>` | bridges STT from Hideki to the owner on Shannon (the SDK's Hyperlane STT route) and waits for the delivery |
| `record` | writes both deploy broadcasts into `deployments/risk.json` |
| `swap-reviewer [stt]` | moves the live gate to the reviewer in the latest Shannon broadcast (deploy it with `GATE=<gate>`): the old reviewer's balance goes back to the owner, the new one is funded (default: what the old one held), `gate.setReviewer`, and the field, prompt and base URL are checked |
| `wire` | `reviewer.setGate(gate)` on Shannon, then the hub's `setRiskGate(gate)` on Hideki, each only when not yet set |
| `fund <stt>` | sends STT to the reviewer; each review holds two committee deposits (0.36 STT at today's platform floor) |
| `refill [stt]` | the refill loop below: the gate's review fees back to the owner, a bridge only when needed, the reviewer topped up to `stt` (default 10) |
| `check` | both sides' settings, the reviewer's balance (≥ 10 STT), and `allowIncrease` against what the stored verdict and the follower's guard call for |
| `trade` | the leader opens and closes 0.0005 BTC; the increase passes the gate (one staticcall, traced) and the exit never asks it |
| `base-url <url>` | points the reviewer at the public risk endpoint |
| `prompt` | sets the reviewer's system prompt to the published rubric in `eval/rubric.ts` |
| `review [trader ...]` | pays for reviews and follows each one: the Hyperlane delivery to Shannon, both agent requests as sent (URL and field; user prompt, system message and allowed answers), both committee stages with every validator's answer, the reply, and the gate's verdict on Hideki |
| `follow <nonce> [shannon block]` | picks up a recorded review whose Hyperlane delivery outlasted the wait and follows it from chain to the gate's answer |
| `guard` | with a live `Block` on the leader: an unguarded increase copies, a guarded one is refused `RiskGate`, the exit copies; without one, only the guard switch |

Every transaction lands in `deployments/risk.json` with its explorer link (a deployment with its contract address);
balances carry the time they were read, and the first three live reviews are summarized under `runV1`. The gate-call
checks of `trade` and `guard` need `debug_traceTransaction`: without a trace they report UNVERIFIED, and the step ends
UNVERIFIED (exit code 2), never PASS.

**Held BLOCKs and the e2e follower.** A BLOCK on a trader refuses new size to every guarded follower of that trader;
exits still copy. The gate keeps a BLOCK against a milder verdict for `BLOCK_HOLD` (24 h) after it landed, and a BLOCK
that is not replaced stops blocking after `VERDICT_TTL` (7 d). While the leader holds a BLOCK, the guarded test
follower's increases are refused, so before `npm run live` scenarios that expect increases to copy, either opt the
follower out (`setGuard(false)` from the follower, as the `guard` step does) or re-review the leader once its hold has
passed (`npm run risk review <leader>`).

**The asymmetry of the hold.** A new BLOCK may replace a stored BLOCK at any time, while a milder verdict must wait out
the 24 h hold. Re-rolling a trader into BLOCK is therefore cheaper than getting out of one. What limits this is that
reviews cost a fee (0.5 STT) and a 10-minute cooldown, and that on the rubric line the committees answered unanimously
in every review of the scorecard's runs, so asking again for the same line returns the same answer.

**Refilling the reviewer.** Agent deposits are paid on Shannon from the reviewer's balance: 0.36 STT is held per review
up front (0.12 + 0.24 at today's platform floor) and about 0.215 STT is spent once the platform returns the unused part.
The review fees (0.5 STT each) accrue in the gate on Hideki. `npm run risk refill [stt]` closes the loop:
`gate.withdraw` to the owner on Hideki, a bridge Hideki → Shannon (as in `bridge`) only when topping up would leave the
owner under 2 STT on Shannon, and a transfer that brings the reviewer to `stt`. A reviewer holding less than one
review's deposits answers every review with no verdict (`Unfunded`), which changes no stored verdict.

**Evaluate** the committee against the rubric (results in [`eval/SCORECARD.md`](../eval/SCORECARD.md)):
`npm run eval:test` runs the rubric's tests, `npm run eval select` picks the sample and writes the answer key
(commit it before any review), `npm run risk review <trader>` runs each review, and `npm run eval score` scores them.
A later run re-registers the same sample: `npm run eval key v3` writes `eval/v3/answer-key.json`, commit it,
`npm run eval anchor v3 <commit>` writes the commit and key hash on Hideki, then the reviews, then `npm run eval score v3`.

## Proof ledger

`npm run proof` re-reads every transaction the docs cite from Hideki and Shannon and writes
[`docs/PROOF.md`](../docs/PROOF.md); it also checks that every link and test [`docs/CLAIMS.md`](../docs/CLAIMS.md) cites
exists. It only reads (public RPCs, no key, no `contracts/out`), so it runs right after `npm ci` here. The recorded runs'
transactions are in `proof/sources.json`; it also checks everything in `deployments/*.json` and `eval/*/anchor.json`
and every explorer link in the docs. Exit code 0 when all verify, 1 when any fails, 2 when the RPC kept failing.
`npm test` runs the ledger's own tests (`COPYBOOK_LIVE=1` adds one against the live RPC). PROOF.md is written only when everything verifies; `npm run proof -- --write-anyway` writes it with the failures marked.

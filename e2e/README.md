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
cd ../e2e && npm ci
```

## 2. Deploy

`forge script` cannot talk to a Hideki node directly:

- the node keeps no historical state, so a state read pinned to a block number fails ("unable to load
  historical state");
- it rejects EIP-1898 block objects (`{"blockNumber": ...}`) with `-32602`;
- it answers `eth_getStorageAt` on an empty slot with `"0x"` instead of a 32-byte zero word.

`npm run rpc-shim` starts a local JSON-RPC proxy on `127.0.0.1:8547` that sends every state read to
`latest` and pads empty storage words. It is for broadcasting from your own machine only.

Forge's local gas estimate is also about 10x below what Somnia charges (contract creation costs about
4,900 gas per deployed byte there), so the script runs with `--skip-simulation`: each transaction is
estimated by the node itself.

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

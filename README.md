# Copybook

Follow a trader or a thesis on dreamDEX perps. When the source moves, the Copybook hub places your copy in your own
dreamDEX perps account, in the same block.

- **Same block, no server or bot key.** Somnia's validators run the hub's reactive handler in the block of the
  source's move, and the hub itself sends the copy ([23 of 23 recorded pairs](docs/PROOF.md#same-block-copies)).
- **A refusal is an on-chain record.** An increase your policy refuses is written as `Refused(reason)` in the move's
  block, and your position stays where it was ([a band refusal](docs/PROOF.md#refusal-band)).
- **A validator-run AI guard.** A committee of Somnia validators on Shannon reviews a trader's 30-day record, and the
  verdict crosses to Hideki over Hyperlane ([one review, end to end](docs/PROOF.md#one-review-end-to-end-review-11)).

Each copy is a page and a 1200×630 share card that carries its block proof, made to be posted. Traders gain followers
and climb a leaderboard ranked by followers and copy fidelity, thesis creators publish baskets for others to follow,
and agents follow through the MCP server ([claims map](docs/CLAIMS.md#the-app)). There are no outside users yet: every
wallet that follows, leads or creates a thesis in the recorded runs is one of ours (`demoWallets` in
[`deployments/hideki.json`](deployments/hideki.json)).

Copybook runs on [dreamDEX](https://app.testnet.dreamdex.io/) perps on Hideki (Somnia's Tokyo testnet, chain 50383),
where STT and USDso have no market value. A wallet follows one source: a trader's account, or a thesis (a weighted
basket of perps, long and short, that its creator rebalances).

| | |
| --- | --- |
| App | https://copybook-eosin.vercel.app |
| Demo video | https://youtu.be/HpLdCtyvta0 (2:22) |
| For judges | [JUDGES.md](JUDGES.md): a five-minute path |
| Proof ledger | [docs/PROOF.md](docs/PROOF.md): 360 transactions read back from the chain, 360 verified (Hideki block 36,407,680, 2026-10-29) |
| Claims and their evidence | [docs/CLAIMS.md](docs/CLAIMS.md) |
| Contracts | `CopybookHub` [0xdF73…E154](https://explorer.testnet.somnia.network/tokyo/address/0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154) and `RiskGate` [0xEe54…20f1](https://explorer.testnet.somnia.network/tokyo/address/0xEe54c49E9e70a0e5C2218Eec1b1BDBd4e1Cb20f1) on Hideki, `RiskReviewer` [0xc999…7c25](https://shannon-explorer.somnia.network/address/0xc999B6924179a0dc9649DA7eBa8F3aC8b7CF7c25) on Shannon; all addresses in [`deployments/`](deployments/) |
| How it is built | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| What it does not do | [docs/LIMITS.md](docs/LIMITS.md) |
| Feedback on the dreamDEX stack | [`feedback/`](feedback/), also filed at https://github.com/RaYYeR220/copybook-feedback |

## Who it is for

- **Followers.** Pick a trader or a thesis, set your scale, caps, price band and equity floor once, and your book
  follows theirs. Exits are never gated: no cap, tank, pause or AI verdict holds back a close
  ([an exit under a BLOCK](docs/PROOF.md#guard-exit)). Increases copy only inside your limits.
- **Traders.** Any dreamDEX account can be followed, and the trader signs nothing
  ([claims map](docs/CLAIMS.md#same-block-copying)). The leaderboard ranks sources by followers and by the share of
  their increases that were copied ([claims map](docs/CLAIMS.md#the-app)).
- **Thesis creators.** Publish a basket ("long BTC, short ETH") from the thesis builder
  ([thesis 2](docs/PROOF.md#thesis2-create)) and rebalance it; each follower's book is resized in the rebalance's own
  block ([thesis 1](docs/PROOF.md#thesis1-rebalance)).
- **Agents.** An MCP server lets an AI agent find sources and follow them with its own wallet. Every write is a dry run
  until the agent sends it again with `dryRun: false` ([an agent's session](docs/PROOF.md#mcp-agent)).

## How it works, in a minute

1. **Approve once.** The follower lets the hub place orders for it on dreamDEX: a grant of one function,
   `placeOrderFor`, on dreamDEX's operator registry ([on chain](docs/PROOF.md#app-approve)). The hub can open and close
   perps in that account. The grant names no other function, and dreamDEX's operator model gives an operator no way to
   withdraw.
2. **Follow.** One transaction stores the policy, funds a gas tank in STT and seats the follower in a group of that
   source's followers: up to 8 per group for a trader, 2 for a thesis (`groupSize` and `themeGroupSize` on the hub).
   The first follower of a group opens its relay contract and a Reactivity subscription to the source
   ([on chain](docs/PROOF.md#e2e-follow)).
3. **The source moves.** dreamDEX's margin bank emits `PositionUpdated` for the trader, or the thesis registry emits a
   rebalance. Somnia's validators call the group's relay in the same block, and the hub reads the source's position
   and resizes each follower: exits first, never gated, then increases as fill-or-kill orders inside the follower's
   price band, after every policy check. Each follower's gas is charged to its own tank. 23 of 23 recorded pairs have
   the copy in the move's block, sent by the hub ([pairs](docs/PROOF.md#same-block-copies)). A follower the handler's
   gas cannot cover in that block is deferred and synced later by `catchUp`, which is not a same-block copy and is
   never labelled one ([limits](docs/LIMITS.md)).
4. **A refusal is a record.** An increase the policy refuses is written on chain as `Refused(reason)` in the move's
   block, and the follower's position stays where it was. Recorded live: `Refused(BandUnfilled)`
   ([row](docs/PROOF.md#refusal-band)) and `Refused(RiskGate)` ([row](docs/PROOF.md#guard-blocked)). The equity floor
   was recorded as a stop, a `Stopped` from `poke` that closed the copy, not as a refusal
   ([row](docs/PROOF.md#floor-poke)). The other reasons (TotalCap, EquityFloor, TankEmpty, BelowMinimum, AtCap,
   MarketNotAllowed, VenueRejected, LegFailed, Paused) are shown by contract tests, listed in
   [CLAIMS](docs/CLAIMS.md#exits-policy-and-refusals).
5. **An optional AI guard,** for trader follows. Anyone can pay for a review of a trader (0.5 STT). A committee of
   Somnia validators on Shannon fetches the trader's 30-day statistics from Copybook's public endpoint, another
   classifies them OK, CAUTION or BLOCK under a published rubric, and the verdict crosses to a gate on Hideki over
   Hyperlane ([one review, end to end](docs/PROOF.md#one-review-end-to-end-review-11)).
   Under a BLOCK, guarded followers are refused new size; exits stay ungated
   ([refused](docs/PROOF.md#guard-blocked), [exit copied](docs/PROOF.md#guard-exit)). The guard is on by default and
   each follower can turn it off ([on chain](docs/PROOF.md#app-guard-off)). How well the committee applies the rubric, including
   on traders it had never seen: [scorecard](eval/SCORECARD.md#run-v4-result).

A whole-book trader follow copies nothing in its own transaction: positions the trader already holds open through
`catchUp` on the dashboard or at the trader's next move in each market ([limits](docs/LIMITS.md#copying)).

## Categories and Somnia primitives

Categories: **bots & agents** (the hub is an on-chain bot on your own account, and an MCP server drives it for AI
agents) · **trader tools** (preflight checks at live marks, a dashboard that names every stuck state with the call
that clears it, an AI risk guard) · **consumer perps** (follow a person or an idea in a few clicks, share a copy as a
card).

| Primitive | What Copybook uses it for | Shown in |
| --- | --- | --- |
| Somnia Reactivity | On-chain subscriptions to dreamDEX's `PositionUpdated` and to thesis rebalances; validators run the handler in the event's block | [same-block pairs](docs/PROOF.md#same-block-copies) |
| Somnia Agents | Two validator committees on Shannon: a JSON-API agent fetches the trader's risk line from our public endpoint, an LLM agent classifies it | [data committee](docs/PROOF.md#example-review-11-summary), [verdict committee](docs/PROOF.md#example-review-11-verdict) |
| Hyperlane, Shannon ↔ Hideki | The review request to Shannon and the verdict back to the gate on Hideki | [to Shannon](docs/PROOF.md#example-review-11-toShannon), [to Hideki](docs/PROOF.md#example-review-11-toHideki) |

## Try it in 5 minutes

**Without a wallet.** Recorded copies open in the app, for example
[a same-block copy](https://copybook-eosin.vercel.app/copy/0xd012c9ad808025ba8ff880bde67e6972b661b3824e839754bb8681cc1b878cbc)
or [a thesis rebalance](https://copybook-eosin.vercel.app/copy/0xd457cf3abe3c3ecf50aa76bb478143aaed88ea3460111a71b80c019692c1c114).
The [proof ledger](docs/PROOF.md) lists every recorded transaction, and the demo video is linked at the top of this
page.

**With a wallet.** You need an injected browser wallet (MetaMask, Rabby) on Hideki with about 1 STT (a follow keeps
at least 0.2 STT in its gas tank) and a few USDso. There is no verified self-serve route to USDso for an injected
wallet right now: dreamDEX's one-time perps voucher claim reverts for every account
([feedback/01](feedback/01-voucher-self-claim-disabled.md), also filed at
https://github.com/RaYYeR220/copybook-feedback). Message [@BazydloMis57623](https://x.com/BazydloMis57623) on X with
your Hideki address and we send STT and USDso. Use a dedicated wallet: a follow manages every market its source
trades in that wallet.

1. Open https://copybook-eosin.vercel.app/app and connect. The app offers to add Hideki to the wallet.
2. Pick a source:
   - **A thesis.** Open [thesis 2](https://copybook-eosin.vercel.app/thesis/2) and follow it with at least the
     allocation the page shows. Both legs open in your follow transaction.
   - **The demo leader.** Open [its page](https://copybook-eosin.vercel.app/t/0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d)
     (marked ours) and follow it. During judging (until 2026-11-21) it trades a small BTC or ETH position about every 25
     minutes, and each move is copied in its block. Check the verdict on its page first: if it is BLOCK, turn the
     guard off in the follow flow to see copies (exits are never gated either way).
   - **Any trader on Discover.** Scale and cap the copy to your margin.
3. The follow flow walks through the margin, the operator approval, the policy, the guard and the tank, and reads
   each step back from the chain. If your USDso sits in the wallet rather than its perps account, the margin step's
   deposit action moves USDso from spot into your perps account.
4. Watch `/me`: your book against the source's, and each copy and refusal as it lands. A copy links to its own page,
   which names the move and the copy's positions in the block. When you are done, unfollow with flatten, withdraw the
   tank and revoke the approval from the same page ([as recorded](docs/PROOF.md#in-the-app)).

## Run it locally

Requirements: Node 24 and npm (the MCP server needs Node 22.18 or newer); Foundry for the contracts.

```sh
git clone https://github.com/RaYYeR220/copybook.git
cd copybook
npm ci                                 # the app and packages/* are npm workspaces
npm run dev -w @copybook/app           # http://localhost:3000; no environment needed
```

The app reads Hideki's public RPC, dreamDEX's public indexer and the addresses in `deployments/`. Tests and a
production build:

```sh
npm test -w @copybook/sdk
npm test -w @copybook/stats
npm test -w @copybook/mcp
npm test -w @copybook/app
npm run build -w @copybook/app

cd contracts && npm ci && forge test && cd ..
cd e2e && npm ci && npm test && npm run eval:test && cd ..
```

Every suite passed in a run on 2026-10-29: `forge test` 257 tests, app 377, SDK 96 (plus 5 live ones, skipped
without `COPYBOOK_LIVE=1`), MCP 56, stats 35, the e2e tests 41 (the proof ledger, the eval tooling and the demo-leader bot, `npm test` in `e2e/`) and the rubric 8
(`npm run eval:test`).

`npm run start -w @copybook/app` serves the production build on port 3000. `cd e2e && npm run proof` re-reads every
cited transaction from the chain and rewrites `docs/PROOF.md` when all of them verify (read-only, public RPCs, no
key). Deploying and the live end-to-end run need funded keys: [`e2e/README.md`](e2e/README.md).

## X posts

Posts about Copybook, tagging [@DreamDEXSomnia](https://x.com/DreamDEXSomnia):

- [Launch: follow a trader or a thesis, and your copy lands in the same block as their trade](https://x.com/BazydloMis57623/status/2115937201766715680)
- [How the copy path works: one Reactivity subscription, a handler in the trader's block, a one-function grant](https://x.com/BazydloMis57623/status/2116076543461961916)
<!-- X3 -->

## What is in this repo

| Path | What it is |
| --- | --- |
| `contracts/` | `CopybookHub` (follows, groups, the reactive handler), the `CopyEngine` library, `GroupRelay`, `ThemeRegistry` (theses), `RiskGate` and `RiskReviewer` (the AI guard). Foundry. |
| `app/` | The web app: landing, Discover, trader and thesis pages, the follow flow, the dashboard, the thesis builder, share cards and the leaderboard. Next.js 15. |
| `packages/sdk` | `@copybook/sdk`: typed reads, writes, preflight checks, event history and a live watch. The app and the MCP server go on chain through it. |
| `packages/mcp` | `@copybook/mcp`: an MCP server that lets an AI agent discover sources and follow them with its own wallet. |
| `packages/stats` | `@copybook/stats`: trader statistics from the dreamDEX indexer, for Discover and for the risk review. |
| `e2e/` | The live end-to-end run on Hideki, the risk-module tooling and the proof ledger. |
| `eval/` | The AI guard's rubric, its tests and the committee's [scorecard](eval/SCORECARD.md). |
| `deployments/` | Deployed addresses, and every wallet Copybook runs (`demoWallets`, with its role). The app, the SDK and the MCP server read addresses from here only; our wallets are marked ours and never ranked. |
| `feedback/` | Reproducible reports on the dreamDEX perps stack, one file per issue. |
| `docs/` | The proof ledger, the claims map, the architecture and the limits. |

## App

The app reads what it shows from the chain or the dreamDEX indexer and sends every transaction from the visitor's own
wallet. It has no accounts and no database.

| Route | What it shows |
| --- | --- |
| `/` | The landing. |
| `/app` | Discover: top dreamDEX traders by 30-day realized PnL, the theses with their minimums, and the live tape of every copy and refusal. |
| `/t/<address>` | A trader: 30-day record, open positions, the AI guard's verdict (and a paid request for a fresh one), Copybook activity. |
| `/thesis/<id>` | A thesis: legs, version, the least allocation that opens every leg at today's marks; its creator's rebalance panel. |
| `/thesis/new` | The thesis builder, checked against the registry's rules as you type. |
| `/follow/trader/<address>`, `/follow/thesis/<id>` | The follow flow: margin, operator approval, policy, AI guard, gas tank, follow. Each step is read back from the chain, so a reload resumes where you were. |
| `/me` | The dashboard: your book against the source's, the live copy feed, refusals by reason, the tank, the guard, and every stuck state with the call that clears it. |
| `/leaderboard` | Sources by followers and by copy fidelity. |
| `/copy/<tx>` | One copy, with its same-block proof and a share card. |
| `/og/...` | Share cards (1200×630) for traders, theses and copies. |
| `/api/history`, `/api/traders`, `/api/positions/<account>`, `/api/risk/<trader>` | The hub's event log, the trader ranking, an account's open positions, and the risk line the validators read. |

Wallets: any injected browser wallet on Hideki (MetaMask, Rabby, or any EIP-6963 wallet).

```sh
npm test -w @copybook/app
npm run typecheck -w @copybook/app
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Vercel's production URL (a preview's own URL on previews), else `http://localhost:3000` | Absolute base for share-card and metadata URLs. |
| `WARM_URL` | unset | Base URL for `npm run warm` when none is passed. |

Deploying on Vercel: create a project with **Root Directory** `app`; the build reaches `packages/` and `deployments/`
from there. `/api/history` and `/api/traders` declare `maxDuration = 300` (a cold read of the hub's log since deployment
takes up to a minute), and `app/vercel.json` schedules a daily cron on both. After each deploy, read the log to the end
once so the first visitors hit warm caches:

```sh
npm run warm -w @copybook/app -- https://<deployment>
```

## SDK

`@copybook/sdk` is a typed client for `CopybookHub`, `ThemeRegistry` and `RiskGate` on viem: the reads, the writes,
`preflightFollow` (everything the hub would refuse, checked at live marks before anything is signed, each reason with
the least value that clears it), `status` (every stuck state with the exact call that clears it), the event history
and a reconnecting live watch.

```ts
import { createCopybook, deploymentsFromJson } from "@copybook/sdk";
import hideki from "./deployments/hideki.json";
import risk from "./deployments/risk.json";

const copybook = createCopybook({ publicClient, walletClient, deployments: deploymentsFromJson(hideki, risk) });
const check = await copybook.preflightFollow({ account, kind: "Theme", source: 1n, policy, tank, walletChainId: 50383 });
if (check.ok) await (await copybook.follow({ target: { kind: "Theme", themeId: 1n }, policy, tank })).wait();
```

A browser wallet or a local key both work as the `walletClient`. The package ships TypeScript source (Next.js needs
`transpilePackages: ["@copybook/sdk"]`). More in [`packages/sdk/README.md`](packages/sdk/README.md);
`COPYBOOK_LIVE=1 npm test -w @copybook/sdk` adds a read-only pass over the live contracts.

## MCP server

`@copybook/mcp` is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server. Without a key it offers
read tools (top traders, trader stats, verdicts, theses, a wallet's follow and its copy history). With
`COPYBOOK_AGENT_KEY` set to the agent's own testnet key it adds write tools: follow a trader or a thesis, unfollow,
withdraw the gas tank, revoke the operator approval, request a review, publish a thesis. Every write is a dry run
unless called with `dryRun: false`, and every follow runs the SDK's preflight first. A recorded agent session is in
[PROOF.md](docs/PROOF.md#mcp-agent).

```sh
node packages/mcp/bin/copybook-mcp.mjs      # no build step: Node runs the TypeScript sources
```

```json
{
  "mcpServers": {
    "copybook": {
      "command": "node",
      "args": ["/absolute/path/to/copybook/packages/mcp/bin/copybook-mcp.mjs"],
      "env": { "COPYBOOK_AGENT_KEY": "0x...a dedicated testnet key (omit for read-only)..." }
    }
  }
}
```

Variables, every tool and the safety model: [`packages/mcp/README.md`](packages/mcp/README.md).

## Contracts and the live run

`cd contracts && npm ci && forge build && forge test` builds and tests the contracts. Deploying, verifying, wiring the
risk module and the live end-to-end run on Hideki are in [`e2e/README.md`](e2e/README.md).

## License

MIT

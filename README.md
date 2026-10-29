# Copybook

Follow a trader or a thesis on dreamDEX perps. The chain keeps your book in sync — every leg, in the same block.

Copybook is on-chain copy-trading for [dreamDEX](https://app.testnet.dreamdex.io/) perps on Somnia's Hideki testnet
(chain 50383). A wallet follows one source: a trader's account, or a thesis (a weighted basket of perps, long and short,
that its creator rebalances). When the source moves, Somnia's validators run the Copybook hub's reactive handler inside
the same block, and the hub places the copy in the follower's own dreamDEX account. Exits are always copied; increases
pass the follower's price band, caps, equity floor and gas tank, and for trader follows an optional AI guard: a verdict
on the trader's 30-day record that a committee of validators on Somnia Shannon writes to a gate on Hideki.

Testnet only: STT and USDso have no market value.

| Live | |
| --- | --- |
| App | https://copybook-eosin.vercel.app |
| Risk endpoint the validators read | `https://copybook-eosin.vercel.app/api/risk/<trader>` |
| Contracts | `deployments/hideki.json`, `deployments/risk.json` (explorer links inside) |

## What is in this repo

| Path | What it is |
| --- | --- |
| `contracts/` | `CopybookHub` (follows, groups, the reactive handler), the `CopyEngine` library, `ThemeRegistry` (theses), `RiskGate` / `RiskReviewer` (the AI guard). Foundry. |
| `app/` | The web app: landing, Discover, trader and thesis pages, the follow flow, the follower dashboard, the thesis builder, share cards and the leaderboard. Next.js 15. |
| `packages/sdk` | `@copybook/sdk`: typed reads, writes, preflight checks, event history and a live watch over the contracts. Everything the app and the MCP server do on chain goes through it. |
| `packages/mcp` | `@copybook/mcp`: an MCP server that lets an AI agent discover sources and, with its own wallet, follow them. |
| `packages/stats` | `@copybook/stats`: trader statistics from the dreamDEX indexer, for Discover and for the risk review. |
| `e2e/` | The live end-to-end run on Hideki and the risk-module tooling. See [`e2e/README.md`](e2e/README.md). |
| `eval/` | The AI guard's rubric, its tests and the committee's scorecard ([`eval/SCORECARD.md`](eval/SCORECARD.md)). |
| `deployments/` | The deployed addresses. The app, the SDK and the MCP server read addresses from here and nowhere else. |

Requirements: Node 24 (22.18 or newer for the MCP server) and npm. Foundry only for the contracts.

```sh
npm install        # once, at the repo root: app and packages are npm workspaces
```

## App

The app reads everything it shows from the chain or the dreamDEX indexer, and sends every transaction from the
visitor's own wallet. There is no account and no backend database.

| Route | What it shows |
| --- | --- |
| `/` | The landing. |
| `/app` | Discover: top dreamDEX traders by 30-day realized PnL, the theses on chain with their minimums, and the live tape of every copy and refusal. |
| `/t/<address>` | A trader: 30-day record, open positions, the AI guard's verdict (and a paid request for a fresh one), Copybook activity. |
| `/thesis/<id>` | A thesis: legs, version, the least allocation that opens every leg at today's marks; its creator's rebalance panel. |
| `/thesis/new` | The thesis builder, checked against the registry's rules as you type. |
| `/follow/trader/<address>`, `/follow/thesis/<id>` | The follow flow: operator approval, policy, AI guard, gas tank, follow. Every step is read back from the chain, so it resumes after a reload. |
| `/me` | The follower's dashboard: the book against the source's, the live copy feed, refusals by reason, the tank, the guard, and every stuck state with the call that clears it. |
| `/leaderboard` | Sources by followers and by copy fidelity. |
| `/copy/<tx>` | One copy, with its same-block proof and a share card. |
| `/og/...` | Share cards (1200×630) for traders, theses and copies. |
| `/api/history`, `/api/traders`, `/api/positions/<account>`, `/api/risk/<trader>` | The hub's event log, the trader ranking, an account's open positions, and the risk rubric the validators read. |

Wallets: any injected browser wallet (MetaMask, Rabby, or any EIP-6963 wallet) on Hideki. The app offers to add the network.
Follow from a dedicated wallet: a follow mirrors the source's whole book into it, positions already open included.

Run it locally:

```sh
npm run dev -w @copybook/app          # http://localhost:3000
npm test -w @copybook/app             # unit tests
npm run typecheck -w @copybook/app
npm run build -w @copybook/app && npm run start -w @copybook/app
```

Environment: none is required. The RPC and explorer are Hideki's public ones, the indexer is dreamDEX's, and the contracts
come from `deployments/`.

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

`@copybook/sdk` is a typed client for `CopybookHub`, `ThemeRegistry` and `RiskGate` on viem. It covers the reads (a
follow, its tank, synced markets, a thesis and its minimum, a verdict), the writes (approve, follow, unfollow, policy,
tank, catchUp, poke, resume, resync, guard, review, create and rebalance a thesis), `preflightFollow` (everything the
hub would refuse, checked at live marks before anything is signed, each reason with the least value that clears it),
`status` (every stuck state with the exact call that clears it), the event history and a reconnecting live watch.

```ts
import { createCopybook, deploymentsFromJson } from "@copybook/sdk";
import hideki from "./deployments/hideki.json";
import risk from "./deployments/risk.json";

const copybook = createCopybook({ publicClient, walletClient, deployments: deploymentsFromJson(hideki, risk) });
const check = await copybook.preflightFollow({ account, kind: "Theme", source: 1n, policy, tank, walletChainId: 50383 });
if (check.ok) await (await copybook.follow({ target: { kind: "Theme", themeId: 1n }, policy, tank })).wait();
```

A browser wallet or a local key both work as the `walletClient`. The package ships TypeScript source (Next.js needs
`transpilePackages: ["@copybook/sdk"]`). Usage, notes and tests: [`packages/sdk/README.md`](packages/sdk/README.md).

```sh
npm test -w @copybook/sdk                   # unit tests against a scripted chain
COPYBOOK_LIVE=1 npm test -w @copybook/sdk   # adds a read-only pass over the live contracts
```

## MCP server

`@copybook/mcp` is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server. Without a key it offers
read tools (top traders, trader stats, verdicts, theses, a wallet's follow and its copy history). With
`COPYBOOK_AGENT_KEY` set to the agent's own testnet key it adds write tools: follow a trader or a thesis, unfollow,
withdraw the gas tank, revoke the operator approval, request a review, publish a thesis. Every write is a dry run
unless called with `dryRun: false`, and every follow runs the SDK's preflight first.

```sh
node packages/mcp/bin/copybook-mcp.mjs      # no build step: Node runs the TypeScript sources
npm test -w @copybook/mcp
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

| Variable | Default | Meaning |
| --- | --- | --- |
| `COPYBOOK_AGENT_KEY` | unset | The agent's own wallet key. Without it only read tools exist. |
| `COPYBOOK_RPC_URL` | Hideki's public RPC | JSON-RPC endpoint. |
| `COPYBOOK_DEPLOYMENTS_DIR` | `deployments/` of this repo | Where `hideki.json` and `risk.json` live. |
| `COPYBOOK_INDEXER_URL` | dreamDEX's public indexer | Endpoint for trader stats. |

Every tool, the safety model and what a follow does and does not do: [`packages/mcp/README.md`](packages/mcp/README.md).

## Contracts and the live run

`cd contracts && forge build && forge test` builds and tests the contracts. Deploying, verifying, wiring the risk
module and the live end-to-end run on Hideki (every transaction and the hub's same-block reaction recorded) are in
[`e2e/README.md`](e2e/README.md).

## License

MIT

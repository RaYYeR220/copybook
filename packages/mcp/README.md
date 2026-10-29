# @copybook/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that lets an AI agent discover traders and theses on Copybook and, with its own wallet, follow them. It is a thin layer over `@copybook/sdk` (the contracts) and `@copybook/stats` (the dreamDEX indexer).

Copybook is on-chain copy-trading for dreamDEX perps on Somnia. This server talks to the **Hideki2 testnet** (chain 50383): the tokens have no market value.

## Install and run

Not published to npm: run it from a clone of this repo. Requires Node 22.18 or newer (24 recommended), which runs TypeScript directly.

```
npm install            # from the repo root; the package is a workspace
npm test -w @copybook/mcp
node packages/mcp/bin/copybook-mcp.mjs
```

There is no build step: Node runs the TypeScript sources directly. `npm run typecheck -w @copybook/mcp` checks types.

## Configure a client

Any MCP client that can start a stdio server works. Claude Desktop (`claude_desktop_config.json`), Cursor, Cline and others take the same shape:

```json
{
  "mcpServers": {
    "copybook": {
      "command": "node",
      "args": ["/absolute/path/to/copybook/packages/mcp/bin/copybook-mcp.mjs"],
      "env": {
        "COPYBOOK_AGENT_KEY": "0x...the agent's own testnet key (omit for read-only)..."
      }
    }
  }
}
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `COPYBOOK_AGENT_KEY` | unset | The agent's own wallet private key. Without it only read tools exist. |
| `COPYBOOK_RPC_URL` | Hideki2 public RPC | JSON-RPC endpoint. |
| `COPYBOOK_DEPLOYMENTS_DIR` | `deployments/` of this repo | Where `hideki.json` and `risk.json` live. Addresses are read from there only. |
| `COPYBOOK_INDEXER_URL` | dreamDEX public indexer | Hasura endpoint used for trader stats. |

## Tools

Read (always on):

| Tool | What it does |
| --- | --- |
| `list_top_traders {n?, windowDays?}` | Real traders ranked by realized PnL with the app's filters, with stats and the reviewer's summary line; Copybook's own wallets and wallets that follow through the hub now are left out. Slow (sequential indexer reads). |
| `get_trader_stats {trader, windowDays?}` | Trades, active days, realized PnL, liquidations, drawdown, leverage; unknowns are null. |
| `get_verdict {trader}` | RiskGate tier (None / Ok / Caution / Block), review time, whether a Block hold is active, pending review, review fee. |
| `list_theses {}` | Every thesis with legs and version. |
| `get_thesis {id}` | One thesis plus the least allocation that opens every leg at today's marks (and a figure with headroom). |
| `get_follow {follower?}` | The follow, tank, AI guard, thesis drift, and every stuck state with the exact call that clears it. |
| `get_copy_history {follower?, fromBlock?, limit?}` | Followed / Copied / Refused / Stopped events for a wallet. Without `fromBlock` it reads the last 50000 blocks only (about two hours) and says so. |

Write (registered only when `COPYBOOK_AGENT_KEY` is set; all dry-run by default):

| Tool | What it does |
| --- | --- |
| `follow_trader {trader, scaleBps?, maxNotionalUsdso, maxTotalNotionalUsdso?, bandBps?, equityFloorUsdso?, markets?, tankStt, dryRun?}` | Mirror a trader into the agent's wallet. Without `markets`, the caps are also checked in the markets the trader holds now. |
| `follow_thesis {themeId, allocationUsdso, maxNotionalUsdso, ..., tankStt, dryRun?}` | Open a thesis basket in one block. |
| `unfollow {flatten, dryRun?}` | Stop; `flatten` also closes positions. The tank stays on the hub until `withdraw_tank`. |
| `withdraw_tank {amountStt?, dryRun?}` | Take STT out of the gas tank: by default all of it once unfollowed, or what is above the 0.2 STT floor while following. |
| `revoke_operator {dryRun?}` | Withdraw the hub's operator approval (refused while the wallet follows something). |
| `request_review {trader, dryRun?}` | Pay the fee for a fresh RiskGate review. |
| `create_thesis {name, legs, uri?, dryRun?}` | Publish a new basket. |

Money is always a decimal string: `...Usdso` fields are USDso, `...Stt` fields are STT.

## Safety model

- **Own key, own wallet.** The key is the agent's own, read once from the environment, used only to sign, and never logged or returned. Do not give an agent a key that holds anything you care about; fund a dedicated testnet wallet.
- **Dry-run by default.** Every write tool returns the preflight and the exact calls (target, function, arguments, value, calldata) and sends nothing until called again with `dryRun: false`.
- **Preflight always runs, and refuses.** Before any follow the SDK's `preflightFollow` checks the policy, tank, balance, market minimums, one-source-per-wallet and the trader's verdict at live marks. On any error the call is refused with each reason and the least value that clears it, even with `dryRun: false`.
- **Operator approval (read this).** Following needs a one-time `setOperatorApprovalGlobal(hub, [placeOrderFor], true)` on dreamDEX's operator registry. The grant is **global**: it covers every perps market for the wallet, not just one follow or trader, and it **persists after unfollow** until you call `revoke_operator`. While it stands, the grant lets the Copybook hub place orders for this wallet's perps account (opening, increasing, reducing or closing positions); it cannot withdraw or move funds, and it cannot cancel orders. It is the first transaction of a live follow, skipped when already granted, and a re-run after a partial failure resumes at the first undone step.
- **Failures after a send are reported, not hidden.** If anything fails once a transaction has gone out (timeout, RPC error, revert), the answer lists every hash already sent and how to resume.
- **No secrets in output.** Errors returned to the agent and lines logged to stderr have configured endpoint URLs and key-shaped strings scrubbed; unexpected errors are reduced to a generic message.
- **No hidden caps.** There is no default per-position cap: the agent must choose `maxNotionalUsdso`. A zero cap is rejected.

What a follow means, so an agent does not assume more:

- One source per wallet: unfollow before following anything else, or use a dedicated wallet per source.
- A trader follow with no `markets` list mirrors the whole book, including positions already open.
- Exits are always copied. Increases are gated by the price band, per-position and whole-book caps, the equity floor, the gas tank and, for trader follows only, the AI guard (a Block verdict stops new size from that trader).
- A thesis basket opens all legs or none; between thesis versions the book can drift until resync.
- `Copied.limitPrice` is the limit price of the order that moved the position, not the fill.
- Testnet only.

## Tests

`npm test -w @copybook/mcp` runs the tools against mocked SDK and stats clients: each read tool, write tools refusing without a key, dry-run sending nothing, and preflight refusals surfacing their reasons.

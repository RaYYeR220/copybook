# Copybook: a path for judges

Five minutes, in the order of the judging criteria. Everything runs on Somnia testnets: Hideki (Somnia's Tokyo
testnet, chain 50383) and Shannon (chain 50312). There are no outside users yet: every wallet that follows, leads or
creates a thesis in the evidence is ours (`demoWallets` in [`deployments/hideki.json`](deployments/hideki.json)).
What Copybook does not do: [docs/LIMITS.md](docs/LIMITS.md).

## If you have one minute

1. Open one recorded copy:
   [copybook-eosin.vercel.app/copy/0xd012…8cbc](https://copybook-eosin.vercel.app/copy/0xd012c9ad808025ba8ff880bde67e6972b661b3824e839754bb8681cc1b878cbc).
   The demo leader opens 0.0005 BTC at position 0 of Hideki block 35,025,602; the hub's copy into the follower's
   account is position 22 of the same block. On the explorer:
   [the move](https://explorer.testnet.somnia.network/tokyo/tx/0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d),
   [the copy](https://explorer.testnet.somnia.network/tokyo/tx/0xd012c9ad808025ba8ff880bde67e6972b661b3824e839754bb8681cc1b878cbc).
2. Read the top of [docs/PROOF.md](docs/PROOF.md): 360 of 360 cited transactions verified on chain, 23 of 23
   same-block pairs, 8 of 8 contracts, as of Hideki block 36,407,680 (2026-10-29).
3. Skim [docs/LIMITS.md](docs/LIMITS.md).

## 1. MVP potential (2 minutes)

**The value.** Copy-trading without a copy server: you follow a trader or a thesis, and the Copybook hub resizes the
positions in your own dreamDEX perps account in the source's block, inside the scale, caps, price band and equity
floor you set. Exits are never gated: no cap, tank, pause or AI verdict holds back a close. A refusal is written
on chain with its reason.

**See it.**

1. Open [the app](https://copybook-eosin.vercel.app/app). Discover ranks real dreamDEX traders by 30-day realized
   PnL, lists the theses with the least allocation that opens them, and shows the live tape of copies and refusals.
   Our demo leader is listed apart and marked ours.
2. Follow a source with a funded testnet wallet. For STT and USDso, message
   [@BazydloMis57623](https://x.com/BazydloMis57623) on X with your Hideki address (why:
   [Try it in 5 minutes](README.md#try-it-in-5-minutes)). [Thesis 2](https://copybook-eosin.vercel.app/thesis/2) opens
   both legs in your follow transaction. During judging (until 2026-11-21)
   [the demo leader](https://copybook-eosin.vercel.app/t/0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d) trades a small BTC or ETH
   position about every 25 minutes, and each move is copied in its block. Check the verdict on the trader page
   first: if it is BLOCK, turn the guard off in the follow flow to see copies (exits are never gated either way).
3. Watch it land on `/me`, or open copies already recorded:
   - [one handler run, two followers](https://copybook-eosin.vercel.app/copy/0x9b950e40fe79338890174ef0e9d4ed7cc2bf5733e6d1df04b049f74b916e9e3c):
     the leader buys BTC and the follower with its guard off is copied in the same block. The same handler
     transaction refuses the guarded follower `RiskGate`, which the copy page does not show: see
     [its PROOF row](docs/PROOF.md#app-live);
   - [a thesis rebalance](https://copybook-eosin.vercel.app/copy/0xd457cf3abe3c3ecf50aa76bb478143aaed88ea3460111a71b80c019692c1c114),
     50/50 to 70/30, copied in the rebalance's block ([row](docs/PROOF.md#thesis1-rebalance)).

**Why people come back and share.** Each copy has a page and a 1200×630 share card that states its block and both
transaction positions. Traders and theses have pages and cards too. The leaderboard ranks sources by followers and by
copy fidelity. Anyone can publish a thesis from the builder, and an agent can follow through the MCP server. Tests:
`app/test/og.test.tsx::the same-block copy: block, the two tx positions, the move, the source`,
`app/test/leaderboard.test.ts::by followers: now, then ever`.

**Scope.** Contracts on two chains, a web app with a follow flow and a dashboard, a TypeScript SDK, an MCP server, a
trader-statistics package, a live end-to-end harness, an evaluated AI guard and a proof ledger. The README lists every
surface: [What is in this repo](README.md#what-is-in-this-repo).

**Technical execution.** The copy path is a Somnia Reactivity subscription per group of followers; the handler reads
the source live, runs each follower's exits before its increases, prices increases fill-or-kill inside the band,
charges each follower's gas to its own tank and defers rather than drops what it cannot fund. The AI guard is two
Somnia Agents committees on Shannon, with the verdict carried over Hyperlane. Diagrams:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 2. Evidence of building (2 minutes)

Each PROOF.md section below lists transactions read back from the chain by `npm run proof` (in `e2e/`), with their
block, position, sender, target, function, gas and events checked.

| What | Where |
| --- | --- |
| Copies sent by the hub into followers' accounts, in the source's block | [23 same-block pairs](docs/PROOF.md#same-block-copies) |
| The app run: approval, guard off, follow, `catchUp`, a live copy, top-up, unfollow with flatten, withdraw, revoke, all sent from the app's pages | [In the app](docs/PROOF.md#in-the-app) |
| Refusals on chain, in the move's block | [Refusals](docs/PROOF.md#refusals-on-chain) |
| Theses: created, followed (both legs in one transaction), rebalanced and copied in the rebalance's block | [Theses](docs/PROOF.md#theses) |
| The AI guard, every hop of one review across both chains | [Review 11](docs/PROOF.md#one-review-end-to-end-review-11) |
| Every review, each tier read from `VerdictTallied` | [Every review](docs/PROOF.md#every-review) |
| A BLOCK refuses new size and never an exit | [Guard rows](docs/PROOF.md#a-block-refuses-new-size-never-an-exit) |
| An AI agent following a thesis through the MCP server, dry run first | [MCP agent](docs/PROOF.md#mcp-agent) |
| Contracts at the addresses in `deployments/`, with source verification | [Contracts](docs/PROOF.md#contracts) |
| Gas per call | [Gas](docs/PROOF.md#gas) |
| How faithfully the committee applies the rubric, with answer keys written on chain before the reviews, including a held-out run on 20 fresh traders | [Held-out result](eval/SCORECARD.md#run-v4-result), [its pre-registration](eval/SCORECARD.md#pre-registration-of-run-v4), [all four runs](eval/SCORECARD.md#four-runs) |
| Every claim in the README, the landing page and the MCP README, with its evidence | [docs/CLAIMS.md](docs/CLAIMS.md) |
| Reproducible reports on the dreamDEX stack | [`feedback/`](feedback/) |
| Demo video | https://youtu.be/HpLdCtyvta0 (2:22) |

Re-check it yourself (read-only, public RPCs, no key):

```sh
cd e2e && npm ci && npm run proof
```

## 3. The code (1 minute)

| Where to look | What it does |
| --- | --- |
| `CopybookHub.follow` ([`contracts/src/CopybookHub.sol`](contracts/src/CopybookHub.sol)) | Stores the policy and the tank, seats the follower in a group, opens the group's relay and Reactivity subscription |
| `GroupRelay._onEvent` → `CopybookHub.onSourceEvent` | The reactive handler: checks the caller and the origin, reads the source live, runs each member's exits then increases |
| [`contracts/src/CopyEngine.sol`](contracts/src/CopyEngine.sol) | Per-follower sync: the policy gates, band prices, fill-or-kill increases, all-or-nothing thesis legs, the equity stop |
| `CopybookHub.catchUp`, `poke`, `resync`, `unfollow` | Syncs outside the handler, the equity-floor stop, a thesis resync, leaving with flatten |
| [`contracts/src/ThemeRegistry.sol`](contracts/src/ThemeRegistry.sol) | Theses: legs, weights, versions, rebalance |
| [`contracts/src/risk/RiskGate.sol`](contracts/src/risk/RiskGate.sol) | `requestReview`, `handle` (verdicts from Shannon), `allowIncrease`, `setGuard` |
| [`contracts/src/risk/RiskReviewer.sol`](contracts/src/risk/RiskReviewer.sol) | On Shannon: `handle` (requests), `handleSummary` and `handleVerdict` (the two committees) |
| [`packages/sdk`](packages/sdk/README.md) | `preflightFollow`, `status`, the writes, history and `watch` |
| [`packages/mcp`](packages/mcp/README.md) | 7 read tools and 7 write tools, dry run by default |
| [`app/`](app/) | Next.js 15; chain reads in `app/lib/server/chain.ts`, the follow flow in `app/components/follow/` |

Tests, run on 2026-10-29, all passing:

| Suite | Command | Tests |
| --- | --- | --- |
| Contracts (unit and invariant) | `cd contracts && npm ci && forge test` | 257 |
| App | `npm test -w @copybook/app` | 333 |
| SDK | `npm test -w @copybook/sdk` | 96, plus 5 live ones run with `COPYBOOK_LIVE=1` |
| MCP server | `npm test -w @copybook/mcp` | 56 |
| Trader statistics | `npm test -w @copybook/stats` | 35 |
| Proof ledger and demo-leader bot | `cd e2e && npm test` | 38 |
| AI-guard rubric | `cd e2e && npm run eval:test` | 8 |

## 4. Communication

The X posts are linked from the README's [X posts](README.md#x-posts) section.

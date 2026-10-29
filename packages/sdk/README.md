# @copybook/sdk

Typed client for the Copybook contracts on Somnia Hideki2 (chain 50383): `CopybookHub`, `ThemeRegistry` and `RiskGate`. The app and the MCP server talk to the chain through this package only.

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { createCopybook, deploymentsFromJson } from "@copybook/sdk";
import hideki from "../../deployments/hideki.json";
import risk from "../../deployments/risk.json";

const deployments = deploymentsFromJson(hideki, risk); // in Node: loadDeployments() from "@copybook/sdk/node"
const copybook = createCopybook({ publicClient, walletClient, deployments });

const check = await copybook.preflightFollow({ account, kind: "Theme", source: 1n, policy, tank, walletChainId });
if (!check.ok) show(check.reasons);                      // each reason names the field and the least value that clears it
for (const step of check.steps) if (!step.done) await run(step.id); // approveOperator, then follow; resume from the first undone step

const tx = await copybook.follow({ target: { kind: "Theme", themeId: 1n }, policy, tank });
const { events } = await tx.wait();                      // typed Copybook events from the receipt

const status = await copybook.status(account);           // every stuck state carries the exact call that clears it
await copybook.watch({ follower: account, onEvent });    // somnia_watch ticks + getLogs, reconnect-safe, no duplicates
const past = await copybook.history({ fromBlock, follower: account });
```

Reads: `followOf`, `tankOf`, `syncedPools`, `pendingOf`, `themeSyncOf`, `gasParams`, `verdictOf`, `guardOf`, `reviewPendingOf`, `reviewFee`, `theme`, `themes`, `market`, `positionSize`, `isOperatorApproved`, `sourceIdOf`, `status`, `themeMinimum`.
Writes (each returns `{ hash, wait() }`): `approveOperator`, `follow`, `unfollow`, `updatePolicy`, `fundTank`, `withdrawTank`, `catchUp`, `poke`, `resume`, `resync`, `setGuard`, `requestReview`, `createTheme`, `rebalance`.

Notes:

- Writes check the wallet's chain first and estimate gas on the node before asking for a signature, so a call that would revert fails with the contract's reason (`CopybookError.revert`). Somnia's estimate runs low for handler-heavy calls, so the SDK sends 1.5x.
- The `walletClient` can be a browser wallet (it signs in the wallet) or a viem client with a local key, as a script or an agent holds one (the SDK signs and sends the raw transaction).
- `Copied.limitPrice` is the limit price of the order that moved the position, not the fill price.
- `preflightFollow` uses the venue's own market parameters (mark, lot, minimum quantity) at call time. Marks move, so show `themeMinimum().recommendedAllocation` (10% headroom) rather than the exact minimum.
- The venue's operator registry is read from `operatorRegistry` in `deployments/hideki.json` (falling back to the Hideki2 address).
- Next.js: the package ships TypeScript source, so add `transpilePackages: ["@copybook/sdk"]` to `next.config`.
- `watch` treats a somnia_watch notification as a tick only: it re-reads logs from the last covered block and emits each `txHash:logIndex` once.
- ABIs in `src/abi` are generated from `contracts/out`: run `forge build` in `contracts/`, then `npm run abis`. They are committed, so consumers need no forge.

```
npm test                 # unit tests with a scripted chain
COPYBOOK_LIVE=1 npm test # adds a read-only pass over the live contracts
```

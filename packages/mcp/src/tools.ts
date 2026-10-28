import {
  CopybookError,
  MAX_JOIN_POOLS,
  PLACE_ORDER_FOR_SELECTOR,
  isTradeable,
  type Follow,
  type Leg,
  type Policy,
  type PreflightResult,
  type SourceKindName,
} from "@copybook/sdk";
import type { Address } from "viem";
import { z, type ZodRawShape } from "zod";
import { presentPreflight } from "./present.ts";
import { Refusal, type Deps, type ToolDef } from "./types.ts";
import { redact } from "./redact.ts";
import { InputError, addressField, fmt, parseAddress, parseDecimal, sttField, usdsoField } from "./units.ts";

const TESTNET = "Copybook runs on the Somnia Hideki2 testnet (chain 50383); amounts are testnet tokens with no market value.";

function defineTool<S extends ZodRawShape>(
  def: { name: string; title: string; description: string; write?: boolean; inputSchema: S },
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): ToolDef {
  const schema = z.object(def.inputSchema);
  return { ...def, write: def.write ?? false, handler: (raw) => run(schema.parse(raw ?? {})) };
}

// ------------------------------------------------------------------ presenters

export function presentPolicy(p: Policy) {
  return {
    scaleBps: p.scaleBps,
    allocationUsdso: fmt(p.allocation),
    maxNotionalUsdso: fmt(p.maxNotional),
    maxTotalNotionalUsdso: fmt(p.maxTotalNotional),
    bandBps: p.bandBps,
    equityFloorUsdso: fmt(p.equityFloor),
  };
}

export function presentFollow(f: Follow) {
  return {
    kind: f.kind,
    ...(f.trader ? { trader: f.trader } : {}),
    ...(f.themeId !== undefined ? { themeId: f.themeId.toString() } : {}),
    stopped: f.paused,
    policy: presentPolicy(f.policy),
  };
}

function presentLegs(legs: readonly Leg[]) {
  return legs.map((l) => ({ pool: l.pool, weightBps: l.weightBps, side: l.weightBps < 0 ? "short" : "long" }));
}

function parseId(v: string | number, what = "id", allowZero = false): bigint {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new Refusal(`${what} must be a non-negative integer; got ${JSON.stringify(v)}`);
  const n = BigInt(s);
  if (!allowZero && n === 0n) throw new Refusal(`${what} must be positive`);
  return n;
}

// ------------------------------------------------------------------ shared write plumbing

function needAgent(deps: Deps): Address {
  if (!deps.agent) {
    throw new Refusal("Write tools are off: COPYBOOK_AGENT_KEY is not set. Set it to the agent's own wallet key (never someone else's) and restart the server.", {
      hint: "Read tools work without a key.",
    });
  }
  return deps.agent;
}

/** Turns an SDK failure into a refusal that keeps the contract's reason. */
async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CopybookError) {
      throw new Refusal(`${what}: ${e.message}`, { code: e.code, ...(e.revert ? { revert: e.revert } : {}) });
    }
    throw e;
  }
}

function refuseUnlessOk(pre: PreflightResult): void {
  if (pre.ok) return;
  const view = presentPreflight(pre);
  throw new Refusal("Preflight refused this follow; nothing was sent. Fix the listed errors and call again.", {
    preflight: { ...view, reasons: view.reasons.filter((r) => r.severity !== "info") },
  });
}

const dryRunField = z
  .boolean()
  .default(true)
  .describe("Default true: return the preflight and the exact calls that would be sent, and send nothing. Pass false to send for real.");

const policyShape = {
  maxNotionalUsdso: usdsoField("Largest notional of any one position the hub may build for this wallet"),
  maxTotalNotionalUsdso: usdsoField("Largest notional of the whole book; 0 means no cap").optional(),
  bandBps: z.number().int().min(1).max(500).default(50).describe("How far inside the mark an increase may be priced, in bps (1 to 500). Default 50."),
  equityFloorUsdso: usdsoField("Below this account equity the follow stops and closes; 0 means off").optional(),
};

function basePolicy(a: { maxNotionalUsdso: string | number; maxTotalNotionalUsdso?: string | number; bandBps: number; equityFloorUsdso?: string | number }) {
  const maxNotional = parseDecimal(a.maxNotionalUsdso, "maxNotionalUsdso");
  if (maxNotional === 0n) throw new InputError("maxNotionalUsdso must be above 0: the hub refuses a follow whose per-position cap is zero.");
  return {
    maxNotional,
    maxTotalNotional: a.maxTotalNotionalUsdso === undefined ? 0n : parseDecimal(a.maxTotalNotionalUsdso, "maxTotalNotionalUsdso"),
    bandBps: a.bandBps,
    equityFloor: a.equityFloorUsdso === undefined ? 0n : parseDecimal(a.equityFloorUsdso, "equityFloorUsdso"),
  };
}

const APPROVAL_NOTE =
  "The first live call also sends a one-time operator approval to dreamDEX's operator registry: setOperatorApprovalGlobal(hub, [placeOrderFor], true). " +
  "This grant is GLOBAL: it covers every perps market for this wallet, not just this follow or trader, and it PERSISTS after unfollow until revoked (revoke_operator). " +
  "It lets the Copybook hub place, cancel and reduce orders in this wallet's dreamDEX account; it can never withdraw funds. " +
  "It is skipped when already granted, and a re-run after a partial failure resumes from the first undone step.";

/** Sends one transaction and waits for it. The hash is recorded BEFORE the wait, so a timeout while waiting still reports it. */
async function step<O>(sent: string[], label: string, send: () => Promise<{ hash: string; wait(): Promise<O> }>): Promise<O> {
  const tx = await send();
  sent.push(`${label} ${tx.hash}`);
  return tx.wait();
}

/** Runs a write sequence; every failure after the first send, of any kind, reports what is already on chain. */
async function sequence<T>(what: string, sent: string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await guard(what, fn);
  } catch (e) {
    if (!sent.length) throw e;
    const reason = e instanceof Refusal ? e.message : redact(e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e));
    throw new Refusal(`${what} after sending ${sent.length} transaction(s): ${reason}`, {
      ...(e instanceof Refusal ? e.details : {}),
      alreadySent: [...sent],
      resume: "Call again: steps already on chain are skipped, so the flow resumes at the first undone step. Check the hashes on the explorer before retrying.",
    });
  }
}

async function runFollow(
  deps: Deps,
  input: {
    kind: SourceKindName;
    source: Address | bigint;
    policy: Policy;
    joinPools?: Address[];
    tank: bigint;
    dryRun: boolean;
  },
) {
  const account = needAgent(deps);
  const { copybook } = deps;
  const pre = await copybook.preflightFollow({
    account,
    kind: input.kind,
    source: input.source,
    policy: input.policy,
    joinPools: input.joinPools,
    tank: input.tank,
    walletChainId: copybook.deployments.chainId,
  });
  refuseUnlessOk(pre);
  const target =
    input.kind === "Theme"
      ? ({ kind: "Theme", themeId: input.source as bigint } as const)
      : ({ kind: "Trader", trader: input.source as Address, joinPools: input.joinPools } as const);
  const approve = pre.steps.find((s) => s.id === "approveOperator")!;
  const view = presentPreflight(pre);

  if (input.dryRun) {
    return {
      dryRun: true,
      sent: false,
      follower: account,
      preflight: view,
      calls: [
        ...(approve.done
          ? []
          : [
              {
                step: "approveOperator",
                to: copybook.deployments.operatorRegistry,
                function: "setOperatorApprovalGlobal",
                args: [copybook.deployments.hub, [PLACE_ORDER_FOR_SELECTOR], true],
              },
            ]),
        {
          step: "follow",
          to: copybook.deployments.hub,
          function: "follow",
          valueStt: fmt(input.tank),
          policy: presentPolicy(input.policy),
          target: input.kind === "Theme" ? { themeId: String(input.source) } : { trader: input.source, markets: input.joinPools?.length ? input.joinPools : "all (allowAll)" },
          calldata: copybook.encode.follow({ target, policy: input.policy }),
        },
      ],
      note: `${APPROVAL_NOTE} Call again with dryRun=false to send. ${TESTNET}`,
    };
  }

  const sent: string[] = [];
  const outcome = await sequence("Follow not completed", sent, async () => {
    if (!approve.done) await step(sent, "approveOperator", () => copybook.approveOperator(true));
    return step(sent, "follow", () => copybook.follow({ target, policy: input.policy, tank: input.tank }));
  });
  return {
    dryRun: false,
    sent: true,
    follower: account,
    transactions: sent,
    followed: outcome.events.some((e) => e.name === "Followed"),
    events: outcome.events.map((e) => ({ name: e.name })),
    next: "Call get_follow to watch the book and see any state that needs a call to clear.",
  };
}

// ------------------------------------------------------------------ the tools

export function buildTools(deps: Deps): ToolDef[] {
  const { copybook, stats } = deps;
  const tools: ToolDef[] = [];

  // ---- reads

  tools.push(
    defineTool(
      {
        name: "list_top_traders",
        title: "List top traders",
        description:
          "Ranks real dreamDEX perp traders by realized PnL over a window, from the indexer, with each trader's stats and the risk summary line the on-chain reviewer sees. " +
          "Ranking is by raw PnL, so it favours size and variance; drawdown and leverage are estimates; read the stats before following anyone. The list can be shorter than n (see skipped and candidateShortfall). " +
          "Slow: it reads the indexer one request at a time, so a call can take a minute. " +
          TESTNET,
        inputSchema: {
          n: z.number().int().min(1).max(25).default(10).describe("How many traders (1 to 25). Default 10."),
          windowDays: z.number().int().min(1).max(90).default(30).describe("Look-back window in days (1 to 90). Default 30."),
        },
      },
      async ({ n, windowDays }) => {
        const exclude = [copybook.deployments.hub, ...(deps.exclude ?? []), ...(deps.agent ? [deps.agent] : [])];
        const r = await stats.topTraders(n, windowDays, { exclude });
        return {
          windowDays,
          traders: r.traders.map((t) => ({
            rank: t.rank,
            trader: t.trader,
            realizedPnlUsdso: t.realizedPnl30d,
            pnlPerUnitDrawdown: t.riskAdjusted,
            summary: stats.riskSummary(t.stats),
            stats: t.stats,
          })),
          skipped: r.skipped,
          candidateShortfall: r.candidateShortfall,
        };
      },
    ),

    defineTool(
      {
        name: "get_trader_stats",
        title: "Get trader stats",
        description:
          "Indexer statistics for one trader over a window: trades, active days, markets, realized PnL, liquidations, realized drawdown, estimated leverage, last activity. " +
          "Unknown values are null, never guessed; hasHistory=false means nothing was observed; truncated=true means only the most recent rows were read. PnL is realized only (no funding, fees or open positions). " +
          TESTNET,
        inputSchema: {
          trader: addressField("The trader's wallet"),
          windowDays: z.number().int().min(1).max(90).default(30).describe("Look-back window in days. Default 30."),
        },
      },
      async ({ trader, windowDays }) => {
        const s = await stats.getTraderStats(parseAddress(trader, "trader"), { windowDays });
        return { summary: stats.riskSummary(s), stats: s };
      },
    ),

    defineTool(
      {
        name: "get_verdict",
        title: "Get RiskGate verdict",
        description:
          "The on-chain AI risk review (RiskGate) of a trader: tier None, Ok, Caution or Block, when it was reviewed, and whether a Block hold is active right now. " +
          "A Block hold only matters to wallets that follow this trader with the AI guard on: they get no new size from the trader (exits are always copied) until it expires. Tier None means never reviewed. " +
          "Also reports a pending review and the fee for requesting one.",
        inputSchema: { trader: addressField("The trader's wallet") },
      },
      async ({ trader }) => {
        const who = parseAddress(trader, "trader");
        const [v, pending, fee] = await Promise.all([copybook.verdictOf(who), copybook.reviewPendingOf(who), copybook.reviewFee()]);
        return {
          trader: who,
          tier: v.tier,
          reviewedAt: v.reviewedAt === 0 ? null : new Date(v.reviewedAt * 1000).toISOString(),
          blockHoldActive: v.blocking,
          blockHoldExpiresAt: v.blockExpiresAt ? new Date(v.blockExpiresAt * 1000).toISOString() : null,
          reviewPending: pending ? { requestedAt: new Date(pending.requestedAt * 1000).toISOString(), replaceable: pending.replaceable } : null,
          reviewFeeStt: fmt(fee),
        };
      },
    ),

    defineTool(
      {
        name: "list_theses",
        title: "List theses",
        description:
          "Every thesis (a basket of perp legs with signed weights) on the ThemeRegistry: id, name, creator, current version and legs. A thesis follow mirrors the basket in one block; use get_thesis for the minimum allocation. " +
          TESTNET,
        inputSchema: {},
      },
      async () => {
        const themes = await copybook.themes();
        return {
          theses: themes.map((t) => ({ id: t.id.toString(), name: t.name, creator: t.creator, version: t.version, uri: t.uri, legs: presentLegs(t.legs) })),
        };
      },
    ),

    defineTool(
      {
        name: "get_thesis",
        title: "Get thesis",
        description:
          "One thesis: legs, version, and the smallest allocation that opens every leg at today's marks. The basket opens all legs or none, so an allocation below the minimum is refused. " +
          "Marks move: use recommendedAllocationUsdso (10% headroom) rather than the exact minimum. minPerPositionCapUsdso is the least maxNotionalUsdso that does not clamp a leg below one order.",
        inputSchema: { id: z.union([z.string(), z.number()]).describe("Thesis id, a positive integer") },
      },
      async ({ id }) => {
        const themeId = parseId(id);
        const count = await copybook.themeCount();
        if (themeId > count) throw new Refusal(`No thesis ${themeId}; there are ${count}.`);
        const theme = await copybook.theme(themeId);
        let minimum: unknown = null;
        let minimumNote: string | undefined;
        try {
          const m = await copybook.themeMinimum(themeId);
          minimum = {
            minAllocationUsdso: fmt(m.allocation),
            recommendedAllocationUsdso: fmt(m.recommendedAllocation),
            minPerPositionCapUsdso: fmt(m.maxNotional),
            bindingPool: m.bindingPool,
            perLeg: m.perLeg.map((l) => ({ pool: l.pool, weightBps: l.weightBps, minAllocationUsdso: fmt(l.minAllocation), minPerPositionCapUsdso: fmt(l.minMaxNotional) })),
          };
        } catch (e) {
          minimumNote = `Minimum unavailable: a leg's market could not be priced (${e instanceof Error ? e.message : "read failed"}).`;
        }
        return {
          id: theme.id.toString(),
          name: theme.name,
          creator: theme.creator,
          uri: theme.uri,
          version: theme.version,
          legs: presentLegs(theme.legs),
          minimum,
          ...(minimumNote ? { note: minimumNote } : {}),
          caveat: "Between thesis versions the hub leaves a follower's book alone; marks moving causes drift until resync.",
        };
      },
    ),

    defineTool(
      {
        name: "get_follow",
        title: "Get follow status",
        description:
          "What a wallet follows and whether it is healthy: the follow and its policy, gas tank, AI guard, thesis version and drift, and every stuck state (stopped, exits pending, tank empty, thesis behind) with the exact call that clears it. " +
          "Defaults to the agent's own wallet when a key is configured.",
        inputSchema: { follower: addressField("The follower wallet").optional() },
      },
      async ({ follower }) => {
        const who = follower ? parseAddress(follower, "follower") : deps.agent;
        if (!who) throw new Refusal("Pass follower (no agent key is configured to default to).");
        const s = await copybook.status(who);
        return {
          follower: s.follower,
          following: s.follow ? presentFollow(s.follow) : null,
          tankStt: fmt(s.tank),
          aiGuardOn: s.guardOn,
          pending: s.pending,
          syncedMarkets: s.synced,
          ...(s.theme ? { thesis: { id: s.theme.id.toString(), name: s.theme.name, version: s.theme.version }, themeSync: s.themeSync } : {}),
          ...(s.drift ? { drift: s.drift.map((d) => ({ pool: d.pool, targetSize: d.target.toString(), currentSize: d.current.toString(), driftBps: d.driftBps })) } : {}),
          issues: s.issues.map((i) => ({
            code: i.code,
            severity: i.severity,
            message: i.message,
            ...(i.action ? { clearWith: { method: i.action.method, args: i.action.args } } : {}),
          })),
        };
      },
    ),

    defineTool(
      {
        name: "get_copy_history",
        title: "Get copy history",
        description:
          "Hub events about one follower, oldest first: Followed, Copied, Refused (with the reason), Stopped, TankCharged and more. " +
          "Copied.limitPrice is the limit price of the order that moved the position, not the fill price. Scans blocks in chunks, so a long range is slow; the default looks back 50000 blocks.",
        inputSchema: {
          follower: addressField("The follower wallet").optional(),
          fromBlock: z.union([z.string(), z.number()]).optional().describe("First block to read. Default: 50000 blocks before the head (never before the hub's deploy block)."),
          limit: z.number().int().min(1).max(500).default(100).describe("Most recent N events to return. Default 100."),
        },
      },
      async ({ follower, fromBlock, limit }) => {
        const who = follower ? parseAddress(follower, "follower") : deps.agent;
        if (!who) throw new Refusal("Pass follower (no agent key is configured to default to).");
        let from: bigint;
        if (fromBlock !== undefined) from = parseId(fromBlock, "fromBlock", true);
        else {
          const head = await copybook.ctx.publicClient.getBlockNumber();
          from = head > 50_000n ? head - 50_000n : 0n;
          if (from < copybook.deployments.deployBlock) from = copybook.deployments.deployBlock;
        }
        const h = await copybook.history({ fromBlock: from, follower: who });
        const events = h.events.slice(-limit).map(({ log, ...body }) => ({ ...body, block: log.blockNumber, txHash: log.transactionHash }));
        return { follower: who, fromBlock: h.fromBlock, toBlock: h.toBlock, total: h.events.length, returned: events.length, events };
      },
    ),
  );

  // ---- writes

  tools.push(
    defineTool(
      {
        name: "follow_trader",
        title: "Follow a trader",
        write: true,
        description:
          "Follows a trader with the agent's own wallet: the hub mirrors their dreamDEX perp positions into this wallet's account. DRY-RUN BY DEFAULT: dryRun=true returns the preflight and the exact calls; dryRun=false sends them. " +
          "Semantics: one source per wallet (use a dedicated wallet; unfollow before following another). With no markets list the follow mirrors the trader's whole book, including positions already open. " +
          "Exits are always copied; increases are gated (price band, per-position and whole-book caps, equity floor, gas tank, and the AI guard, which blocks new size from a trader rated Block). The AI guard applies to trader follows only. " +
          `${APPROVAL_NOTE} The tank (tankStt, at least 0.2 STT) pays for copy gas. If preflight finds an error nothing is sent and the reasons are returned. ${TESTNET}`,
        inputSchema: {
          trader: addressField("The trader to follow"),
          scaleBps: z.number().int().min(1).max(100_000).default(10_000).describe("Size multiplier in bps; 10000 = 1x, at most 100000 (10x). Default 10000."),
          ...policyShape,
          markets: z.array(z.string()).max(MAX_JOIN_POOLS).optional().describe(`Limit the follow to these perp pool addresses (at most ${MAX_JOIN_POOLS}). Omit to mirror every market the trader trades.`),
          tankStt: sttField("Gas tank deposit (at least 0.2 STT)"),
          dryRun: dryRunField,
        },
      },
      async (a) => {
        needAgent(deps);
        const markets = a.markets?.map((m, i) => parseAddress(m, `markets[${i}]`));
        return runFollow(deps, {
          kind: "Trader",
          source: parseAddress(a.trader, "trader"),
          policy: { scaleBps: a.scaleBps, allocation: 0n, ...basePolicy(a) },
          joinPools: markets,
          tank: parseDecimal(a.tankStt, "tankStt"),
          dryRun: a.dryRun,
        });
      },
    ),

    defineTool(
      {
        name: "follow_thesis",
        title: "Follow a thesis",
        write: true,
        description:
          "Follows a thesis with the agent's own wallet: the hub opens the whole basket in one block, weights applied to allocationUsdso. DRY-RUN BY DEFAULT: dryRun=true returns the preflight and the exact calls; dryRun=false sends them. " +
          "The basket opens all legs or none: an allocation below any leg's venue minimum, or a per-position cap below one order, is refused by preflight with the least value that clears it (see get_thesis). " +
          "One source per wallet. Between thesis versions the hub leaves the book alone, so it can drift until resync. The AI guard does not apply to thesis follows. Exits are always copied; increases are gated by the band, caps, equity floor and tank. " +
          `${APPROVAL_NOTE} The tank (tankStt, at least 0.2 STT) pays for copy gas. ${TESTNET}`,
        inputSchema: {
          themeId: z.union([z.string(), z.number()]).describe("Thesis id from list_theses"),
          allocationUsdso: usdsoField("Notional the basket weights are applied to"),
          ...policyShape,
          tankStt: sttField("Gas tank deposit (at least 0.2 STT)"),
          dryRun: dryRunField,
        },
      },
      async (a) => {
        needAgent(deps);
        return runFollow(deps, {
          kind: "Theme",
          source: parseId(a.themeId, "themeId"),
          policy: { scaleBps: 10_000, allocation: parseDecimal(a.allocationUsdso, "allocationUsdso"), ...basePolicy(a) },
          tank: parseDecimal(a.tankStt, "tankStt"),
          dryRun: a.dryRun,
        });
      },
    ),

    defineTool(
      {
        name: "unfollow",
        title: "Unfollow",
        write: true,
        description:
          "Stops the agent wallet's follow and returns its gas tank. flatten=true also closes the positions the follow built (recommended); flatten=false leaves them open, unmanaged, in the wallet's account. " +
          "If the closes do not all run, get_follow shows STOP_CLOSES_PENDING with the poke call that finishes them. DRY-RUN BY DEFAULT.",
        inputSchema: {
          flatten: z.boolean().describe("Close the follow's positions as part of stopping. Required, no default."),
          dryRun: dryRunField,
        },
      },
      async ({ flatten, dryRun }) => {
        const account = needAgent(deps);
        const follow = await copybook.followOf(account);
        if (!follow) throw new Refusal("This wallet is not following anything; nothing to unfollow.");
        const call = { step: "unfollow", to: copybook.deployments.hub, function: "unfollow", args: [flatten] };
        if (dryRun) return { dryRun: true, sent: false, follower: account, following: presentFollow(follow), calls: [call] };
        const sent: string[] = [];
        const out = await sequence("Unfollow failed", sent, () => step(sent, "unfollow", () => copybook.unfollow(flatten)));
        return { dryRun: false, sent: true, transactions: sent, events: out.events.map((e) => ({ name: e.name })), next: "Call get_follow to confirm nothing is pending." };
      },
    ),

    defineTool(
      {
        name: "revoke_operator",
        title: "Revoke the hub's operator approval",
        write: true,
        description:
          "Withdraws the global operator grant (setOperatorApprovalGlobal(hub, [placeOrderFor], false)) that follow_trader and follow_thesis send. The grant covers every perps market for this wallet and persists after unfollow, so revoke it once the agent is done following. " +
          "While it stands the hub can place, cancel and reduce orders in this wallet's dreamDEX account (never withdraw). Refused while the wallet still follows something, since the hub could no longer copy: unfollow first. DRY-RUN BY DEFAULT.",
        inputSchema: { dryRun: dryRunField },
      },
      async ({ dryRun }) => {
        const account = needAgent(deps);
        const [follow, approved] = await Promise.all([copybook.followOf(account), copybook.isOperatorApproved(account)]);
        if (follow) throw new Refusal("This wallet still follows a source; revoking now would stop the hub from copying. Unfollow first.");
        if (!approved) throw new Refusal("The hub has no operator approval on this wallet; nothing to revoke.");
        const call = {
          step: "revokeOperator",
          to: copybook.deployments.operatorRegistry,
          function: "setOperatorApprovalGlobal",
          args: [copybook.deployments.hub, [PLACE_ORDER_FOR_SELECTOR], false],
        };
        if (dryRun) return { dryRun: true, sent: false, wallet: account, calls: [call] };
        const sent: string[] = [];
        await sequence("Revoke failed", sent, () => step(sent, "revokeOperator", () => copybook.approveOperator(false)));
        return { dryRun: false, sent: true, transactions: sent, next: "A later follow will ask for the approval again." };
      },
    ),

    defineTool(
      {
        name: "request_review",
        title: "Request a risk review",
        write: true,
        description:
          "Pays the review fee (STT, from the agent's wallet) to ask validators for a fresh RiskGate review of a trader. The verdict arrives later in a callback; poll get_verdict. " +
          "Refused when a review is already pending for that trader or it was reviewed moments ago. DRY-RUN BY DEFAULT.",
        inputSchema: { trader: addressField("The trader to review"), dryRun: dryRunField },
      },
      async ({ trader, dryRun }) => {
        const account = needAgent(deps);
        const who = parseAddress(trader, "trader");
        const [pending, fee] = await Promise.all([copybook.reviewPendingOf(who), copybook.reviewFee()]);
        if (pending && !pending.replaceable) {
          throw new Refusal("A review of this trader is already pending; wait for its verdict (get_verdict).", { requestedAt: new Date(pending.requestedAt * 1000).toISOString() });
        }
        const call = { step: "requestReview", to: copybook.deployments.gate, function: "requestReview", args: [who], valueStt: fmt(fee) };
        if (dryRun) {
          return { dryRun: true, sent: false, requester: account, calls: [call], ...(pending ? { note: "An earlier request timed out, so this one replaces it." } : {}) };
        }
        const sent: string[] = [];
        await sequence("Review request failed", sent, () => step(sent, "requestReview", () => copybook.requestReview(who, fee)));
        return { dryRun: false, sent: true, transactions: sent, next: "Poll get_verdict until reviewedAt moves." };
      },
    ),

    defineTool(
      {
        name: "create_thesis",
        title: "Create a thesis",
        write: true,
        description:
          "Publishes a new thesis (a perp basket) on the ThemeRegistry from the agent's wallet, which becomes its creator and the only one who can rebalance it. " +
          "Rules the registry enforces: 1 to 8 legs, each a dreamDEX perp pool listed once, each weighing at least 500 bps long (positive) or short (negative), gross weight at most 30000 bps. DRY-RUN BY DEFAULT. " +
          "Followers' books follow the thesis, so publish only what you would stand behind. " +
          TESTNET,
        inputSchema: {
          name: z.string().min(1).max(64).describe("Thesis name, 1 to 64 characters"),
          legs: z
            .array(z.object({ pool: addressField("dreamDEX perp pool address"), weightBps: z.number().int().describe("Signed weight in bps; negative is short; magnitude 500 to 30000") }))
            .min(1)
            .max(8),
          uri: z.string().max(256).default("").describe("Optional link to the written thesis"),
          dryRun: dryRunField,
        },
      },
      async ({ name, legs: rawLegs, uri, dryRun }) => {
        const account = needAgent(deps);
        const legs: Leg[] = rawLegs.map((l, i) => ({ pool: parseAddress(l.pool, `legs[${i}].pool`), weightBps: l.weightBps }));
        const errors: string[] = [];
        const seen = new Set<string>();
        let gross = 0;
        legs.forEach((l, i) => {
          if (seen.has(l.pool.toLowerCase())) errors.push(`legs[${i}]: market listed twice`);
          seen.add(l.pool.toLowerCase());
          if (Math.abs(l.weightBps) < 500) errors.push(`legs[${i}]: weight ${l.weightBps} bps is under the 500 bps minimum`);
          gross += Math.abs(l.weightBps);
        });
        if (gross > 30_000) errors.push(`gross weight ${gross} bps exceeds 30000`);
        await Promise.all(
          legs.map(async (l, i) => {
            try {
              if (!isTradeable(await copybook.market(l.pool))) errors.push(`legs[${i}]: ${l.pool} reports no usable mark price`);
            } catch {
              errors.push(`legs[${i}]: ${l.pool} is not a readable dreamDEX perp market`);
            }
          }),
        );
        if (errors.length) throw new Refusal("The thesis would be refused; nothing was sent.", { errors });
        const call = { step: "createTheme", to: copybook.deployments.themes, function: "createTheme", args: { name, uri, legs: presentLegs(legs) } };
        if (dryRun) return { dryRun: true, sent: false, creator: account, calls: [call] };
        const sent: string[] = [];
        const out = await sequence("Create thesis failed", sent, () => step(sent, "createTheme", () => copybook.createTheme(name, uri, legs)));
        const created = out.events.find((e) => e.name === "ThemeCreated");
        return {
          dryRun: false,
          sent: true,
          transactions: sent,
          themeId: created && created.name === "ThemeCreated" ? created.themeId.toString() : undefined,
          next: "Call get_thesis to see its minimum allocation.",
        };
      },
    ),
  );

  return tools;
}

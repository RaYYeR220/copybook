import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { gateAbi } from "./abi/gate.ts";
import { hubAbi } from "./abi/hub.ts";
import { themesAbi } from "./abi/themes.ts";
import { GAS_HEADROOM_DEN, GAS_HEADROOM_NUM, MAX_TX_GAS, MIN_TANK, MIN_TANK_FOR_INCREASE, PLACE_ORDER_FOR_SELECTOR, THEME_DRIFT_BPS } from "./constants.ts";
import { CopybookError, asCopybookError, revertAbi } from "./errors.ts";
import { decodeCopybookLogs, type CopybookEvent } from "./events.ts";
import { getHubHistory, type HistoryOptions } from "./history.ts";
import { isTradeable, minThemeAllocation, readMarket, simulateLeg, withHeadroom, type ThemeMinimum } from "./market.ts";
import { preflightFollow, type PreflightInput, type PreflightResult } from "./preflight.ts";
import * as reads from "./reads.ts";
import type { ReadContext } from "./reads.ts";
import type { Deployments, Follow, Leg, Market, Pending, Policy, SourceKindName, Theme, ThemeSync } from "./types.ts";
import { watchHub, type WatchHandle, type WatchOptions } from "./watch.ts";

export interface CopybookConfig {
  publicClient: PublicClient;
  /** Needed for writes only. Its account is the follower / creator / requester. */
  walletClient?: WalletClient;
  deployments: Deployments;
}

/** What a sent transaction gives back right away. */
export interface WriteResult {
  hash: Hex;
  /** Waits for the receipt and decodes the Copybook events in it. Throws a CopybookError if the transaction reverted. */
  wait(opts?: { timeoutMs?: number }): Promise<TxOutcome>;
}

export interface TxOutcome {
  hash: Hex;
  receipt: TransactionReceipt;
  /** Copybook events in this transaction only. A copy the hub makes later, in the leader's block, arrives as its own transaction. */
  events: CopybookEvent[];
}

export type FollowTarget =
  | { kind: "Trader"; trader: Address; joinPools?: readonly Address[] }
  | { kind: "Theme"; themeId: bigint };

export interface FollowArgs {
  target: FollowTarget;
  policy: Policy;
  /** STT in wei sent into the follower's gas tank. At least MIN_TANK. */
  tank: bigint;
}

export interface FollowerIssue {
  code:
    | "STOPPED"
    | "STOP_CLOSES_PENDING"
    | "EXITS_PENDING"
    | "TANK_EMPTY"
    | "TANK_LOW"
    | "THEME_BEHIND"
    | "THEME_SYNC_INCOMPLETE"
    | "THEME_DRIFT"
    | "GUARD_OFF";
  severity: "error" | "warning" | "info";
  message: string;
  /** The exact call that clears it, when one does. */
  action?: { method: "resume" | "poke" | "catchUp" | "resync" | "fundTank" | "setGuard"; args?: readonly unknown[] };
}

export interface ThemeDriftLeg {
  pool: Address;
  target: bigint;
  current: bigint;
  /** |current - target| as a share of |target|, in bps (10_000 when the target is zero and a position is open). */
  driftBps: number;
}

export interface FollowerStatus {
  follower: Address;
  follow: Follow | null;
  tank: bigint;
  pending: Pending;
  synced: Address[];
  guardOn: boolean;
  theme?: Theme;
  themeSync?: ThemeSync;
  drift?: ThemeDriftLeg[];
  issues: FollowerIssue[];
}

const ZERO = 0n;
/** An 18-decimal USDso amount as plain digits, for messages. */
const usdso = (x: bigint) => formatUnits(x, 18);

/** The typed client. Everything the app and the MCP server do with the contracts goes through here. */
export function createCopybook(config: CopybookConfig) {
  const { publicClient, walletClient, deployments } = config;
  const ctx: ReadContext = { publicClient, deployments };

  function requireAccount(): Address {
    const a = walletClient?.account?.address;
    if (!walletClient || !a) throw new CopybookError("NO_WALLET", "Connect a wallet to send transactions.");
    return getAddress(a);
  }

  async function send(call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint; gas?: bigint }): Promise<WriteResult> {
    const account = requireAccount();
    const wallet = walletClient!;
    const chainId = await wallet.getChainId();
    if (chainId !== deployments.chainId) {
      throw new CopybookError("WRONG_CHAIN", `The wallet is on chain ${chainId}; Copybook runs on Somnia Hideki testnet (Tokyo), chain ${deployments.chainId}.`);
    }
    const full = { ...call, abi: [...call.abi, ...revertAbi] as Abi };
    try {
      // Somnia's estimate runs low for handler-heavy calls, so send with headroom. An estimate that reverts surfaces
      // the contract's reason here, before the user is asked to sign anything.
      let gas = call.gas;
      if (gas === undefined) {
        const est = await publicClient.estimateContractGas({ ...full, account } as never);
        gas = (est * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
        if (gas > MAX_TX_GAS) gas = MAX_TX_GAS;
      }
      // the wallet's own account object: a local key signs here and goes out raw; an address alone would ask the
      // node to sign (eth_sendTransaction), which only a browser wallet answers
      const hash = await wallet.writeContract({ ...full, gas, account: wallet.account!, chain: wallet.chain ?? null } as never);
      return { hash, wait: (o) => waitFor(hash, o?.timeoutMs) };
    } catch (e) {
      throw asCopybookError(e);
    }
  }

  async function waitFor(hash: Hex, timeoutMs = 240_000): Promise<TxOutcome> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 500 });
    if (receipt.status !== "success") {
      throw new CopybookError("TX_FAILED", `Transaction ${hash} reverted on chain.`);
    }
    return { hash, receipt, events: decodeCopybookLogs(receipt.logs, deployments) };
  }

  /**
   * The deposit half of moving USDso into the perps account: `deposit(amount)` on the margin bank, which pulls the
   * USDso from the wallet. Balance and allowance are read first, so a deposit the bank would refuse names its cause
   * before anything is signed.
   */
  async function depositMargin(amount: bigint): Promise<WriteResult> {
    if (amount <= ZERO) throw new CopybookError("INVALID_INPUT", "The deposit must be above zero.");
    const account = requireAccount();
    const { spot, allowance } = await reads.marginFunding(ctx, account);
    if (spot < amount) {
      throw new CopybookError("INSUFFICIENT_FUNDS", `This wallet holds ${usdso(spot)} USDso on spot, less than the ${usdso(amount)} to deposit.`);
    }
    if (allowance < amount) {
      throw new CopybookError("NEEDS_APPROVAL", `The margin bank may pull ${usdso(allowance)} USDso from this wallet; approve at least ${usdso(amount)} USDso first (approveMargin).`);
    }
    return send({ address: deployments.marginBank, abi: reads.marginBankFundingAbi as Abi, functionName: "deposit", args: [amount] });
  }

  const hub = { address: deployments.hub, abi: hubAbi as Abi } as const;
  const gate = { address: deployments.gate, abi: gateAbi as Abi } as const;
  const registry = parseAbi(["function setOperatorApprovalGlobal(address operator, bytes4[] selectors, bool approved)"]) as Abi;

  // ---------------------------------------------------------------- derived reads

  async function status(follower: Address): Promise<FollowerStatus> {
    const who = getAddress(follower);
    const [follow, tank, pending, synced, guardOn] = await Promise.all([
      reads.followOf(ctx, who),
      reads.tankOf(ctx, who),
      reads.pendingOf(ctx, who),
      reads.syncedPools(ctx, who),
      reads.guardOf(ctx, who),
    ]);
    const out: FollowerStatus = { follower: who, follow, tank, pending, synced, guardOn, issues: [] };
    if (!follow) return out;
    const issues = out.issues;

    if (pending.flattenPending) {
      issues.push({
        code: "STOP_CLOSES_PENDING",
        severity: "error",
        message: "A stop's closes did not all finish. Run poke to finish them; resume waits for it.",
        action: { method: "poke", args: [who] },
      });
    }
    if (follow.paused && !pending.flattenPending) {
      let canResume = true;
      let why = "The follow is stopped (equity fell below the floor, or it was paused). Resume lifts it.";
      if (follow.policy.equityFloor > ZERO) {
        const equity = await reads.accountEquity(ctx, who).catch(() => undefined);
        if (equity !== undefined && equity < follow.policy.equityFloor) {
          canResume = false;
          why = "The follow is stopped and equity is still below the floor. Add margin or lower the floor with updatePolicy, then resume.";
        }
      }
      issues.push({ code: "STOPPED", severity: "error", message: why, ...(canResume ? { action: { method: "resume" as const } } : {}) });
    }
    if (pending.exitPending) {
      issues.push({
        code: "EXITS_PENDING",
        severity: "error",
        message: "The handler ran out of gas on this follow's exits and skips it until someone finishes them. catchUp does it on the caller's gas.",
        action: { method: "catchUp", args: [who, []] },
      });
    }
    if (tank < MIN_TANK_FOR_INCREASE) {
      issues.push({
        code: "TANK_EMPTY",
        severity: "error",
        message: "The gas tank is nearly empty, so every increase is refused (exits are never gated). Fund it.",
        action: { method: "fundTank", args: [MIN_TANK] },
      });
    } else if (tank < MIN_TANK) {
      issues.push({
        code: "TANK_LOW",
        severity: "warning",
        message: "The gas tank is below the 0.2 STT a follow keeps, so it cannot be withdrawn from and will run dry soon. Top it up.",
        action: { method: "fundTank", args: [MIN_TANK - tank] },
      });
    }
    if (follow.kind === "Trader" && !guardOn) {
      issues.push({ code: "GUARD_OFF", severity: "info", message: "The AI guard is off for this wallet: Block verdicts will not stop new size.", action: { method: "setGuard", args: [true] } });
    }

    if (follow.kind === "Theme" && follow.themeId !== undefined) {
      const [theme, themeSync] = await Promise.all([reads.themeOf(ctx, follow.themeId), reads.themeSyncOf(ctx, who)]);
      out.theme = theme;
      out.themeSync = themeSync;
      if (themeSync.syncedVersion < theme.version) {
        issues.push({
          code: "THEME_BEHIND",
          severity: "warning",
          message: `The thesis moved to version ${theme.version}; this book is on ${themeSync.syncedVersion}. The hub reconciles it on the rebalance; catchUp finishes it if it did not.`,
          action: { method: "catchUp", args: [who, []] },
        });
      } else if (!themeSync.lastSyncComplete) {
        issues.push({
          code: "THEME_SYNC_INCOMPLETE",
          severity: "warning",
          message: "The last sync did not leave every leg at target (a leg was refused). catchUp retries it.",
          action: { method: "catchUp", args: [who, []] },
        });
      }
      out.drift = await themeDrift(who, theme, follow.policy);
      const worst = out.drift.reduce((m, d) => (d.driftBps > m ? d.driftBps : m), 0);
      if (worst >= THEME_DRIFT_BPS) {
        issues.push({
          code: "THEME_DRIFT",
          severity: "warning",
          message: `A leg has drifted ${(worst / 100).toFixed(1)}% from its target as marks moved. Between thesis versions the hub leaves the book alone; resync brings it back.`,
          action: { method: "resync" },
        });
      }
    }
    return out;
  }

  async function themeDrift(who: Address, theme: Theme, policy: Policy): Promise<ThemeDriftLeg[]> {
    return Promise.all(
      theme.legs.map(async (leg) => {
        const [m, current] = await Promise.all([readMarket(publicClient, leg.pool), reads.positionSize(ctx, who, leg.pool)]);
        const target = isTradeable(m) ? simulateLeg(policy.allocation, leg, policy.maxNotional, m).target : 0n;
        const diff = current > target ? current - target : target - current;
        const base = target < 0n ? -target : target;
        const driftBps = base === 0n ? (current === 0n ? 0 : 10_000) : Number((diff * 10_000n) / base);
        return { pool: leg.pool, target, current, driftBps };
      }),
    );
  }

  /** Smallest allocation (and cap) that opens every leg of a thesis at today's marks, plus a figure with headroom. */
  async function themeMinimum(themeId: bigint, headroomBps = 1_000): Promise<ThemeMinimum & { recommendedAllocation: bigint; theme: Theme; markets: Market[] }> {
    const theme = await reads.themeOf(ctx, themeId);
    const markets = await Promise.all(theme.legs.map((l) => readMarket(publicClient, l.pool)));
    const map = new Map(markets.map((m) => [m.pool.toLowerCase(), m]));
    const min = minThemeAllocation(theme.legs, map);
    return { ...min, recommendedAllocation: withHeadroom(min.allocation, headroomBps), theme, markets };
  }

  // ---------------------------------------------------------------- the client

  return {
    deployments,
    ctx,

    // reads
    sourceIdOf: reads.sourceIdOf,
    followOf: (follower: Address): Promise<Follow | null> => reads.followOf(ctx, follower),
    tankOf: (follower: Address) => reads.tankOf(ctx, follower),
    syncedPools: (follower: Address) => reads.syncedPools(ctx, follower),
    pendingOf: (follower: Address) => reads.pendingOf(ctx, follower),
    seatOf: (follower: Address) => reads.seatOf(ctx, follower),
    themeSyncOf: (follower: Address) => reads.themeSyncOf(ctx, follower),
    gasParams: () => reads.gasParams(ctx),
    verdictOf: (trader: Address) => reads.verdictOf(ctx, trader),
    guardOf: (follower: Address) => reads.guardOf(ctx, follower),
    reviewPendingOf: (trader: Address) => reads.reviewPendingOf(ctx, trader),
    reviewFee: () => reads.reviewFee(ctx),
    themeCount: () => reads.themeCount(ctx),
    theme: (id: bigint): Promise<Theme> => reads.themeOf(ctx, id),
    themes: (): Promise<Theme[]> => reads.listThemes(ctx),
    market: (pool: Address): Promise<Market> => readMarket(publicClient, pool),
    positionSize: (account: Address, pool: Address) => reads.positionSize(ctx, account, pool),
    /** Size and average entry price of one perp position. */
    position: (account: Address, pool: Address): Promise<reads.PerpPosition> => reads.position(ctx, account, pool),
    /** The perps account's equity (18-decimal USD), as the margin bank reports it. */
    accountEquity: (account: Address): Promise<bigint> => reads.accountEquity(ctx, account),
    isOperatorApproved: (owner: Address) => reads.isOperatorApproved(ctx, owner),
    /** USDso, the margin bank's collateral, as the bank names it. */
    marginToken: () => reads.marginToken(ctx),
    /** USDso in the wallet itself, outside the perps account (18 decimals). */
    spotUsdsoBalance: (account: Address) => reads.spotUsdsoBalance(ctx, account),
    /** How much USDso the margin bank may pull from the wallet for a deposit. */
    marginAllowance: (account: Address) => reads.marginAllowance(ctx, account),
    /** The token, the spot USDso and the bank's allowance in one read. */
    marginFunding: (account: Address): Promise<reads.MarginFunding> => reads.marginFunding(ctx, account),
    status,
    themeMinimum,
    preflightFollow: (input: PreflightInput): Promise<PreflightResult> => preflightFollow(ctx, input),

    // events
    decodeLogs: (logs: Parameters<typeof decodeCopybookLogs>[0]) => decodeCopybookLogs(logs, deployments),
    history: (opts: HistoryOptions) => getHubHistory(ctx, opts),
    watch: (opts: Omit<WatchOptions, "deployments" | "publicClient">): Promise<WatchHandle> => watchHub({ ...opts, publicClient, deployments }),

    // writes
    waitFor,
    /** One-time grant letting the hub place orders in the wallet's dreamDEX account (the global `placeOrderFor` approval). */
    approveOperator: (approved = true) =>
      send({
        address: deployments.operatorRegistry,
        abi: registry,
        functionName: "setOperatorApprovalGlobal",
        args: [deployments.hub, [PLACE_ORDER_FOR_SELECTOR], approved],
      }),
    follow: ({ target, policy, tank }: FollowArgs) =>
      send({
        ...hub,
        functionName: "follow",
        args:
          target.kind === "Theme"
            ? [1, target.themeId, policy, []]
            : [0, BigInt(target.trader), policy, [...(target.joinPools ?? [])]],
        value: tank,
      }),
    unfollow: (flatten: boolean) => send({ ...hub, functionName: "unfollow", args: [flatten] }),
    updatePolicy: (policy: Policy) => send({ ...hub, functionName: "updatePolicy", args: [policy] }),
    fundTank: (amount: bigint) => send({ ...hub, functionName: "fundTank", value: amount }),
    withdrawTank: (amount: bigint) => send({ ...hub, functionName: "withdrawTank", args: [amount] }),
    /** Anyone may call it for any follower: it only moves them toward their source. */
    catchUp: (follower: Address, pools: readonly Address[] = []) => send({ ...hub, functionName: "catchUp", args: [follower, [...pools]] }),
    poke: (follower: Address) => send({ ...hub, functionName: "poke", args: [follower] }),
    resume: () => send({ ...hub, functionName: "resume" }),
    resync: () => send({ ...hub, functionName: "resync" }),
    setGuard: (on: boolean) => send({ ...gate, functionName: "setGuard", args: [on] }),
    /**
     * Moving spot USDso into the perps account takes two writes, as dreamDEX's own SDK sends them: `approveMargin(amount)` lets
     * the margin bank pull exactly that much (skip it while `marginAllowance` covers the deposit), then
     * `depositMargin(amount)` moves it in and the account's equity rises by it.
     */
    approveMargin: async (amount: bigint) => {
      if (amount <= ZERO) throw new CopybookError("INVALID_INPUT", "The approval must be above zero.");
      return send({ address: await reads.marginToken(ctx), abi: reads.erc20Abi as Abi, functionName: "approve", args: [deployments.marginBank, amount] });
    },
    depositMargin,
    /** Pays for a validator review of a trader. Defaults to the gate's current fee. */
    requestReview: async (trader: Address, value?: bigint) => send({ ...gate, functionName: "requestReview", args: [trader], value: value ?? (await reads.reviewFee(ctx)) }),
    createTheme: (name: string, uri: string, legs: readonly Leg[]) =>
      send({ address: deployments.themes, abi: themesAbi as Abi, functionName: "createTheme", args: [name, uri, legs.map((l) => ({ pool: l.pool, weightBps: l.weightBps }))] }),
    rebalance: (themeId: bigint, legs: readonly Leg[]) =>
      send({ address: deployments.themes, abi: themesAbi as Abi, functionName: "rebalance", args: [themeId, legs.map((l) => ({ pool: l.pool, weightBps: l.weightBps }))] }),

    /** Encoded calldata, for wallets and bundlers that send the transaction themselves. */
    encode: {
      follow: ({ target, policy }: Omit<FollowArgs, "tank">): Hex =>
        encodeFunctionData({
          abi: hubAbi,
          functionName: "follow",
          args: target.kind === "Theme" ? [1, target.themeId, policy, []] : [0, BigInt(target.trader), policy, [...(target.joinPools ?? [])]],
        }),
    },
  };
}

export type Copybook = ReturnType<typeof createCopybook>;
export type { SourceKindName };

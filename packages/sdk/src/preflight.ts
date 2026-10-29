import { getAddress, isAddress, type Address } from "viem";
import { MAX_JOIN_POOLS, MIN_TANK } from "./constants.ts";
import { isTradeable, minOrderQty, minThemeAllocation, notionalOf, readMarket, scaledSize, simulateLeg, tradableQty, withHeadroom } from "./market.ts";
import * as reads from "./reads.ts";
import type { ReadContext } from "./reads.ts";
import type { Market, Policy, SourceKindName } from "./types.ts";
import type { ThemeMinimum } from "./market.ts";

export type PreflightCode =
  | "WRONG_CHAIN"
  | "NO_ACCOUNT"
  | "ALREADY_FOLLOWING"
  | "FOLLOWS_PAUSED"
  | "TANK_TOO_LOW"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_SOURCE"
  | "INVALID_POLICY"
  | "JOIN_POOLS_NOT_ALLOWED"
  | "TOO_MANY_POOLS"
  | "UNKNOWN_MARKET"
  | "ALLOCATION_BELOW_MINIMUM"
  | "CAP_BELOW_ONE_ORDER"
  | "TOTAL_CAP_BELOW_BASKET"
  | "TOTAL_CAP_BELOW_ONE_ORDER"
  | "EQUITY_BELOW_FLOOR"
  | "EQUITY_UNREADABLE"
  | "SCALED_BELOW_MINIMUM"
  | "TRADER_BLOCKED"
  | "OPERATOR_NOT_APPROVED"
  | "ALLOW_ALL_MIRRORS_OPEN_BOOK";

export interface PreflightReason {
  code: PreflightCode;
  /** `error` would be refused or reverted; `warning` follows but with a limit the user should know; `info` is context. */
  severity: "error" | "warning" | "info";
  message: string;
  /** The market the reason is about, when it is about one. */
  pool?: Address;
  /** The policy field to fix, when the reason is about one. */
  field?: keyof Policy | "tank";
  /** The least value of `field` that clears an error, at today's marks. */
  required?: bigint;
}

export type FollowStepId = "approveOperator" | "follow";

export interface PreflightResult {
  /** No error-severity reason: the follow would not revert and its opening would not be refused. */
  ok: boolean;
  /** Errors first, then warnings, then info. */
  reasons: PreflightReason[];
  /** The transactions the follow flow needs, in order, with whether each is already done on chain. Resume from the first undone one. */
  steps: { id: FollowStepId; done: boolean }[];
  /** For theme follows: the smallest allocation and cap at today's marks, plus a figure with 10% headroom. */
  themeMinimum?: ThemeMinimum & { recommendedAllocation: bigint };
}

export interface PreflightInput {
  /** The wallet that will follow. Without one the check cannot run and says so. */
  account?: Address;
  kind: SourceKindName;
  /** Trader address (trader follow) or theme id (theme follow). */
  source: Address | bigint;
  policy: Policy;
  /** Trader follows: markets to manage. Empty means allowAll. Theme follows: leave empty. */
  joinPools?: readonly Address[];
  /**
   * Trader follows with no market list (allowAll): markets to check the cap and the scaled size in, without
   * limiting the follow to them. Pass the markets the trader holds now, so a cap below one order there is caught.
   */
  checkPools?: readonly Address[];
  /** The AI guard as the follow will run with it, when the flow changes it before following. Default: read from the gate. */
  guardOn?: boolean;
  /** STT the follow will fund the tank with, in wei. */
  tank: bigint;
  /** The chain the wallet is on, if the app knows it. */
  walletChainId?: number;
  /** Wallet STT balance in wei, if the app already read it (skips one call). */
  walletBalance?: bigint;
}

const order: Record<PreflightReason["severity"], number> = { error: 0, warning: 1, info: 2 };

/**
 * Checks a follow before the user signs: everything that would revert in `follow` and everything the hub would
 * refuse on opening (a thesis leg below its venue minimum, a cap below one order, a tank below the minimum, the
 * wrong chain, an existing follow), using live market parameters. Reads only.
 */
export async function preflightFollow(c: ReadContext, input: PreflightInput): Promise<PreflightResult> {
  const reasons: PreflightReason[] = [];
  const add = (r: PreflightReason) => reasons.push(r);
  const { policy, kind } = input;
  const joinPools = [...(input.joinPools ?? [])];
  const account = input.account && isAddress(input.account) ? getAddress(input.account) : undefined;
  let themeMinimum: PreflightResult["themeMinimum"];
  let approved = false;

  if (input.walletChainId !== undefined && input.walletChainId !== c.deployments.chainId) {
    add({
      code: "WRONG_CHAIN",
      severity: "error",
      message: `The wallet is on chain ${input.walletChainId}; Copybook runs on chain ${c.deployments.chainId} (Somnia Hideki2 testnet). Switch networks first.`,
    });
  }
  if (!account) {
    add({ code: "NO_ACCOUNT", severity: "error", message: "Connect a wallet to follow." });
  }

  // policy shape, mirroring PolicyLib.validate
  if (kind === "Trader") {
    if (policy.scaleBps <= 0 || policy.scaleBps > 100_000) {
      add({ code: "INVALID_POLICY", severity: "error", field: "scaleBps", message: "Scale must be between 0.01x and 10x (1 to 100000 bps)." });
    }
  } else if (policy.allocation <= 0n) {
    add({ code: "INVALID_POLICY", severity: "error", field: "allocation", message: "A thesis follow needs an allocation above zero." });
  }
  if (policy.maxNotional <= 0n) {
    add({ code: "INVALID_POLICY", severity: "error", field: "maxNotional", message: "The per-position cap must be above zero." });
  }
  if (policy.bandBps <= 0 || policy.bandBps > 500) {
    add({ code: "INVALID_POLICY", severity: "error", field: "bandBps", message: "The price band must be between 0.01% and 5% (1 to 500 bps)." });
  }
  if (joinPools.length > MAX_JOIN_POOLS) {
    add({ code: "TOO_MANY_POOLS", severity: "error", message: `A trader follow may name at most ${MAX_JOIN_POOLS} markets.` });
  }
  if (kind === "Theme" && joinPools.length > 0) {
    add({ code: "JOIN_POOLS_NOT_ALLOWED", severity: "error", message: "A thesis follow manages its own legs and takes no market list." });
  }

  // tank
  if (input.tank < MIN_TANK) {
    add({
      code: "TANK_TOO_LOW",
      severity: "error",
      field: "tank",
      required: MIN_TANK,
      message: "The gas tank must be funded with at least 0.2 STT.",
    });
  }

  // chain state that does not depend on the source
  const [paused, followNow, balance, operatorApproved] = await Promise.all([
    reads.followsPaused(c),
    account ? reads.followOf(c, account) : Promise.resolve(null),
    account ? (input.walletBalance !== undefined ? Promise.resolve(input.walletBalance) : c.publicClient.getBalance({ address: account })) : Promise.resolve(undefined),
    account ? reads.isOperatorApproved(c, account).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (paused) add({ code: "FOLLOWS_PAUSED", severity: "error", message: "New follows are paused by the hub owner." });
  if (followNow) {
    add({
      code: "ALREADY_FOLLOWING",
      severity: "error",
      message: `This wallet already follows a ${followNow.kind === "Theme" ? "thesis" : "trader"}. One source per wallet: unfollow first, or use a dedicated wallet.`,
    });
  }
  if (balance !== undefined && balance < input.tank) {
    add({
      code: "INSUFFICIENT_BALANCE",
      severity: "error",
      field: "tank",
      required: input.tank,
      message: "The wallet holds less STT than the tank deposit, before any gas for the transactions.",
    });
  }
  if (account) {
    if (operatorApproved === undefined) {
      add({ code: "OPERATOR_NOT_APPROVED", severity: "warning", message: "Could not read the operator approval; the follow flow will check it again before signing." });
    } else if (!operatorApproved) {
      add({ code: "OPERATOR_NOT_APPROVED", severity: "info", message: "The hub needs a one-time approval to place orders in this wallet's account. It is the first transaction of the flow." });
    }
    approved = operatorApproved === true;
  }

  // source and markets
  if (kind === "Theme") {
    const id = typeof input.source === "bigint" ? input.source : undefined;
    const count = await reads.themeCount(c);
    if (id === undefined || id === 0n || id > count) {
      add({ code: "INVALID_SOURCE", severity: "error", message: "That thesis does not exist." });
    } else {
      const theme = await reads.themeOf(c, id);
      const markets = new Map<string, Market>();
      await Promise.all(
        theme.legs.map(async (l) => {
          try {
            const m = await readMarket(c.publicClient, l.pool);
            if (isTradeable(m)) markets.set(l.pool.toLowerCase(), m);
            else add({ code: "UNKNOWN_MARKET", severity: "error", pool: l.pool, message: "A leg's market reports no usable mark price; the basket cannot open right now." });
          } catch {
            add({ code: "UNKNOWN_MARKET", severity: "error", pool: l.pool, message: "A leg's market could not be read; the basket cannot open right now." });
          }
        }),
      );
      if (markets.size === theme.legs.length) {
        const min = minThemeAllocation(theme.legs, markets);
        themeMinimum = { ...min, recommendedAllocation: withHeadroom(min.allocation) };
        const huge = 2n ** 200n;
        let basketNotional = 0n;
        for (const leg of theme.legs) {
          const m = markets.get(leg.pool.toLowerCase())!;
          const pl = min.perLeg.find((p) => p.pool === leg.pool)!;
          const free = simulateLeg(policy.allocation, leg, huge, m);
          if (!free.opens) {
            add({
              code: "ALLOCATION_BELOW_MINIMUM",
              severity: "error",
              field: "allocation",
              pool: leg.pool,
              required: min.allocation,
              message: `The allocation is too small for this leg: it would size below the market's minimum order. The basket opens all legs or none, so the whole follow would be refused. Minimum allocation at today's marks: ${usdUp(min.allocation)} USD.`,
            });
            continue;
          }
          const capped = simulateLeg(policy.allocation, leg, policy.maxNotional, m);
          if (!capped.opens) {
            add({
              code: "CAP_BELOW_ONE_ORDER",
              severity: "error",
              field: "maxNotional",
              pool: leg.pool,
              required: pl.minMaxNotional,
              message: "The per-position cap is below the size of one order in this market, so the leg could never open and the basket would be held back.",
            });
            continue;
          }
          basketNotional += notionalOf(capped.tradable, m);
        }
        if (policy.maxTotalNotional > 0n && basketNotional > policy.maxTotalNotional) {
          add({
            code: "TOTAL_CAP_BELOW_BASKET",
            severity: "error",
            field: "maxTotalNotional",
            required: basketNotional,
            message: "The whole-book cap is below the basket's total notional, so the opening would be refused.",
          });
        }
      }
    }
  } else {
    const trader = typeof input.source === "string" && isAddress(input.source) ? getAddress(input.source) : undefined;
    if (!trader || /^0x0+$/.test(trader) || (account && trader === account)) {
      add({ code: "INVALID_SOURCE", severity: "error", message: "Pick another trader: it must be a real address and not the follower's own." });
    } else {
      if (joinPools.length === 0) {
        add({
          code: "ALLOW_ALL_MIRRORS_OPEN_BOOK",
          severity: "info",
          message: "With no market list the follow mirrors the trader's whole book, including positions already open, and manages every market the trader trades.",
        });
      }
      const [verdict, guardOn] = await Promise.all([
        reads.verdictOf(c, trader),
        input.guardOn !== undefined ? Promise.resolve(input.guardOn) : account ? reads.guardOf(c, account) : Promise.resolve(true),
      ]);
      if (verdict.blocking && guardOn) {
        add({
          code: "TRADER_BLOCKED",
          severity: "warning",
          message: "The AI risk review rates this trader Block. With the guard on, this wallet gets no new size from them until the verdict expires or the guard is turned off. Exits are still copied.",
        });
      }
      // a market list is checked as named; allowAll is checked in the markets the caller says the trader holds now
      const checked =
        joinPools.length > 0 ? joinPools : [...new Set((input.checkPools ?? []).filter((p) => isAddress(p, { strict: false })).map((p) => getAddress(p)))];
      const cap = policy.maxTotalNotional;
      // what syncing each checked market would open: the trader's size there, scaled, capped, in whole orders
      let opening = 0n;
      await Promise.all(
        checked.map(async (pool) => {
          let m: Market;
          try {
            m = await readMarket(c.publicClient, pool);
            if (!isTradeable(m)) throw new Error("unusable");
          } catch {
            add({ code: "UNKNOWN_MARKET", severity: "error", pool, message: "That market could not be read, so no order could be priced in it." });
            return;
          }
          const oneOrder = notionalOf(minOrderQty(m), m);
          if (policy.maxNotional > 0n && policy.maxNotional < oneOrder) {
            add({
              code: "CAP_BELOW_ONE_ORDER",
              severity: "error",
              field: "maxNotional",
              pool,
              required: (minOrderQty(m) * m.mark + m.oneBase - 1n) / m.oneBase,
              message: "The per-position cap is below the size of one order in this market, so increases there would always be refused.",
            });
          }
          const oneOrderUp = (minOrderQty(m) * m.mark + m.oneBase - 1n) / m.oneBase;
          if (cap > 0n && cap < oneOrderUp) {
            add({
              code: "TOTAL_CAP_BELOW_ONE_ORDER",
              severity: "error",
              field: "maxTotalNotional",
              pool,
              required: oneOrderUp,
              message: "The whole-book cap is below the size of one order in this market, so increases there would always be refused (Total cap).",
            });
          }
          const source = await reads.positionSize(c, trader, pool).catch(() => 0n);
          const scaled = scaledSize(source, policy.scaleBps);
          let target = abs(scaled);
          if (notionalOf(target, m) > policy.maxNotional && policy.maxNotional > 0n) target = (policy.maxNotional * m.oneBase) / m.mark;
          opening += notionalOf(tradableQty(target, m), m);
          if (source !== 0n && tradableQty(abs(scaled), m) === 0n) {
            add({
              code: "SCALED_BELOW_MINIMUM",
              severity: "warning",
              pool,
              message: "At this scale the trader's current position here rounds below the market's minimum order, so it would not be copied.",
            });
          }
        }),
      );
      if (cap > 0n && opening > cap) {
        add(
          joinPools.length > 0
            ? {
                code: "TOTAL_CAP_BELOW_BASKET",
                severity: "error",
                field: "maxTotalNotional",
                required: opening,
                message:
                  "The whole-book cap is below what the follow transaction opens in the listed markets (the trader's positions there, scaled and capped), so the last of them would be refused (Total cap).",
              }
            : {
                code: "TOTAL_CAP_BELOW_BASKET",
                severity: "warning",
                field: "maxTotalNotional",
                required: opening,
                message: "The whole-book cap is below the trader's current book scaled to your size, so part of it will be refused (Total cap) as the trader moves.",
              },
        );
      }
    }
  }

  // equity floor
  if (account && policy.equityFloor > 0n) {
    try {
      const equity = await reads.accountEquity(c, account);
      if (equity < policy.equityFloor) {
        add({
          code: "EQUITY_BELOW_FLOOR",
          severity: "error",
          field: "equityFloor",
          required: equity,
          message: "The account's equity is already below the equity floor, so the follow would stop and refuse every increase.",
        });
      }
    } catch {
      add({ code: "EQUITY_UNREADABLE", severity: "warning", message: "Could not read the account's equity to check the equity floor." });
    }
  }

  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    ok: !reasons.some((r) => r.severity === "error"),
    reasons,
    steps: [
      { id: "approveOperator", done: approved },
      { id: "follow", done: followNow !== null && followNow !== undefined },
    ],
    themeMinimum,
  };
}

const abs = (x: bigint) => (x < 0n ? -x : x);

/** An 18-decimal USD amount in dollars and cents, rounded up: a minimum is never understated. */
function usdUp(x: bigint): string {
  const cents = (x + 10n ** 16n - 1n) / 10n ** 16n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

import { getAddress, hexToBigInt, keccak256, encodeAbiParameters, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { gateAbi } from "./abi/gate.ts";
import { hubAbi } from "./abi/hub.ts";
import { themesAbi } from "./abi/themes.ts";
import { PLACE_ORDER_FOR_SELECTOR } from "./constants.ts";
import {
  SOURCE_KINDS,
  TIERS,
  type Deployments,
  type Follow,
  type GasParams,
  type Leg,
  type Pending,
  type ReviewPending,
  type SourceKindName,
  type Theme,
  type ThemeSync,
  type Verdict,
} from "./types.ts";

/** Everything a read needs: a public client on the Copybook chain and the deployments. */
export interface ReadContext {
  publicClient: PublicClient;
  deployments: Deployments;
}

const bankAbi = parseAbi([
  "function getPosition(address account, address pool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
]);
const registryAbi = parseAbi([
  "function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)",
]);

const ZERO32: Hex = `0x${"0".repeat(64)}`;
const kindIndex = (k: SourceKindName) => SOURCE_KINDS.indexOf(k);

/** The hub's id for a source: keccak256(abi.encode(kind, ref)). Pure, no call. */
export function sourceIdOf(kind: SourceKindName, ref: bigint | Address): Hex {
  const r = typeof ref === "bigint" ? ref : hexToBigInt(ref);
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [kindIndex(kind), r]));
}

const hub = (c: ReadContext) => ({ address: c.deployments.hub, abi: hubAbi }) as const;
const themes = (c: ReadContext) => ({ address: c.deployments.themes, abi: themesAbi }) as const;
const gate = (c: ReadContext) => ({ address: c.deployments.gate, abi: gateAbi }) as const;

/** The follower's follow, or null when the wallet follows nothing. */
export async function followOf(c: ReadContext, follower: Address): Promise<Follow | null> {
  const r = await c.publicClient.readContract({ ...hub(c), functionName: "followOf", args: [follower] });
  const [sourceId, kind, ref, policy, paused, group] = r;
  if (sourceId === ZERO32) return null;
  const kindName = SOURCE_KINDS[kind] ?? "Trader";
  return {
    follower: getAddress(follower),
    sourceId,
    kind: kindName,
    ref,
    trader: kindName === "Trader" ? getAddress(`0x${ref.toString(16).padStart(40, "0")}`) : undefined,
    themeId: kindName === "Theme" ? ref : undefined,
    policy: {
      scaleBps: policy.scaleBps,
      allocation: policy.allocation,
      maxNotional: policy.maxNotional,
      maxTotalNotional: policy.maxTotalNotional,
      bandBps: policy.bandBps,
      equityFloor: policy.equityFloor,
    },
    paused,
    group,
  };
}

export const tankOf = (c: ReadContext, who: Address): Promise<bigint> =>
  c.publicClient.readContract({ ...hub(c), functionName: "tankOf", args: [who] });

export async function syncedPools(c: ReadContext, follower: Address): Promise<Address[]> {
  return [...(await c.publicClient.readContract({ ...hub(c), functionName: "syncedPools", args: [follower] }))];
}

export async function pendingOf(c: ReadContext, follower: Address): Promise<Pending> {
  const [exitPending, flattenPending] = await c.publicClient.readContract({ ...hub(c), functionName: "pendingOf", args: [follower] });
  return { exitPending, flattenPending };
}

/** The follower's seat in its source's groups: which group's relay delivers to it, and its index in that group's list. */
export async function seatOf(c: ReadContext, follower: Address): Promise<{ group: number; index: number }> {
  const [group, index] = await c.publicClient.readContract({ ...hub(c), functionName: "seatOf", args: [follower] });
  return { group: Number(group), index: Number(index) };
}

export async function themeSyncOf(c: ReadContext, follower: Address): Promise<ThemeSync> {
  const [syncedVersion, lastSyncComplete] = await c.publicClient.readContract({ ...hub(c), functionName: "themeSyncOf", args: [follower] });
  return { syncedVersion, lastSyncComplete };
}

export async function gasParams(c: ReadContext): Promise<GasParams> {
  const [floor, perFollowerCap, themePerFollowerCap, tailBase, perDefer, chargeOverhead, riskGateGas] = await c.publicClient.readContract({
    ...hub(c),
    functionName: "gasParams",
  });
  return { floor, perFollowerCap, themePerFollowerCap, tailBase, perDefer, chargeOverhead, riskGateGas };
}

export const followsPaused = (c: ReadContext): Promise<boolean> => c.publicClient.readContract({ ...hub(c), functionName: "followsPaused" });

export const themeCount = (c: ReadContext): Promise<bigint> => c.publicClient.readContract({ ...themes(c), functionName: "themeCount" });

export async function themeOf(c: ReadContext, id: bigint): Promise<Theme> {
  const [meta, legs] = await Promise.all([
    c.publicClient.readContract({ ...themes(c), functionName: "themeOf", args: [id] }),
    c.publicClient.readContract({ ...themes(c), functionName: "legsOf", args: [id] }),
  ]);
  const [creator, name, uri, version] = meta;
  return { id, creator, name, uri, version, legs: legs.map((l): Leg => ({ pool: l.pool, weightBps: l.weightBps })) };
}

/** Every theme, oldest first. One read per theme: fine for a registry this size, page it if it grows. */
export async function listThemes(c: ReadContext): Promise<Theme[]> {
  const n = await themeCount(c);
  const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));
  return Promise.all(ids.map((id) => themeOf(c, id)));
}

const VERDICT_TTL_SECONDS = 7 * 24 * 3600;
const PENDING_TIMEOUT_SECONDS = 30 * 60;

export async function verdictOf(c: ReadContext, trader: Address, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<Verdict> {
  const v = await c.publicClient.readContract({ ...gate(c), functionName: "verdictOf", args: [trader] });
  const tier = TIERS[v.tier] ?? "None";
  const reviewedAt = Number(v.reviewedAt);
  const blockExpiresAt = tier === "Block" ? reviewedAt + VERDICT_TTL_SECONDS : undefined;
  return {
    tier,
    reviewedAt,
    shannonRequestId: v.shannonRequestId,
    summaryHash: v.summaryHash,
    blocking: blockExpiresAt !== undefined && nowSeconds <= blockExpiresAt,
    blockExpiresAt,
  };
}

/** Whether the follower's AI guard is on (the default for every wallet). */
export const guardOf = (c: ReadContext, follower: Address): Promise<boolean> =>
  c.publicClient.readContract({ ...gate(c), functionName: "guardOf", args: [follower] });

export async function reviewPendingOf(
  c: ReadContext,
  trader: Address,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ReviewPending | null> {
  const p = await c.publicClient.readContract({ ...gate(c), functionName: "pendingOf", args: [trader] });
  if (p.nonce === 0n) return null;
  const requestedAt = Number(p.requestedAt);
  return { nonce: BigInt(p.nonce), requestedAt, replaceable: nowSeconds >= requestedAt + PENDING_TIMEOUT_SECONDS };
}

export const reviewFee = (c: ReadContext): Promise<bigint> => c.publicClient.readContract({ ...gate(c), functionName: "reviewFee" });

export async function positionSize(c: ReadContext, account: Address, pool: Address): Promise<bigint> {
  const p = await c.publicClient.readContract({
    address: c.deployments.marginBank,
    abi: bankAbi,
    functionName: "getPosition",
    args: [account, pool],
  });
  return BigInt(p.size);
}

/** A perp position as the margin bank holds it: signed size in base units and the average entry price (18 decimals). */
export interface PerpPosition {
  size: bigint;
  avgEntryPrice: bigint;
}

export async function position(c: ReadContext, account: Address, pool: Address): Promise<PerpPosition> {
  const p = await c.publicClient.readContract({
    address: c.deployments.marginBank,
    abi: bankAbi,
    functionName: "getPosition",
    args: [account, pool],
  });
  return { size: BigInt(p.size), avgEntryPrice: BigInt(p.avgEntryPrice) };
}

export async function accountEquity(c: ReadContext, account: Address): Promise<bigint> {
  const [equity] = await c.publicClient.readContract({
    address: c.deployments.marginBank,
    abi: bankAbi,
    functionName: "getAccountHealth",
    args: [account],
  });
  return equity;
}

/**
 * The margin bank's slice that funds a perps account. The bank has no bare collateral getter: dreamDEX's SDK
 * (`@somnia-chain/markets-sdk` 0.32.1, `bankCollateral` in writer.ts) reads it from `getSystemConfig`, and its
 * `depositMargin` (perp/margin.ts) is an ERC-20 `approve` of the bank followed by `deposit(amount)` on the bank,
 * which pulls the tokens from the wallet. The e2e run funds fresh wallets this way (e2e/src/live.ts, `setup`).
 */
export const marginBankFundingAbi = parseAbi([
  "function getSystemConfig() view returns ((address marginBank, address collateralToken, address perpPoolFactory, address liquidationEngine, address insuranceFund, address feeRecipient, uint16 maxLeverageLimit, bool fullyWired))",
  "function deposit(uint256 amount)",
]);
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// the bank's collateral is fixed at its deployment, so one read per bank and public client is enough
const collateralCache = new WeakMap<object, Map<string, Promise<Address>>>();

/** USDso: the token the margin bank takes as collateral, read from the bank itself (`getSystemConfig`). */
export function marginToken(c: ReadContext): Promise<Address> {
  let byBank = collateralCache.get(c.publicClient);
  if (!byBank) collateralCache.set(c.publicClient, (byBank = new Map()));
  const key = c.deployments.marginBank.toLowerCase();
  let hit = byBank.get(key);
  if (!hit) {
    hit = c.publicClient
      .readContract({ address: c.deployments.marginBank, abi: marginBankFundingAbi, functionName: "getSystemConfig" })
      .then((cfg) => getAddress(cfg.collateralToken));
    // a failed read is not remembered: the next call asks the bank again
    hit.catch(() => byBank!.delete(key));
    byBank.set(key, hit);
  }
  return hit;
}

/** What a wallet needs to move USDso into its perps account: the token, the USDso it holds on spot, and the bank's allowance. */
export interface MarginFunding {
  token: Address;
  /** USDso in the wallet itself (18 decimals), outside the perps account. */
  spot: bigint;
  /** How much USDso the margin bank may pull from the wallet. */
  allowance: bigint;
}

export async function spotUsdsoBalance(c: ReadContext, account: Address): Promise<bigint> {
  const token = await marginToken(c);
  return c.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
}

export async function marginAllowance(c: ReadContext, account: Address): Promise<bigint> {
  const token = await marginToken(c);
  return c.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, c.deployments.marginBank] });
}

export async function marginFunding(c: ReadContext, account: Address): Promise<MarginFunding> {
  const token = await marginToken(c);
  const [spot, allowance] = await Promise.all([
    c.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    c.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, c.deployments.marginBank] }),
  ]);
  return { token, spot, allowance };
}

/** Whether the follower has granted the hub the global `placeOrderFor` approval the perps honour. */
export const isOperatorApproved = (c: ReadContext, owner: Address): Promise<boolean> =>
  c.publicClient.readContract({
    address: c.deployments.operatorRegistry,
    abi: registryAbi,
    functionName: "isGloballyApproved",
    args: [owner, c.deployments.hub, PLACE_ORDER_FOR_SELECTOR],
  });

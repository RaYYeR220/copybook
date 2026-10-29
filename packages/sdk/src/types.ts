import type { Address, Hex } from "viem";

/** Mirrors `SourceKind` in Types.sol. */
export const SOURCE_KINDS = ["Trader", "Theme"] as const;
export type SourceKindName = (typeof SOURCE_KINDS)[number];

/** Mirrors `Reason` in Types.sol, in enum order. */
export const REASONS = [
  "None",
  "Paused",
  "MarketNotAllowed",
  "TotalCap",
  "EquityFloor",
  "TankEmpty",
  "RiskGate",
  "BandUnfilled",
  "VenueRejected",
  "LegFailed",
  "BelowMinimum",
  "AtCap",
] as const;
export type ReasonName = (typeof REASONS)[number];

/** Mirrors `Tier` in RiskTypes.sol. */
export const TIERS = ["None", "Ok", "Caution", "Block"] as const;
export type TierName = (typeof TIERS)[number];

/** A follower's policy. Money fields are 18-decimal USD amounts, like the venue's prices. */
export interface Policy {
  /** Trader follows: size multiplier in bps (10_000 = 1x, at most 100_000). */
  scaleBps: number;
  /** Theme follows: USD notional the basket weights are applied to. */
  allocation: bigint;
  /** Largest notional of any one position the hub may build for this follower. */
  maxNotional: bigint;
  /** Largest notional of the whole book (0 = no cap). */
  maxTotalNotional: bigint;
  /** How far inside the mark an increase may be priced, in bps (1 to 500). */
  bandBps: number;
  /** Below this equity the follow stops and closes (0 = off). */
  equityFloor: bigint;
}

export interface Leg {
  pool: Address;
  /** Signed share of the allocation in bps; negative is short. */
  weightBps: number;
}

export interface Follow {
  follower: Address;
  sourceId: Hex;
  kind: SourceKindName;
  /** The trader's address as an integer (trader follows) or the theme id (theme follows). */
  ref: bigint;
  /** Set for trader follows. */
  trader?: Address;
  /** Set for theme follows. */
  themeId?: bigint;
  policy: Policy;
  paused: boolean;
  group: number;
}

export interface Pending {
  /** The handler ran out of gas on this follow's exits: `catchUp` (or `resync`) finishes them. */
  exitPending: boolean;
  /** A stop's closes did not all run: `poke` finishes them, and `resume` waits for it. */
  flattenPending: boolean;
}

export interface ThemeSync {
  syncedVersion: number;
  lastSyncComplete: boolean;
}

export interface Theme {
  id: bigint;
  creator: Address;
  name: string;
  uri: string;
  version: number;
  legs: Leg[];
}

export interface Verdict {
  tier: TierName;
  /** Unix seconds of the review, 0 if the trader was never reviewed. */
  reviewedAt: number;
  shannonRequestId: bigint;
  summaryHash: Hex;
  /** True while a Block verdict is inside its TTL: guarded followers get no new size from this trader. */
  blocking: boolean;
  /** Unix seconds when a Block stops blocking; set only for the Block tier. */
  blockExpiresAt?: number;
}

export interface ReviewPending {
  nonce: bigint;
  requestedAt: number;
  /** True when no answer came within PENDING_TIMEOUT, so a new request may replace it. */
  replaceable: boolean;
}

export interface GasParams {
  floor: bigint;
  perFollowerCap: bigint;
  themePerFollowerCap: bigint;
  tailBase: bigint;
  perDefer: bigint;
  chargeOverhead: bigint;
  riskGateGas: bigint;
}

export interface Market {
  pool: Address;
  /** Mark price, 18 decimals. */
  mark: bigint;
  tick: bigint;
  /** Smallest order the venue takes, in base units. */
  minQty: bigint;
  /** Order sizes are whole multiples of this. */
  lot: bigint;
  /** 10^decimals of the base asset. */
  oneBase: bigint;
}

export interface Deployments {
  chainId: number;
  hub: Address;
  engine: Address;
  themes: Address;
  marginBank: Address;
  gate: Address;
  groupSize: number;
  deployBlock: bigint;
  /** The venue's operator registry; defaults to the Hideki2 one. */
  operatorRegistry: Address;
  /** Every wallet Copybook itself controls (the owner, the demo leader, demo followers…) with its role. */
  demoWallets: readonly DemoWallet[];
}

/** A wallet run by Copybook, never a user: listed so the app and tools can label it and leave it out of rankings. */
export interface DemoWallet {
  address: Address;
  /** What it does: "owner", "demo leader", "demo follower", … */
  role: string;
}

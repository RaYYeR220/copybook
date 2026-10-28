import type { Hex } from "viem";

/** Basis-point denominator used by every policy and weight. */
export const BPS = 10_000n;
/** The hub refuses a follow funded with less than this (STT, 18 decimals). */
export const MIN_TANK = 200_000_000_000_000_000n;
/** Below this tank balance every increase is refused (Reason.TankEmpty); exits still run. */
export const MIN_TANK_FOR_INCREASE = 20_000_000_000_000_000n;
/** A trader follow may name at most this many markets to manage. */
export const MAX_JOIN_POOLS = 32;
/** Longest a copied order rests on the book, in seconds. */
export const ORDER_TTL_SECONDS = 60;
/** A theme leg within this share of its target is left alone on a resync. */
export const THEME_DRIFT_BPS = 500;
/** Selector of `placeOrderFor`, the one call the hub makes on a follower's behalf. */
export const PLACE_ORDER_FOR_SELECTOR: Hex = "0x80054449";
/**
 * dreamDEX's OperatorPermissionsRegistry on Hideki2. It belongs to the venue, not to Copybook, so it is not in
 * `deployments/hideki.json`; set `operatorRegistry` there to override it if the venue ever moves it.
 * Perps honour a global grant to the hub for `placeOrderFor`.
 */
export const DEFAULT_OPERATOR_REGISTRY = "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a" as const;
/** Somnia gas estimates run low for handler-heavy calls; writes send this multiple of the node estimate. */
export const GAS_HEADROOM_NUM = 3n;
export const GAS_HEADROOM_DEN = 2n;
/** Ceiling for a transaction's gas limit. */
export const MAX_TX_GAS = 300_000_000n;

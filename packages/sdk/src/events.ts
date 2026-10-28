import { decodeEventLog, getAddress, type Abi, type Address, type Hex } from "viem";
import { gateAbi } from "./abi/gate.ts";
import { hubAbi } from "./abi/hub.ts";
import { themesAbi } from "./abi/themes.ts";
import { REASONS, SOURCE_KINDS, TIERS, type Deployments, type ReasonName, type SourceKindName, type TierName } from "./types.ts";

/** Where a decoded event sits on chain. Absent fields mean the event came from a live notification. */
export interface LogMeta {
  address: Address;
  blockNumber?: bigint;
  transactionHash?: Hex;
  transactionIndex?: number;
  logIndex?: number;
  /** The raw log, kept so an event can be matched to the same log seen through another channel. */
  topics: readonly Hex[];
  data: Hex;
}

/** A raw log as `eth_getLogs`, a receipt or a `somnia_watch` notification delivers it. */
export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber?: bigint | null;
  transactionHash?: Hex | null;
  transactionIndex?: number | null;
  logIndex?: number | null;
}

export type CopybookEventBody =
  | { name: "Followed"; follower: Address; sourceId: Hex; kind: SourceKindName; ref: bigint }
  | { name: "Unfollowed"; follower: Address; sourceId: Hex; flattened: boolean }
  | { name: "PolicyUpdated"; follower: Address }
  | { name: "Resumed"; follower: Address }
  | {
      name: "Copied";
      follower: Address;
      sourceId: Hex;
      pool: Address;
      fromSize: bigint;
      toSize: bigint;
      /** The limit price of the order that moved the position (its band edge), not the fill price. */
      limitPrice: bigint;
      capped: boolean;
    }
  | { name: "Refused"; follower: Address; sourceId: Hex; pool: Address; reason: ReasonName; venueError: Hex }
  | { name: "Stopped"; follower: Address; equity: bigint }
  | { name: "TankCharged"; follower: Address; amount: bigint }
  | { name: "Deferred"; follower: Address; sourceId: Hex }
  | { name: "GroupDeferred"; sourceId: Hex; group: number; fromIndex: bigint }
  | { name: "FlattenIncomplete"; follower: Address; pool: Address }
  | { name: "GroupOpened"; sourceId: Hex; group: number; relay: Address; subscriptionId: bigint }
  | { name: "GroupClosed"; sourceId: Hex; group: number; subscriptionId: bigint; cancelled: boolean }
  | { name: "ThemeCreated"; themeId: bigint; creator: Address; themeName: string }
  | { name: "ThemeRebalanced"; themeId: bigint; version: number }
  | { name: "ReviewRequested"; trader: Address; nonce: bigint; requester: Address }
  | {
      name: "VerdictReceived";
      sourceId: Hex;
      trader: Address;
      tier: TierName;
      shannonRequestId: bigint;
      summaryHash: Hex;
    }
  | { name: "ReviewFailed"; trader: Address; nonce: bigint }
  | { name: "StaleVerdict"; trader: Address; nonce: bigint }
  | { name: "BlockHeld"; sourceId: Hex; trader: Address; newTier: TierName; nonce: bigint }
  | { name: "GuardSet"; follower: Address; on: boolean }
  // Owner-side configuration events: decoded by name with their raw arguments.
  | { name: "Admin"; event: string; args: Record<string, unknown> };

/** A decoded Copybook event with where it was logged. */
export type CopybookEvent = CopybookEventBody & { log: LogMeta };

type Args = Record<string, unknown>;

const reason = (v: unknown): ReasonName => REASONS[Number(v)] ?? "None";
const kind = (v: unknown): SourceKindName => SOURCE_KINDS[Number(v)] ?? "Trader";
const tier = (v: unknown): TierName => TIERS[Number(v)] ?? "None";

const ADMIN = new Set([
  "RiskGateSet",
  "SubParamsSet",
  "GasParamsSet",
  "NewFollowsPaused",
  "SurplusWithdrawn",
  "OrphanCancelled",
  "ReviewerSet",
  "ReviewFeeSet",
  "Withdrawn",
]);

function shape(eventName: string, a: Args): CopybookEventBody | undefined {
  switch (eventName) {
    case "Followed":
      return { name: "Followed", follower: a.follower as Address, sourceId: a.sourceId as Hex, kind: kind(a.kind), ref: a.ref as bigint };
    case "Unfollowed":
      return { name: "Unfollowed", follower: a.follower as Address, sourceId: a.sourceId as Hex, flattened: a.flattened as boolean };
    case "PolicyUpdated":
    case "Resumed":
      return { name: eventName, follower: a.follower as Address };
    case "Copied":
      return {
        name: "Copied",
        follower: a.follower as Address,
        sourceId: a.sourceId as Hex,
        pool: a.pool as Address,
        fromSize: a.fromSize as bigint,
        toSize: a.toSize as bigint,
        limitPrice: a.price as bigint,
        capped: a.capped as boolean,
      };
    case "Refused":
      return {
        name: "Refused",
        follower: a.follower as Address,
        sourceId: a.sourceId as Hex,
        pool: a.pool as Address,
        reason: reason(a.reason),
        venueError: a.venueError as Hex,
      };
    case "Stopped":
      return { name: "Stopped", follower: a.follower as Address, equity: a.equity as bigint };
    case "TankCharged":
      return { name: "TankCharged", follower: a.follower as Address, amount: a.amount as bigint };
    case "Deferred":
      return { name: "Deferred", follower: a.follower as Address, sourceId: a.sourceId as Hex };
    case "GroupDeferred":
      return { name: "GroupDeferred", sourceId: a.sourceId as Hex, group: Number(a.group), fromIndex: a.fromIndex as bigint };
    case "FlattenIncomplete":
      return { name: "FlattenIncomplete", follower: a.follower as Address, pool: a.pool as Address };
    case "GroupOpened":
      return {
        name: "GroupOpened",
        sourceId: a.sourceId as Hex,
        group: Number(a.group),
        relay: a.relay as Address,
        subscriptionId: a.subscriptionId as bigint,
      };
    case "GroupClosed":
      return {
        name: "GroupClosed",
        sourceId: a.sourceId as Hex,
        group: Number(a.group),
        subscriptionId: a.subscriptionId as bigint,
        cancelled: a.cancelled as boolean,
      };
    case "ThemeCreated":
      return { name: "ThemeCreated", themeId: a.themeId as bigint, creator: a.creator as Address, themeName: a.name as string };
    case "ThemeRebalanced":
      return { name: "ThemeRebalanced", themeId: a.themeId as bigint, version: Number(a.version) };
    case "ReviewRequested":
      return { name: "ReviewRequested", trader: a.trader as Address, nonce: BigInt(a.nonce as bigint), requester: a.requester as Address };
    case "VerdictReceived":
      return {
        name: "VerdictReceived",
        sourceId: a.sourceId as Hex,
        trader: a.trader as Address,
        tier: tier(a.tier),
        shannonRequestId: a.shannonRequestId as bigint,
        summaryHash: a.summaryHash as Hex,
      };
    case "ReviewFailed":
    case "StaleVerdict":
      return { name: eventName, trader: a.trader as Address, nonce: BigInt(a.nonce as bigint) };
    case "BlockHeld":
      return { name: "BlockHeld", sourceId: a.sourceId as Hex, trader: a.trader as Address, newTier: tier(a.newTier), nonce: BigInt(a.nonce as bigint) };
    case "GuardSet":
      return { name: "GuardSet", follower: a.follower as Address, on: a.on as boolean };
    default:
      return ADMIN.has(eventName) ? { name: "Admin", event: eventName, args: a } : undefined;
  }
}

function tryDecode(abi: Abi, log: RawLog): { eventName: string; args: Args } | undefined {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as {
      eventName: string;
      args?: Args;
    };
    return { eventName: d.eventName, args: (d.args ?? {}) as Args };
  } catch {
    return undefined;
  }
}

/**
 * Decodes one log emitted by the hub, the risk gate or the theme registry into a typed event.
 * Returns undefined for logs from other contracts or events the SDK does not model (ownership transfers).
 */
export function decodeCopybookLog(log: RawLog, deployments: Pick<Deployments, "hub" | "gate" | "themes">): CopybookEvent | undefined {
  const from = getAddress(log.address);
  const abi: Abi | undefined =
    from === deployments.hub ? (hubAbi as Abi) : from === deployments.gate ? (gateAbi as Abi) : from === deployments.themes ? (themesAbi as Abi) : undefined;
  if (!abi) return undefined;
  const d = tryDecode(abi, log);
  if (!d) return undefined;
  const e = shape(d.eventName, d.args);
  if (!e) return undefined;
  return {
    ...e,
    log: {
      address: from,
      blockNumber: log.blockNumber ?? undefined,
      transactionHash: log.transactionHash ?? undefined,
      transactionIndex: log.transactionIndex ?? undefined,
      logIndex: log.logIndex ?? undefined,
      topics: log.topics,
      data: log.data,
    },
  } as CopybookEvent;
}

/** Decodes every Copybook log in a list (a receipt's logs, a getLogs result), skipping the rest. */
export function decodeCopybookLogs(logs: readonly RawLog[], deployments: Pick<Deployments, "hub" | "gate" | "themes">): CopybookEvent[] {
  const out: CopybookEvent[] = [];
  for (const l of logs) {
    const e = decodeCopybookLog(l, deployments);
    if (e) out.push(e);
  }
  return out;
}

/** The follower an event is about, when it names one. */
export function eventFollower(e: CopybookEvent): Address | undefined {
  return "follower" in e ? e.follower : undefined;
}

import type { Address } from "viem";
import type { Deployments } from "@copybook/sdk";
import { fromJsonSafe } from "./json";

/** The gate's timing rules, in seconds, as deployed (read from `deployments/risk.json`). */
export interface RiskParams {
  verdictTtlSeconds: number;
  blockHoldSeconds: number;
  reviewCooldownSeconds: number;
  pendingTimeoutSeconds: number;
}

/**
 * What a client component needs to talk to the contracts. Built on the server from `deployments/*.json` and handed
 * down as props, so the browser bundle never carries the deployment records themselves.
 */
export interface PublicConfig {
  /** `Deployments`, JSON-safe (see `lib/json`). */
  deployments: unknown;
  risk: RiskParams;
  shannonExplorer: string;
  /** The reviewer contract's page on the Shannon explorer. */
  reviewerUrl: string;
  committee: { size: number; threshold: number };
  demoLeader: Address;
}

export const deploymentsOf = (pub: PublicConfig): Deployments => fromJsonSafe<Deployments>(pub.deployments);

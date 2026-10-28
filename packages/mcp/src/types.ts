import type { Copybook } from "@copybook/sdk";
import type { getTraderStats, riskSummary, topTraders } from "@copybook/stats";
import type { Address } from "viem";
import type { ZodRawShape } from "zod";

export interface StatsApi {
  getTraderStats: typeof getTraderStats;
  topTraders: typeof topTraders;
  riskSummary: typeof riskSummary;
}

export interface Deps {
  /** SDK client. Its wallet, if any, is the agent's own. */
  copybook: Copybook;
  stats: StatsApi;
  /** Set only when `COPYBOOK_AGENT_KEY` was given: the agent's own wallet. Write tools refuse without it. */
  agent?: Address;
  /** Wallets never listed as top traders (the hub, the agent itself). */
  exclude?: Address[];
  /** Strings scrubbed from every error and log line: endpoint URLs (they may carry API keys) and the agent key. */
  secrets?: string[];
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  /** Sends transactions (when `dryRun` is false). Registered only when an agent key is configured. */
  write: boolean;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

/** A refusal is an answer, not a crash: it carries the reasons so the agent can fix the input and retry. */
export class Refusal extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

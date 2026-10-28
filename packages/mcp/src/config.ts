import { createPublicClient, createWalletClient, defineChain, http, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCopybook } from "@copybook/sdk";
import { loadDeployments } from "@copybook/sdk/node";
import * as stats from "@copybook/stats";
import { fileURLToPath } from "node:url";
import type { Deps } from "./types.ts";

export const DEFAULT_RPC = "https://api.hideki2.infra.testnet.somnia.network";

/** The startup line: public facts only, never the key. */
export function banner(deps: Pick<Deps, "agent">): string {
  return deps.agent
    ? `copybook-mcp ready: read + write tools (dry-run by default) for agent wallet ${deps.agent}`
    : "copybook-mcp ready: read tools only (set COPYBOOK_AGENT_KEY to enable write tools)";
}

export interface Env {
  COPYBOOK_AGENT_KEY?: string;
  COPYBOOK_RPC_URL?: string;
  COPYBOOK_DEPLOYMENTS_DIR?: string;
  COPYBOOK_INDEXER_URL?: string;
}

/** Builds the dependencies from the environment. The key is read once here and never printed. */
export function depsFromEnv(env: Env = process.env as Env): Deps {
  const dir = env.COPYBOOK_DEPLOYMENTS_DIR ?? fileURLToPath(new URL("../../../deployments", import.meta.url));
  const deployments = loadDeployments(dir);
  const rpc = env.COPYBOOK_RPC_URL ?? DEFAULT_RPC;
  const chain = defineChain({
    id: deployments.chainId,
    name: "Somnia Hideki2 testnet",
    nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc, { retryCount: 3 }) });

  let agent: Address | undefined;
  let walletClient;
  const key = env.COPYBOOK_AGENT_KEY?.trim();
  if (key) {
    const hex = key.startsWith("0x") ? key : `0x${key}`;
    if (!isHex(hex) || hex.length !== 66) throw new Error("COPYBOOK_AGENT_KEY is not a 32-byte hex private key");
    const account = privateKeyToAccount(hex as Hex);
    agent = account.address;
    walletClient = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 3 }) });
  }

  const copybook = createCopybook({ publicClient: publicClient as never, walletClient, deployments });
  const indexerUrl = env.COPYBOOK_INDEXER_URL;
  const indexer = new stats.Indexer(indexerUrl ? { url: indexerUrl } : {});
  return {
    copybook,
    agent,
    secrets: [rpc, indexerUrl ?? "", key ?? "", key?.replace(/^0x/, "") ?? ""].filter(Boolean),
    stats: {
      getTraderStats: (trader, opts) => stats.getTraderStats(trader, { indexer, ...opts }),
      topTraders: (n, days, opts) => stats.topTraders(n, days, { indexer, ...opts }),
      riskSummary: stats.riskSummary,
    },
  };
}

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

export const RPC_URL = process.env.HIDEKI_RPC ?? "https://api.hideki2.infra.testnet.somnia.network";
export const INDEXER_URL = process.env.HIDEKI_INDEXER ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
export const EXPLORER_TX = "https://explorer.testnet.somnia.network/tokyo/tx/";
export const chain = hidekiTestnet;

export const MARGIN_BANK = "0x478769E1177C0773c43A593DCCc4Ad15F15F1394" as const;
export const OPERATOR_REGISTRY = "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a" as const;
export const USDSO = "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72" as const;
export const PLACE_ORDER_FOR = "0x80054449" as const;
export const REACTIVITY = "0x0000000000000000000000000000000000000100" as const;

/** Keys are read at runtime from the file named by COPYBOOK_ENV (KEY=VALUE lines); see .env.example. */
function loadEnv(): Record<string, string> {
  const path = process.env.COPYBOOK_ENV;
  if (!path) throw new Error("set COPYBOOK_ENV to the env file holding the wallet keys");
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export const env = loadEnv();

export type Role = "HUB_OWNER" | "LEADER" | "FOLLOWER" | "FOLLOWER2" | "FUNDER2";

export function account(role: Role): PrivateKeyAccount {
  const pk = env[`${role}_PK`];
  if (!pk) throw new Error(`missing ${role}_PK`);
  return privateKeyToAccount(pk as Hex);
}

const transport = () => http(RPC_URL, { retryCount: 6, retryDelay: 2_000, timeout: 60_000 });

export const pub: PublicClient = createPublicClient({ chain, transport: transport() }) as PublicClient;

export function wallet(role: Role) {
  return createWalletClient({ chain, transport: transport(), account: account(role) });
}

export function markets(role?: Role): SomniaMarkets {
  return new SomniaMarkets({
    chain,
    indexerUrl: INDEXER_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    ...(role ? { privateKey: env[`${role}_PK`] as Hex } : {}),
  } as never);
}

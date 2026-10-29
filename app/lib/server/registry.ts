import "server-only";
import { unstable_cache } from "next/cache";
import { getAddress, type Address } from "viem";
import { REGISTRY_SOURCE_RULES, type RegistryRules } from "../builder/basket";
import { bankRegistryAbi, readRegistryRules, registryAbi } from "../builder/registry";
import { publicClient } from "./chain";
import { config } from "./config";

const themes = config.deployments.themes;

/** The deployed registry's constants: fixed for its lifetime, so cached for good once read. */
const cachedRules = unstable_cache(() => readRegistryRules(publicClient, themes), ["registry-rules", themes.toLowerCase()], { revalidate: false });

/** The limits the registry enforces. When the chain does not answer, the values in ThemeRegistry.sol, said so. */
export async function registryRules(): Promise<{ rules: RegistryRules; from: "registry" | "source" }> {
  try {
    return { rules: await cachedRules(), from: "registry" };
  } catch {
    return { rules: REGISTRY_SOURCE_RULES, from: "source" };
  }
}

/** The margin bank the registry asks `isPerpPoolRegistered` (its immutable `marginBank`). */
export const registryBank: () => Promise<Address> = unstable_cache(
  async () => getAddress(await publicClient.readContract({ address: themes, abi: registryAbi, functionName: "marginBank" })),
  ["registry-bank", themes.toLowerCase()],
  { revalidate: false },
);

/**
 * `isPerpPoolRegistered` for each pool, as the registry would ask it (one hour cache). A pool whose read failed is
 * left out, so the builder reads it again in the browser instead of guessing.
 */
export async function registeredPools(pools: readonly string[]): Promise<Record<string, boolean>> {
  const sorted = [...new Set(pools.map((p) => p.toLowerCase()))].sort();
  return unstable_cache(
    async () => {
      const bank = await registryBank();
      const out: Record<string, boolean> = {};
      await Promise.all(
        sorted.map(async (p) => {
          try {
            out[p] = await publicClient.readContract({ address: bank, abi: bankRegistryAbi, functionName: "isPerpPoolRegistered", args: [p as Address] });
          } catch {
            /* left out: read again in the browser */
          }
        }),
      );
      return out;
    },
    ["registered-pools", themes.toLowerCase(), sorted.join(",")],
    { revalidate: 3600 },
  )();
}

import { numberToHex, type AddEthereumChainParameter, type Chain, type EIP1193Provider } from "viem";
import { hideki } from "./hideki";

/** The `wallet_addEthereumChain` parameters for a chain (EIP-3085). */
export function addChainParameters(chain: Chain = hideki): AddEthereumChainParameter {
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
    blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
  };
}

/**
 * Asks the wallet to add Hideki (and switch to it, which most wallets do on add).
 * Resolves `true` when the wallet accepted, `false` when the person declined; anything else throws.
 */
export async function addHidekiToWallet(provider: EIP1193Provider): Promise<boolean> {
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [addChainParameters(hideki)] });
    return true;
  } catch (err) {
    if (isUserRejection(err)) return false;
    throw err;
  }
}

/** EIP-1193 4001, or a wrapped viem `UserRejectedRequestError`. */
export function isUserRejection(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const o = e as { code?: unknown; name?: unknown; cause?: unknown };
    if (o.code === 4001 || o.name === "UserRejectedRequestError") return true;
    e = o.cause;
  }
  return false;
}

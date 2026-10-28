import { cookieStorage, createConfig, createStorage, http, injected } from "wagmi";
import { hideki } from "./hideki";

/**
 * Injected wallets only (MetaMask, Rabby and any EIP-6963 browser wallet), on Hideki only.
 * Cookie storage lets a server layout hand the connection state to the first render, so the page does not
 * flash "Connect" for a returning wallet.
 */
export function makeWagmiConfig() {
  return createConfig({
    chains: [hideki],
    connectors: [injected({ shimDisconnect: true })],
    multiInjectedProviderDiscovery: true,
    transports: { [hideki.id]: http() },
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
  });
}

export type WagmiConfig = ReturnType<typeof makeWagmiConfig>;

declare module "wagmi" {
  interface Register {
    config: WagmiConfig;
  }
}

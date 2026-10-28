"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider, type State } from "wagmi";
import { makeWagmiConfig } from "@/lib/wallet/config";

/** Wallet + query context for the app routes. The landing does not mount it. */
export function WalletProvider({ children, initialState }: { children: ReactNode; initialState?: State }) {
  const [config] = useState(makeWagmiConfig);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 4_000 } } }));
  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

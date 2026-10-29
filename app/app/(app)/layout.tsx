import { headers } from "next/headers";
import type { ReactNode } from "react";
import { cookieToInitialState } from "wagmi";
import { AppBar } from "@/components/AppBar";
import { WalletProvider } from "@/components/WalletProvider";
import { makeWagmiConfig } from "@/lib/wallet/config";
import styles from "./app.module.css";

const LINKS = [
  { href: "/app", label: "Discover" },
  { href: "/leaderboard", label: "Leaderboard", prefetch: false },
  { href: "/me", label: "Dashboard", prefetch: false },
];

/** Every app route lives at night, inside the double-rule frame, with the wallet in context. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const initialState = cookieToInitialState(makeWagmiConfig(), (await headers()).get("cookie"));
  return (
    <WalletProvider initialState={initialState}>
      <div className={`${styles.page} night`}>
        <div className={`tex ${styles.pools}`} aria-hidden="true" />
        <div className="tex dots" aria-hidden="true" />
        <div className={styles.frame} aria-hidden="true" />
        <AppBar links={LINKS} />
        {children}
        <div className={`tex grain grain-night ${styles.grain}`} aria-hidden="true" />
      </div>
    </WalletProvider>
  );
}

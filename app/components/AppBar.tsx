"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { Gull } from "./glyphs";
import type { NavLink } from "./Nav";
import styles from "./AppBar.module.css";

/** The app's top bar at night: wordmark, section pills (the current one outlined), and the wallet. */
export function AppBar({ links }: { links: NavLink[] }) {
  const path = usePathname();
  return (
    <header className={`${styles.bar} rise`}>
      <Link className={styles.mark} href="/" aria-label="Copybook home">
        <Gull className={styles.gull} />
        Copybook
      </Link>
      <nav className={styles.nav} aria-label="App">
        {links.map((l) => (
          <Link key={l.href} href={l.href} prefetch={l.prefetch} aria-current={path === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      <ConnectButton />
    </header>
  );
}

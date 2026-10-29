import Link from "next/link";
import type { ReactNode } from "react";
import { Gull } from "../glyphs";
import bar from "../AppBar.module.css";
import page from "../../app/(app)/app.module.css";

const LINKS = [
  { href: "/app", label: "Discover" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/me", label: "Dashboard" },
];

/**
 * The app's night frame and top bar without the wallet, for pages that render outside the app's layout: the site-wide
 * not-found and error pages.
 */
export function PlainShell({ children }: { children: ReactNode }) {
  return (
    <div className={`${page.page} night`}>
      <div className={`tex ${page.pools}`} aria-hidden="true" />
      <div className="tex dots" aria-hidden="true" />
      <div className={page.frame} aria-hidden="true" />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className={bar.bar}>
        <Link className={bar.mark} href="/" aria-label="Copybook home">
          <Gull className={bar.gull} />
          Copybook
        </Link>
        <nav className={bar.nav} aria-label="App">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} prefetch={false}>
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
      <div className={`tex grain grain-night ${page.grain}`} aria-hidden="true" />
    </div>
  );
}

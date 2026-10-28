import Link from "next/link";
import type { ReactNode } from "react";
import { Gull } from "./glyphs";
import styles from "./Nav.module.css";

/** The wordmark: one gull and the name, set in the display face at the current tone's softness. */
export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link className={styles.mark} href={href} aria-label="Copybook home" data-flock-guard>
      <Gull className={styles.gull} />
      Copybook
    </Link>
  );
}

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The landing's top bar. On narrow screens only the last link (the app) stays.
 * `data-flock-guard` marks the text the hero's flock keeps below.
 */
export function Nav({ links, className, children }: { links: NavLink[]; className?: string; children?: ReactNode }) {
  return (
    <header className={[styles.nav, className].filter(Boolean).join(" ")}>
      <Wordmark />
      <nav className={styles.links} aria-label="Primary" data-flock-guard>
        {links.map((l) =>
          l.href.startsWith("/") ? (
            <Link key={l.href} href={l.href} prefetch={false}>
              {l.label}
            </Link>
          ) : (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ),
        )}
      </nav>
      {children}
    </header>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { Gull } from "./glyphs";
import styles from "./Nav.module.css";

/**
 * The wordmark: one gull and the name, set in the display face at the current tone's softness.
 * `flockGuard` marks it as text the hero's flock keeps below.
 */
export function Wordmark({ href = "/", flockGuard = false }: { href?: string; flockGuard?: boolean }) {
  return (
    <Link className={styles.mark} href={href} aria-label="Copybook home" data-flock-guard={flockGuard || undefined}>
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
 * The landing's top bar (the page's banner). On narrow screens only the last link (the app) stays.
 * With `flockGuard`, the hero's flock keeps below its text.
 */
export function Nav({
  links,
  className,
  flockGuard = false,
  children,
}: {
  links: NavLink[];
  className?: string;
  flockGuard?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className={[styles.nav, className].filter(Boolean).join(" ")}>
      <Wordmark flockGuard={flockGuard} />
      <nav className={styles.links} aria-label="Primary" data-flock-guard={flockGuard || undefined}>
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

import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Arrow } from "./glyphs";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary" | "quiet";
type Size = "lg" | "md";

interface Common {
  /** Primary is the one action per screen: ink at dusk, gold at night. */
  variant?: Variant;
  /** `lg` (54px) on the landing, `md` (40px) in the app. */
  size?: Size;
  /** Trailing arrow, gold at dusk. */
  arrow?: boolean;
  className?: string;
  children: ReactNode;
}

type AsLink = Common & {
  href: string;
  /** Next.js route prefetch for internal links (default: Next's own). */
  prefetch?: boolean;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className">;
type AsButton = Common & { href?: undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

export type ButtonProps = AsLink | AsButton;

export function Button(props: ButtonProps) {
  const { variant = "primary", size = "lg", arrow = false, className, children, ...rest } = props;
  const cls = [styles.btn, styles[variant], styles[size], className].filter(Boolean).join(" ");
  const body = (
    <>
      {children}
      {arrow && <Arrow className={styles.arrow} />}
    </>
  );
  if ("href" in rest && rest.href !== undefined) {
    const { href, prefetch, ...anchor } = rest as Omit<AsLink, keyof Common>;
    const external = /^https?:/.test(href);
    return external ? (
      <a className={cls} href={href} rel="noopener noreferrer" {...anchor}>
        {body}
      </a>
    ) : (
      <Link className={cls} href={href} prefetch={prefetch} {...anchor}>
        {body}
      </Link>
    );
  }
  const { type = "button", ...button } = rest as Omit<AsButton, keyof Common>;
  return (
    <button className={cls} type={type} {...button}>
      {body}
    </button>
  );
}

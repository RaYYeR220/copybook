import type { Metadata, Viewport } from "next";
import { Figtree, Fragment_Mono, Fraunces } from "next/font/google";
import type { ReactNode } from "react";
import { siteUrl } from "@/lib/siteUrl";
import "./globals.css";

/** Display: Fraunces, variable, with the SOFT axis (100 at dusk, 0 at night). */
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-fraunces",
});

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-figtree",
});

/** Arrows (→ ↗) and Δ are outside the latin subset: they fall back to the system mono, not to a metric-matched sans. */
const fragmentMono = Fragment_Mono({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-fragment-mono",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
});


export const metadata: Metadata = {
  // each variable read by name, so Next inlines NEXT_PUBLIC_SITE_URL at build time
  metadataBase: new URL(
    siteUrl({
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
      VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    }),
  ),
  title: { default: "Copybook", template: "%s · Copybook" },
  description:
    "Follow a trader or a thesis on dreamDEX perps. Somnia validators run your copy in your own account, in the same block as the move.",
  applicationName: "Copybook",
  // trader, thesis and copy pages set their own card (app/og/*); the large card is the format they are drawn for
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#0c0b09",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${figtree.variable} ${fragmentMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

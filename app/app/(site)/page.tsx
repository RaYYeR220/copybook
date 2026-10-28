import type { Metadata, Viewport } from "next";
import { Footer } from "@/components/Footer";
import { Nav, type NavLink } from "@/components/Nav";
import { Hero } from "@/components/Hero/Hero";
import { Closing } from "@/components/landing/Closing";
import { Guard } from "@/components/landing/Guard";
import { How } from "@/components/landing/How";
import n from "@/components/landing/Night.module.css";
import { Proof } from "@/components/landing/Proof";
import { Refusals } from "@/components/landing/Refusals";
import { Theses } from "@/components/landing/Theses";
import { RevealObserver } from "@/components/RevealObserver";
import { APP_PATH } from "@/content/site";
import styles from "./landing.module.css";

const NAV: NavLink[] = [
  { href: "#how", label: "How it works" },
  { href: "#proof", label: "Proof" },
  { href: "#theses", label: "Theses" },
  { href: "#guard", label: "AI guard" },
  { href: APP_PATH, label: "Open app" },
];

export const metadata: Metadata = {
  title: { absolute: "Copybook — follow a trader or a thesis on dreamDEX perps" },
};

export const viewport: Viewport = {
  themeColor: "#f2e8df",
};

export default function Landing() {
  return (
    <div className={styles.page}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className={`${styles.banner} dusk`}>
        <Nav links={NAV} className="rise" flockGuard />
      </div>
      <main id="main" tabIndex={-1}>
        <Hero />
        <How />
        <Proof />
        <div className={`${n.night} night`}>
          <div className={`tex ${n.pools}`} aria-hidden="true" />
          <div className="tex dots" aria-hidden="true" />
          <Refusals />
          <Theses />
          <Guard />
          <Closing />
          <div className={`tex grain grain-night ${n.grain}`} aria-hidden="true" />
        </div>
      </main>
      <div className={`${styles.footWrap} night`}>
        <div className="tex dots" aria-hidden="true" />
        <Footer />
        <div className={`tex grain grain-night ${n.grain}`} aria-hidden="true" />
      </div>
      <RevealObserver />
    </div>
  );
}

import { APP_PATH } from "@/content/site";
import { LEADER, sameBlockOpen } from "@/content/proof";
import { fmtInt, shortHex } from "@/lib/format";
import { delay } from "@/lib/style";
import { Button } from "../Button";
import { Gull } from "../glyphs";
import { Nav, type NavLink } from "../Nav";
import { Flock } from "./Flock";
import { FlockCaption } from "./FlockCaption";
import { FlockStateProvider } from "./FlockState";
import styles from "./Hero.module.css";

const NAV: NavLink[] = [
  { href: "#how", label: "How it works" },
  { href: "#proof", label: "Proof" },
  { href: "#theses", label: "Theses" },
  { href: "#guard", label: "AI guard" },
  { href: APP_PATH, label: "Open app" },
];

/** Dusk. One claim, one action, and the flock: the leader you can guide, the formation that turns with it. */
export function Hero() {
  const block = fmtInt(sameBlockOpen.block);
  return (
    <section className={`${styles.hero} dusk`} data-hero>
      <FlockStateProvider>
        <div className={styles.sky} aria-hidden="true" />
        <div className={`wires ${styles.wires}`} aria-hidden="true" />
        <Flock leaderLabel={`leader · ${shortHex(LEADER)}`} />

        <Nav links={NAV} className="rise" />

        <div className={styles.col}>
          <p className={`${styles.eyebrow} rise`} style={delay(0.05)} data-flock-clear>
            <Gull className={styles.eyebrowGull} />
            dreamDEX perps · Somnia testnet
          </p>
          <h1 className={`${styles.h1} rise`} style={delay(0.1)} data-flock-clear>
            Follow a trader
            <br />
            or a <em>thesis.</em>
          </h1>
          <p className={`${styles.sub} rise`} style={delay(0.18)} data-flock-clear>
            Link Copybook as a bot. When the trader moves, Somnia validators move your account with them — in the same
            block, every leg or none.
          </p>
          <div className={`${styles.actions} rise`} style={delay(0.24)} data-flock-clear>
            <Button href={APP_PATH} prefetch={false} arrow>
              Open the app
            </Button>
          </div>
          <p className={`${styles.proofline} rise`} style={delay(0.3)} data-flock-clear>
            <span>Leader tx · block {block}</span>
            <span className={styles.arw} aria-hidden="true">
              →
            </span>
            <span>your copy · block {block}</span>
            <span className={styles.same}>same block</span>
          </p>
        </div>

        <div className={`${styles.foot} rise`} style={delay(0.4)}>
          <FlockCaption />
          <p className={styles.cue} aria-hidden="true">
            Scroll · dusk to night <i />
          </p>
        </div>
      </FlockStateProvider>
      <div className="grain grain-dusk" style={{ zIndex: 8 }} aria-hidden="true" />
    </section>
  );
}

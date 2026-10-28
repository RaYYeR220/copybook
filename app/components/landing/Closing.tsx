import { APP_PATH } from "@/content/site";
import { rng } from "@/lib/flock";
import { f1, rad, segmentsPath } from "@/lib/motion";
import { Button } from "../Button";
import { Frame } from "../Frame";
import n from "./Night.module.css";
import styles from "./Closing.module.css";

/** The chart's limb rising under the closing line: ticks, a scatter of stars, and the gold meridian. */
function Limb() {
  const ticks: number[] = [];
  for (let deg = 180; deg <= 360; deg++) ticks.push(deg);
  const r = rng(9);
  const stars = Array.from({ length: 70 }, () => {
    const a = rad(200 + r() * 140);
    const q = 300 + r() * 190;
    return { x: f1(q * Math.cos(a)), y: f1(q * Math.sin(a)), r: r() > 0.9 ? 1.6 : 0.8, o: (0.3 + r() * 0.5).toFixed(2) };
  });
  return (
    <svg className={styles.limb} viewBox="-550 -550 1100 1100">
      <circle className={styles.ring} r="500" />
      <circle className={styles.ring} r="530" />
      <path
        className={styles.tick}
        d={segmentsPath(
          ticks.map((deg) => {
            const a = rad(deg);
            const L = deg % 15 === 0 ? 30 : deg % 5 === 0 ? 14 : 6;
            return [500 * Math.cos(a), 500 * Math.sin(a), (500 + L) * Math.cos(a), (500 + L) * Math.sin(a)] as const;
          }),
        )}
      />
      {stars.map((s, i) => (
        <circle key={i} className={styles.star} cx={s.x} cy={s.y} r={s.r} opacity={s.o} />
      ))}
      <line className={styles.mer} x1="0" y1="-470" x2="0" y2="-545" />
      <circle cx="0" cy="-470" r="4" fill="#caa063" />
      <circle cx="0" cy="-444" r="2.6" fill="#e6dfcc" />
      <circle cx="0" cy="-422" r="2.6" fill="#e6dfcc" />
    </svg>
  );
}

/** Plate V: the closing line and the one action, again. */
export function Closing() {
  return (
    <section className={n.sec} aria-labelledby="close-h">
      <Frame
        tab={
          <>
            Plate <b>V</b> · In step
          </>
        }
      >
        <div className={styles.limbClip} aria-hidden="true">
          <Limb />
        </div>
        <div className={`${styles.body} reveal`}>
          <p className={`kicker ${styles.kicker}`}>One block · every leg</p>
          <h2 className={`h2 ${styles.title}`} id="close-h">
            Your book, in step
            <br />
            with <em>theirs.</em>
          </h2>
          <div className={styles.actions}>
            <Button href={APP_PATH} prefetch={false} arrow>
              Open the app
            </Button>
          </div>
          <p className={styles.small}>Somnia testnet · copies run on-chain · exits always copied</p>
        </div>
      </Frame>
    </section>
  );
}

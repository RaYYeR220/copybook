import { chevronPath, formation, gauss, pose, project, rng, type Projected } from "@/lib/flock";
import { f1 } from "@/lib/motion";
import { Gull } from "../glyphs";
import styles from "./How.module.css";

/** Pictogram i: one bird flies in and perches on the wire. */
function PerchPic() {
  return (
    <svg viewBox="0 0 300 144" preserveAspectRatio="xMinYMax meet">
      <line className={styles.perchLocal} x1="0" y1="144" x2="300" y2="144" />
      <path className={styles.trail} d="M14 34C56 20 98 34 118 72C128 92 130 104 132 112" />
      <path className={styles.chev} strokeWidth="1.4" d="M2 40Q7 31 11.6 38Q16.2 31 21 40" />
      <svg x="112" y="112" width="45" height="32" viewBox="0 0 28 20">
        <path
          className={styles.bird}
          d="M0 15.4L6 12.2C9 8.6 13.8 7 18 6.7C19.4 3.7 22.9 3.3 24.3 5.4L28 6.3L24.4 7.2C24 10.6 21 14 16.3 15C13.6 15.6 11 15.4 9 14.6L2.1 17Z"
        />
        <path className={styles.legs} d="M14 15.2V20M16.6 15L17.1 20" fill="none" />
      </svg>
    </svg>
  );
}

/** Pictogram ii: a loose flock gathers around a ringed leader. */
function GatherPic() {
  const r = rng(91);
  let d = "";
  for (let i = 0; i < 46; i++) {
    const a = r() * 6.283;
    const rr = 18 + Math.abs(gauss(r)) * 30;
    d += chevronPath(132 + Math.cos(a) * rr * 1.9, 70 + Math.sin(a) * rr * 0.8, 2.8 + r() * 1.8, 0.26 + r() * 0.3);
  }
  return (
    <svg viewBox="0 0 300 144" preserveAspectRatio="xMinYMax meet">
      <line className={styles.perchLocal} x1="0" y1="144" x2="300" y2="144" />
      <path className={styles.chev} strokeWidth="1.1" d={d} opacity=".8" />
      <circle className={styles.ring} cx="132" cy="70" r="10" />
      <path className={styles.chev} strokeWidth="1.4" d={chevronPath(132, 70, 4, 0.35)} />
    </svg>
  );
}

/** Pictogram iii: the same flock before (faint) and after one turn, the leader ringed. */
function TurnPic() {
  const birds = formation(260, 55);
  const o: Projected = { x: 0, y: 0, f: 0 };
  const draw = (twist: number, yaw: number, cx: number) => {
    const P = pose({ cx, cy: 100, S: 128, twist, yaw, pitch: 0.05, roll: 0, time: 0 });
    let s = "";
    for (const b of birds) {
      project(b, P, o);
      s += chevronPath(o.x, o.y, 1.6 + 1.2 * b.k, 0.3 + 0.18 * Math.sin(b.ph));
    }
    return { s, P };
  };
  const before = draw(1.9, 0.14, 140);
  const after = draw(1.0, -0.1, 160);
  const L = project({ s: 0.8, w: 0, t: 0 }, after.P, { x: 0, y: 0, f: 0 });
  return (
    <svg viewBox="0 0 300 144" preserveAspectRatio="xMinYMax meet">
      <line className={styles.perchLocal} x1="0" y1="144" x2="300" y2="144" />
      <path className={styles.chev} strokeWidth=".8" d={before.s} opacity=".16" />
      <path className={styles.trail} d="M70 20C120 4 210 6 262 36" />
      <path d="M256 30l7 6-9 2" fill="none" stroke="#74645f" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      <path className={styles.chev} strokeWidth=".95" d={after.s} opacity=".85" />
      <circle className={styles.ring} cx={f1(L.x)} cy={f1(L.y)} r="6" />
    </svg>
  );
}

const BEATS = [
  {
    n: "i.",
    verb: "Link",
    title: "Link the bot",
    pic: <PerchPic />,
    body: "Approve Copybook as a bot on your dreamDEX account and fund a small gas tank. It can open and close perps for you — it can’t withdraw. Set scale, caps, price band and equity floor once.",
    note: "One bird lands on the wire",
  },
  {
    n: "ii.",
    verb: "Choose",
    title: "Choose a trader or a thesis",
    pic: <GatherPic />,
    body: "Follow an address, or a thesis — a basket of legs with weights. One source per wallet, and your copy is sized to your scale, not theirs. Trader follows get the AI guard’s second opinion.",
    note: "A flock forms around a leader",
  },
  {
    n: "iii.",
    verb: "Copy",
    title: "Copied in the same block",
    pic: <TurnPic />,
    body: "When the source’s position changes, Somnia validators run your copy in that same block. Exits are never gated. Anything refused is written on-chain with its reason.",
    note: "The whole flock turns in one frame",
  },
];

/** Late dusk: three sequenced verbs, drawn on one telegraph wire. */
export function How() {
  return (
    <section className={`${styles.how} dusk`} id="how" aria-labelledby="how-h">
      <div className={styles.pools} aria-hidden="true" />
      <div className={styles.wrap}>
        <header className={`${styles.head} reveal`}>
          <p className="kicker">
            <Gull />
            How it works
          </p>
          <h2 className="h2" id="how-h">
            Three verbs. <em>One block.</em>
          </h2>
          <p className="lead">
            Copybook isn’t a server watching someone else’s account. It’s a bot on yours — so the copy runs inside the
            very block that carries the move.
          </p>
        </header>
        <ol className={`${styles.beats} reveal`}>
          {BEATS.map((b) => (
            <li className={styles.beat} key={b.verb}>
              <div className={styles.pic} aria-hidden="true">
                {b.pic}
              </div>
              <span className={styles.post} aria-hidden="true" />
              <div className={styles.verb}>
                <span className={styles.num}>{b.n}</span>
                <span className={styles.vb}>{b.verb}</span>
              </div>
              <h3 className={`h3 ${styles.title}`}>{b.title}</h3>
              <p className={styles.body}>{b.body}</p>
              <p className={styles.note}>{b.note}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="grain grain-dusk" style={{ zIndex: 3 }} aria-hidden="true" />
    </section>
  );
}

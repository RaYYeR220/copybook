import type { CSSProperties } from "react";
import { links, thesisRebalance } from "@/content/proof";
import { chevronPath, gauss, rng } from "@/lib/flock";
import { fmtInt } from "@/lib/format";
import { f1, segmentsPath } from "@/lib/motion";
import { delay } from "@/lib/style";
import { Frame } from "../Frame";
import d from "./diagram.module.css";
import n from "./Night.module.css";
import styles from "./Theses.module.css";

/** The example basket drawn on the plate. Illustration, labelled as such wherever it shows. */
const EXAMPLE = {
  name: "Majors over memes",
  legs: [
    { market: "BTC-PERP", side: "long", weight: 50, star: [196, 150, 9.5, 24], tag: [-34, 0, "end"], flock: 64 },
    { market: "ETH-PERP", side: "long", weight: 30, star: [420, 222, 7, 17], tag: [0, 50, "middle"], flock: 40 },
    { market: "1000PEPE-PERP", side: "short", weight: 20, star: [612, 112, 5.2, 13], tag: [0, -36, "middle"], flock: 26 },
  ],
} as const;

/** Shortened segment between two stars, leaving a gap at each end. */
function segment(a: readonly number[], b: readonly number[], g1: number, g2: number, dotted = false) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const len = Math.hypot(x2 - x1, y2 - y1);
  return (
    <line
      x1={f1(x1 + ((x2 - x1) * g1) / len)}
      y1={f1(y1 + ((y2 - y1) * g1) / len)}
      x2={f1(x2 - ((x2 - x1) * g2) / len)}
      y2={f1(y2 - ((y2 - y1) * g2) / len)}
      {...(dotted ? { strokeDasharray: "1 4", strokeLinecap: "round" as const } : {})}
    />
  );
}

/** An asterism: each leg is a small flock settled into a star; the short leg flies inverted. */
function Asterism() {
  const r = rng(303);
  const stars = EXAMPLE.legs.map((l) => l.star);
  const hatch: number[] = [];
  for (let x = -148; x < 720; x += 8) hatch.push(x);
  const legs = EXAMPLE.legs.map((leg) => {
    const [x, y, rr] = leg.star;
    const inverted = leg.side === "short";
    let path = "";
    for (let j = 0; j < leg.flock; j++) {
      const a = r() * 6.283;
      const q = rr * 2.6 + Math.abs(gauss(r)) * rr * 2.4;
      const bx = x + Math.cos(a) * q * 1.3;
      const by = y + Math.sin(a) * q * 0.8;
      const s = 1.6 + r() * 1.4;
      const fl = (0.25 + r() * 0.3) * (inverted ? -1 : 1);
      path += chevronPath(bx, by, s, fl);
    }
    return { leg, path };
  });
  return (
    <svg
      className={`${d.diag} ${d.large} reveal`}
      style={delay(0.1)}
      viewBox="0 0 720 460"
      role="img"
      aria-label="Example thesis: three legs rise above the horizon together, or revert together below it"
    >
      <defs>
        <clipPath id="thesis-below">
          <rect x="0" y="312" width="720" height="148" />
        </clipPath>
      </defs>
      <g clipPath="url(#thesis-below)">
        <path className={d.hh} d={segmentsPath(hatch.map((x) => [x, 460, x + 148, 312] as const))} />
      </g>
      <g stroke="rgba(230,223,204,.42)" strokeWidth="1">
        {segment(stars[0], stars[1], 30, 22)}
        {segment(stars[1], stars[2], 22, 18)}
        {segment(stars[0], stars[2], 30, 18, true)}
      </g>
      {legs.map(({ leg, path }) => {
        const [x, y, rr, L] = leg.star;
        const [dx, dy, anchor] = leg.tag;
        const tx = x + dx;
        const ty = y + dy - (dy < 0 ? 15 : 0) + (dx ? -2 : 0);
        return (
          <g key={leg.market}>
            <path className={d.chv} strokeWidth=".8" opacity=".55" d={path} />
            <circle cx={x} cy={y} r={f1(rr * 1.9)} fill="none" stroke="rgba(230,223,204,.18)" />
            <path d={`M${x - L} ${y}H${x + L}M${x} ${y - L}V${y + L}`} stroke="#e6dfcc" strokeWidth="1" opacity=".75" />
            <circle cx={x} cy={y} r={rr} fill="#e6dfcc" />
            <text className={d.tb} textAnchor={anchor} x={tx} y={ty}>
              {leg.market}
            </text>
            <text className={d.t} textAnchor={anchor} x={tx} y={ty + 15}>
              {leg.side.toUpperCase()} · {leg.weight}%
            </text>
          </g>
        );
      })}
      <text className={d.title} x="28" y="40">
        {EXAMPLE.name}
      </text>
      <text className={d.t} x="28" y="60">
        EXAMPLE THESIS · 3 LEGS · ONE BASKET
      </text>
      <line className={d.h} x1="0" y1="312" x2="720" y2="312" />
      <text className={d.t} x="0" y="302">
        HORIZON
      </text>
      <line className={d.mer} x1="420" y1="292" x2="420" y2="332" />
      <text className={d.tc} x="432" y="302">
        RISEN WHOLE · 3/3 · ONE TRANSACTION
      </text>
      <g opacity=".55">
        <line x1="236" y1="384" x2="430" y2="370" stroke="rgba(230,223,204,.35)" strokeDasharray="2 4" />
        <line x1="430" y1="370" x2="585" y2="398" stroke="rgba(230,223,204,.35)" strokeDasharray="2 4" />
        <circle className={d.hol} cx="236" cy="384" r="9" />
        <circle className={d.hol} cx="430" cy="370" r="7" />
        <circle className={d.hol} cx="585" cy="398" r="6" />
      </g>
      <rect className={d.bg} x="24" y="420" width="296" height="20" />
      <text className={d.t} x="28" y="434">
        OR 0/3 · REVERTED · NOTHING HALF-OPEN
      </text>
    </svg>
  );
}

const pct = (bps: number) => `${Math.abs(bps) / 100}`;

/** Plate III: a thesis is a basket whose new legs open together, with a live rebalance copied in its own block. */
export function Theses() {
  const t = thesisRebalance;
  const before = t.before.map((l) => pct(l.weightBps)).join("/");
  const after = t.after.map((l) => pct(l.weightBps)).join("/");
  return (
    <section className={n.sec} id="theses" aria-labelledby="th-h">
      <Frame
        tab={
          <>
            Plate <b>III</b> · Theses
          </>
        }
        tabEnd="One basket · opens in one transaction"
      >
        <div className={`${n.two} ${n.wide}`}>
          <div className="reveal">
            <p className="kicker">A thesis is an asterism</p>
            <h2 className="h2" id="th-h">
              A thesis opens <em>whole.</em>
            </h2>
            <p className={`lead ${n.leadSm}`}>
              Follow a basket of legs with weights. Every new leg opens in one transaction — or none do. Exits always go through.
            </p>
            <p className={n.listHead}>Example thesis · {EXAMPLE.name}</p>
            <ul className={styles.legs} aria-label={`Example thesis legs: ${EXAMPLE.name}`}>
              {EXAMPLE.legs.map((l, i) => (
                <li key={l.market}>
                  <b>{l.market}</b>
                  <span>{l.side}</span>
                  <span className={styles.weight}>{l.weight}%</span>
                  <span className={styles.bar} aria-hidden="true">
                    <i style={{ width: `${l.weight}%`, opacity: [1, 0.7, 0.45][i] } as CSSProperties} />
                  </span>
                </li>
              ))}
            </ul>
            <p className={styles.whole}>Opens every leg in one transaction, or none.</p>
            <p className={styles.none}>If one leg can’t fill inside its band, the whole opening reverts — nothing half-open.</p>
            <p className={n.live}>
              Live run · thesis <b>“{t.name}”</b> rebalanced {before} → {after}; the copy followed in the rebalance’s own
              block <b>#{fmtInt(t.block)}</b> ·{" "}
              <a className="lnk" href={links.rebalanceCopyTx} target="_blank" rel="noopener noreferrer">
                tx ↗
              </a>
            </p>
          </div>
          <Asterism />
        </div>
      </Frame>
    </section>
  );
}

import { guardReview, links } from "@/content/proof";
import { shortHex } from "@/lib/format";
import { f1, rad, segmentsPath } from "@/lib/motion";
import { delay } from "@/lib/style";
import { Frame } from "../Frame";
import { VerdictBlock, VerdictCaution, VerdictOk } from "../glyphs";
import d from "./diagram.module.css";
import n from "./Night.module.css";
import styles from "./Guard.module.css";

const CX = 280;
const CY = 268;
const R = 150;
const VR = 92; // the verdict arc
const ARC_FROM = -160;
const ARC_TO = -20;

const polar = (r: number, deg: number): [string, string] => [f1(CX + r * Math.cos(rad(deg))), f1(CY + r * Math.sin(rad(deg)))];

function arcPath(r: number, from: number, to: number) {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
}

/** The committee round the trader, and the verdict needle. Drawn from one live review: its seats are the validators who answered. */
function Committee() {
  const size: number = guardReview.answered;
  // validators spread round the lower 216°, clear of the verdict arc at the top
  const seats = Array.from({ length: size }, (_, i) => (size === 1 ? 90 : -18 + (i * 216) / (size - 1)));
  const ticks: number[] = [];
  for (let deg = ARC_FROM; deg <= ARC_TO; deg += 5) ticks.push(deg);
  const trader = shortHex(guardReview.trader);
  const ring = R + 26;
  return (
    <svg
      className={`${d.diag} reveal`}
      viewBox="0 0 560 470"
      role="img"
      aria-label={`A committee of ${size} Somnia validators reviewed trader ${trader}; the verdict needle reads ${guardReview.verdict}`}
    >
      <path id="committee-ring" fill="none" d={`M ${CX - ring} ${CY} A ${ring} ${ring} 0 1 1 ${CX + ring} ${CY} A ${ring} ${ring} 0 1 1 ${CX - ring} ${CY}`} />
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(230,223,204,.28)" strokeDasharray="1 4" strokeLinecap="round" />
      <circle cx={CX} cy={CY} r={R + 12} fill="none" stroke="rgba(230,223,204,.12)" />
      <text className={d.t} letterSpacing=".3em">
        <textPath href="#committee-ring" startOffset="58%">
          COMMITTEE · {size} SOMNIA VALIDATORS · ONE VERDICT
        </textPath>
      </text>

      <path d={arcPath(VR, ARC_FROM, ARC_TO)} fill="none" stroke="rgba(230,223,204,.35)" />
      <path d={arcPath(VR - 10, ARC_FROM, ARC_TO)} fill="none" stroke="rgba(230,223,204,.14)" />
      <path
        stroke="rgba(230,223,204,.32)"
        d={segmentsPath(
          ticks.map((deg) => {
            const L = (deg - ARC_FROM) % 35 === 0 ? 10 : 4;
            const a = rad(deg);
            return [CX + VR * Math.cos(a), CY + VR * Math.sin(a), CX + (VR - L) * Math.cos(a), CY + (VR - L) * Math.sin(a)] as const;
          }),
        )}
      />
      {(
        [
          ["OK", -142],
          ["CAUTION", -90],
          ["BLOCK", -38],
        ] as const
      ).map(([word, deg]) => {
        const [x, y] = polar(VR + 18, deg);
        return (
          <text key={word} className={word === guardReview.verdict ? d.tc : d.t} textAnchor="middle" x={x} y={f1(Number(y) + 3)}>
            {word}
          </text>
        );
      })}
      {[-125, -55].map((deg) => {
        const [x1, y1] = polar(VR - 12, deg);
        const [x2, y2] = polar(VR + 6, deg);
        return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(230,223,204,.55)" />;
      })}

      {seats.map((deg, i) => {
        const [x, y] = polar(R, deg);
        const [sx, sy] = polar(18, deg);
        // the committee's name runs round the lower rim, so a seat down there is labelled inside the ring
        const [lx, ly] = polar(deg > 30 && deg < 150 ? R - 20 : R + 22, deg);
        return (
          <g key={deg}>
            <line x1={x} y1={y} x2={sx} y2={sy} stroke="rgba(230,223,204,.16)" strokeDasharray="1 4" strokeLinecap="round" />
            <g transform={`translate(${x} ${y}) rotate(45)`}>
              <rect x="-4.5" y="-4.5" width="9" height="9" fill="#0c0b09" stroke="#e6dfcc" strokeOpacity=".8" />
            </g>
            <text className={d.t} textAnchor="middle" x={lx} y={f1(Number(ly) + 3)}>
              v{i + 1}
            </text>
          </g>
        );
      })}

      <circle cx={CX} cy={CY} r="22" fill="none" stroke="rgba(230,223,204,.2)" />
      <circle cx={CX} cy={CY} r="7" fill="#e6dfcc" />
      <path d={`M${CX - 16} ${CY}H${CX + 16}M${CX} ${CY - 16}V${CY + 16}`} stroke="#e6dfcc" opacity=".7" />
      <line className={d.mer} x1={CX} y1={CY - 26} x2={CX} y2={CY - VR + 4} />
      <circle cx={CX} cy={CY - VR + 4} r="3" fill="#caa063" />
      <text className={d.tb} x={CX + 30} y={CY + 30}>
        TRADER · {trader}
      </text>
      <text className={d.t} x={CX + 30} y={CY + 45}>
        LLM REVIEW OF 30-DAY RISK
      </text>
      <rect className={d.bg} x={CX - 112} y="20" width="224" height="20" />
      <text className={d.tc} textAnchor="middle" x={CX} y="34">
        VERDICT · {guardReview.verdict} · ON-CHAIN
      </text>
      <line x1={CX} y1="44" x2={CX} y2={CY - VR - 26} stroke="#caa063" strokeDasharray="2 5" opacity=".6" />
    </svg>
  );
}

/** Plate IV: the AI guard on trader follows. Exits are never gated. */
export function Guard() {
  return (
    <section className={n.sec} id="guard" aria-labelledby="g-h">
      <Frame
        tab={
          <>
            Plate <b>IV</b> · AI guard
          </>
        }
        tabEnd="Trader follows · per follower"
      >
        <div className={n.two}>
          <Committee />
          <div className="reveal" style={delay(0.08)}>
            <p className="kicker">AI guard · new</p>
            <h2 className="h2" id="g-h">
              A second opinion, <em>signed by validators.</em>
            </h2>
            <p className={`lead ${n.leadSm}`}>
              On a trader follow, a committee of Somnia validators runs an LLM over the trader’s last 30 days. The verdict
              is reached on Shannon, crosses to Hideki over Hyperlane, and your copies obey it.
            </p>
            <ul className={styles.verdicts}>
              <li>
                <span className={styles.vd}>
                  <VerdictOk />
                  OK
                </span>
                <span>New size copies as usual.</span>
              </li>
              <li>
                <span className={`${styles.vd} ${styles.caution}`}>
                  <VerdictCaution />
                  CAUTION
                </span>
                <span>Copies continue; the flag shows on your dashboard and in the feed.</span>
              </li>
              <li>
                <span className={styles.vd}>
                  <VerdictBlock />
                  BLOCK
                </span>
                <span>
                  New size is refused with reason <b>AI risk verdict</b>. <b>Exits are never gated.</b>
                </span>
              </li>
            </ul>
            <p className={n.listHead}>Example · a guarded follower under BLOCK</p>
            <div className={styles.record}>
              <div>
                <span className={styles.k}>increase</span>
                <span>BTC-PERP +0.0003 → refused · AI risk verdict</span>
              </div>
              <div>
                <span className={styles.k}>exit</span>
                <span>
                  BTC-PERP close 0.0005 → copied · <span className={styles.gold}>same block</span>
                </span>
              </div>
            </div>
            <p className={n.live}>
              Live review · trader <b>{shortHex(guardReview.trader)}</b> · {guardReview.votes} of {guardReview.answered}{" "}
              validators answered <b>{guardReview.verdict}</b> ·{" "}
              <a className="lnk" href={links.guardVerdict} target="_blank" rel="noopener noreferrer">
                verdict on Shannon ↗
              </a>{" "}
              ·{" "}
              <a className="lnk" href={links.guardDelivery} target="_blank" rel="noopener noreferrer">
                delivered to Hideki ↗
              </a>
            </p>
            <p className={n.caption}>Per follower · on by default for trader follows</p>
          </div>
        </div>
      </Frame>
    </section>
  );
}

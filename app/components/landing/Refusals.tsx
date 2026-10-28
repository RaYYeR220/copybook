import { bandRefusal, links } from "@/content/proof";
import { fmtInt } from "@/lib/format";
import { segmentsPath } from "@/lib/motion";
import type { RefusalReason } from "@/lib/reasons";
import { delay } from "@/lib/style";
import { Frame } from "../Frame";
import { Ledger } from "../Ledger";
import { RefusalChip } from "../RefusalChip";
import d from "./diagram.module.css";
import n from "./Night.module.css";
import styles from "./Refusals.module.css";

/** The reasons a follower's own settings and tank produce, each with what triggers it. */
const POLICY_REASONS: [RefusalReason, string][] = [
  ["BandUnfilled", "The fill would land outside your price band."],
  ["TotalCap", "The copy would push your total exposure past your cap."],
  ["EquityFloor", "Equity fell under your floor: your copied positions are closed and copying stops until you resume."],
  ["TankEmpty", "The gas tank can’t pay for the copy."],
  ["RiskGate", "Your AI guard returned BLOCK for this trader."],
  ["BelowMinimum", "Your scaled size rounds below one lot or the venue minimum."],
  ["AtCap", "The position already sits at your max notional."],
];

function HorizonDiagram() {
  const { block, bandBps, leader, copy, market } = bandRefusal;
  const hatch: number[] = [];
  for (let x = 20 - 104; x < 420; x += 7) hatch.push(x);
  const coin = market.replace("-PERP", "");
  return (
    <svg
      className={`${d.diag} reveal`}
      viewBox="0 0 440 252"
      role="img"
      aria-label={`The copy stays below the horizon: refused in block ${fmtInt(block)} by the price band`}
    >
      <defs>
        <clipPath id="refusal-below">
          <rect x="20" y="128" width="400" height="104" />
        </clipPath>
      </defs>
      <g clipPath="url(#refusal-below)">
        <path className={d.hh} d={segmentsPath(hatch.map((x) => [x, 232, x + 104, 128] as const))} />
      </g>
      <line className={d.h} x1="20" y1="128" x2="420" y2="128" />
      <text className={d.t} x="20" y="118">
        HORIZON · YOUR BAND · {bandBps} BPS
      </text>
      <line className={d.drop} x1="300" y1="80" x2="300" y2="178" />
      <circle className={d.co} cx="300" cy="66" r="13" />
      <circle className={d.c} cx="300" cy="66" r="6" />
      <text className={d.tb} x="20" y="60">
        LEADER · BUYS {coin} · TX #{leader.index}
      </text>
      <circle className={d.hol} cx="300" cy="186" r="9" />
      <rect className={d.bg} x="318" y="178" width="102" height="18" />
      <text className={d.tb} x="324" y="191">
        NOT SET
      </text>
      <rect className={d.bg} x="20" y="214" width="220" height="18" />
      <text className={d.t} x="24" y="227">
        YOUR COPY · BLK {fmtInt(block)} · TX #{copy.index}
      </text>
    </svg>
  );
}

/** Plate II: a live band refusal read off the chain, the reasons by name, and the rule about exits. */
export function Refusals() {
  const { block, bandBps, leader, copy, market, venueError, reason } = bandRefusal;
  return (
    <section className={n.sec} id="refusals" aria-labelledby="ref-h">
      <Frame
        tab={
          <>
            Plate <b>II</b> · Refusals
          </>
        }
        tabEnd={<>Somnia · block {fmtInt(block)}</>}
      >
        <div className={n.two}>
          <HorizonDiagram />
          <div className={`${styles.reading} reveal`} style={delay(0.08)}>
            <p className="kicker">Read off the chain</p>
            {/* the plate's heading: an h2 like the other plates, set at the reading's smaller size */}
            <h2 className={`h3 ${styles.readingTitle}`} id="ref-h">
              A refusal is a record too.
            </h2>
            <Ledger
              className={styles.ledger}
              rows={[
                {
                  label: "Leader",
                  value: (
                    <>
                      {market} buy · min size · tx <b>#{leader.index}</b>
                    </>
                  ),
                },
                {
                  label: "Your copy",
                  value: (
                    <>
                      <b>REFUSED</b> · same block · tx <b>#{copy.index}</b>
                    </>
                  ),
                },
                {
                  label: "Reason",
                  value: (
                    <>
                      <b>Band</b> — no fill inside your band
                    </>
                  ),
                  note: (
                    <>
                      band {bandBps} bps · venue: {venueError}
                    </>
                  ),
                },
                { label: "Written", value: <>Refused(reason: {reason})</> },
              ]}
            />
            <p className={styles.row}>
              <span>block {fmtInt(block)}</span>
              <a className="lnk" href={links.refusalTx} target="_blank" rel="noopener noreferrer">
                View the refusal ↗
              </a>
            </p>
          </div>
        </div>

        <div className={`${styles.reasons} reveal`}>
          <div>
            <p className="kicker">Every refusal has a name</p>
            <h3 className={`h3 ${styles.reasonsTitle}`}>
              Seven from your policy, <em>all on-chain.</em>
            </h3>
          </div>
          <div>
            <ul className={styles.list}>
              {POLICY_REASONS.map(([r, text]) => (
                <li key={r}>
                  <RefusalChip reason={r} />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
            <p className={n.caption}>Also on the record: market not allowed · venue rejected · leg failed · paused</p>
          </div>
        </div>
        <p className={`${styles.exits} reveal`}>Exits are always copied — a refusal can stop you opening, never stop you closing.</p>
      </Frame>
    </section>
  );
}

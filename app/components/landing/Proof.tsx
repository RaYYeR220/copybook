import { links, sameBlockOpen } from "@/content/proof";
import { fmtInt, shortHex } from "@/lib/format";
import { Gull } from "../glyphs";
import { Gold, Ledger } from "../Ledger";
import { NightfallScene } from "../Nightfall/Nightfall";
import { Plate } from "../Plate";
import styles from "./Proof.module.css";

/** Nightfall: the flock settles onto the atlas, and the live same-block pair is read off the chain. */
export function Proof() {
  const { market, side, size, block, leader, copy } = sameBlockOpen;
  const blk = fmtInt(block);
  return (
    <NightfallScene
      labelledBy="nf-h"
      plate={<Plate />}
      head={
        <>
          <p className="kicker">
            <Gull />
            Proof · nightfall
          </p>
          <h2 className="h2" id="nf-h">
            Same block, <em>on the record.</em>
          </h2>
          <p>
            Keep scrolling and night falls. The flock settles onto the chart — and the leader and your copy land on one
            meridian: one block, read straight off the chain.
          </p>
        </>
      }
      readout={
        <div className="night">
          <Ledger
            rows={[
              {
                label: "Leader",
                value: (
                  <>
                    {shortHex(leader.hash)} · {market} {side} <b>{size}</b> · tx <b>#{leader.index}</b>
                  </>
                ),
              },
              {
                label: "Your copy",
                value: (
                  <>
                    {shortHex(copy.hash)} · {market} {side} <b>{size}</b> · tx <b>#{copy.index}</b>
                  </>
                ),
              },
              {
                label: "Block",
                value: (
                  <>
                    <b>{blk}</b> · <Gold>Δ 0 blocks</Gold>
                  </>
                ),
              },
            ]}
          />
          <p className={styles.row}>
            <span>Somnia testnet · live run</span>
            <a className="lnk" href={links.leaderTx} target="_blank" rel="noopener noreferrer">
              Leader tx ↗
            </a>
            <a className="lnk" href={links.copyTx} target="_blank" rel="noopener noreferrer">
              Copy tx ↗
            </a>
          </p>
        </div>
      }
      leaderLabel={{ title: `LEADER · TX #${leader.index}`, detail: `blk ${blk}` }}
      copyLabel={{ title: `YOUR COPY · TX #${copy.index}`, detail: `blk ${blk}`, mark: "Δ 0" }}
    />
  );
}

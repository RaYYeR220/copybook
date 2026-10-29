import type { CSSProperties, ReactNode } from "react";
import type { CopyCardModel, ThesisCardModel, TraderCardModel } from "./model";

/** The night palette (the same values as app/globals.css): gold is the one accent; gains and losses are never coloured. */
const C = {
  night0: "#0c0b09",
  night1: "#15130f",
  night2: "#221f19",
  night3: "#5d564a",
  night4: "#a79e8a",
  bone: "#e6dfcc",
  bone2: "#cfc7b3",
  gold: "#caa063",
  goldWash: "rgba(202,160,99,0.08)",
  goldLine: "rgba(202,160,99,0.55)",
  hair: "rgba(230,223,204,0.09)",
  hair2: "rgba(230,223,204,0.17)",
  hair3: "rgba(230,223,204,0.30)",
};
const DISPLAY = "Fraunces";
const MONO = "Fragment Mono";
const BODY = "Figtree";

export const CARD = { width: 1200, height: 630 } as const;

const row = (s: CSSProperties = {}): CSSProperties => ({ display: "flex", flexDirection: "row", ...s });
const col = (s: CSSProperties = {}): CSSProperties => ({ display: "flex", flexDirection: "column", ...s });
const kick: CSSProperties = { fontFamily: MONO, fontSize: 15, letterSpacing: "0.2em", textTransform: "uppercase", color: C.night4 };

/** The gull of the wordmark (components/glyphs Gull), bone. */
const Gull = () => (
  <svg width="30" height="15" viewBox="0 0 16 8">
    <path d="M1 5.6Q4.6 1.4 8 5.1Q11.4 1.4 15 5.6" fill="none" stroke={C.bone} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The same-block mark (components/glyphs Meridian), gold. */
const MeridianMark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 13 13">
    <line x1="1.5" y1="11.5" x2="11.5" y2="1.5" stroke={C.gold} strokeWidth="1" />
    <circle cx="9" cy="4" r="1.9" fill={C.gold} />
    <circle cx="4.6" cy="8.4" r="1.2" fill={C.gold} />
  </svg>
);

/** The plate: night ground, two faint pools, the double rule, the wordmark and a mono kicker, a footer line. */
function Plate({ kicker, footer, children }: { kicker: string; footer: string; children: ReactNode }) {
  return (
    <div
      style={col({
        position: "relative",
        width: CARD.width,
        height: CARD.height,
        padding: "54px 74px 46px",
        backgroundColor: C.night0,
        backgroundImage: `radial-gradient(circle at 88% 4%, rgba(202,160,99,0.085), transparent 42%), radial-gradient(circle at 4% 104%, ${C.night2}, transparent 50%)`,
        color: C.bone,
        fontFamily: BODY,
      })}
    >
      <div style={{ position: "absolute", top: 20, left: 20, right: 20, bottom: 20, border: `1px solid ${C.hair2}`, display: "flex" }} />
      <div style={{ position: "absolute", top: 25, left: 25, right: 25, bottom: 25, border: `1px solid ${C.hair}`, display: "flex" }} />
      <div style={row({ alignItems: "center", justifyContent: "space-between" })}>
        <div style={row({ alignItems: "center", gap: 12 })}>
          <Gull />
          <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 32, letterSpacing: "-0.02em", color: C.bone }}>Copybook</span>
        </div>
        <span style={kick}>{kicker}</span>
      </div>
      <div style={col({ flexGrow: 1, marginTop: 28, marginBottom: 26 })}>{children}</div>
      <div style={row({ fontFamily: MONO, fontSize: 15, color: C.night4, letterSpacing: "0.02em" })}>{footer}</div>
    </div>
  );
}

function Figure({ label, value, note, gold = false, last = false }: { label: string; value: string; note?: string; gold?: boolean; last?: boolean }) {
  return (
    <div style={col({ gap: 10, ...(last ? {} : { paddingRight: 44, marginRight: 44, borderRight: `1px solid ${C.hair2}` }) })}>
      <span style={{ ...kick, fontSize: 13 }}>{label}</span>
      <div style={row({ alignItems: "baseline", gap: 10 })}>
        <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 46, letterSpacing: "-0.025em", lineHeight: 1, color: gold ? C.gold : C.bone }}>{value}</span>
        {note && <span style={{ fontFamily: MONO, fontSize: 16, color: C.night4 }}>{note}</span>}
      </div>
    </div>
  );
}

/** A follower's copy: the same-block mark, the move, and the two transactions on one gold meridian. */
export function CopyCard({ m }: { m: CopyCardModel }) {
  return (
    <Plate kicker="a copy on dreamDEX perps · Somnia" footer={`${m.time} · read from the chain`}>
      <div style={row({ flexGrow: 1 })}>
        <div style={col({ width: 740, flexShrink: 0, justifyContent: "space-between" })}>
          <div style={col({ gap: 22 })}>
            {m.sameBlock ? (
              <div
                style={row({
                  alignSelf: "flex-start",
                  alignItems: "center",
                  gap: 12,
                  height: 48,
                  padding: "0 22px 0 16px",
                  borderRadius: 999,
                  border: `1px solid ${C.goldLine}`,
                  backgroundColor: C.goldWash,
                  fontFamily: MONO,
                  fontSize: 22,
                  color: C.gold,
                })}
              >
                <MeridianMark />
                <span>same block #{m.block}</span>
              </div>
            ) : (
              <div style={row({ alignSelf: "flex-start", alignItems: "center", height: 48, padding: "0 20px", borderRadius: 999, border: `1px solid ${C.hair3}`, fontFamily: MONO, fontSize: 22, color: C.bone2 })}>
                block #{m.block}
              </div>
            )}
            <div style={col({ gap: 8 })}>
              <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 92, letterSpacing: "-0.045em", lineHeight: 0.95 }}>{m.market}</span>
              <span style={{ fontFamily: MONO, fontSize: 26, color: C.bone2 }}>{m.move}</span>
            </div>
          </div>
          <div style={col({ gap: 6, fontFamily: MONO, fontSize: 18, color: C.bone2 })}>
            <span>{`following ${m.source}`}</span>
            <span style={{ color: C.night4 }}>{`follower ${m.follower} · limit ${m.limit}, not the fill`}</span>
            {m.sentBy && <span style={{ color: C.night4 }}>{m.sentBy}</span>}
          </div>
        </div>

        <div style={col({ width: 280, flexShrink: 0, alignItems: "stretch", justifyContent: "center", position: "relative", marginLeft: 32 })}>
          <div style={{ position: "absolute", left: 22, top: 0, bottom: 0, width: 1, backgroundColor: m.sameBlock ? C.gold : C.hair3, display: "flex" }} />
          {m.leader && (
            <div style={row({ alignItems: "center", gap: 22, marginBottom: 62 })}>
              <div style={{ width: 44, height: 44, borderRadius: 999, backgroundColor: C.gold, display: "flex" }} />
              <div style={col({ gap: 4 })}>
                <span style={{ ...kick, fontSize: 13 }}>the move</span>
                <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 40, letterSpacing: "-0.02em", lineHeight: 1 }}>{`tx #${m.leader.index}`}</span>
                <span style={{ fontFamily: MONO, fontSize: 15, color: C.night4 }}>{m.leader.hash}</span>
              </div>
            </div>
          )}
          <div style={row({ alignItems: "center", gap: 22 })}>
            <div style={row({ width: 44, justifyContent: "center" })}>
              <div style={{ width: 28, height: 28, borderRadius: 999, backgroundColor: C.bone, display: "flex" }} />
            </div>
            <div style={col({ gap: 4 })}>
              <span style={{ ...kick, fontSize: 13 }}>the copy</span>
              <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 40, letterSpacing: "-0.02em", lineHeight: 1 }}>{`tx #${m.copy.index}`}</span>
              <span style={{ fontFamily: MONO, fontSize: 15, color: C.night4 }}>{m.copy.hash}</span>
            </div>
          </div>
        </div>
      </div>
    </Plate>
  );
}

/** A trader: the address as the name, the 30-day record, the validators' verdict, followers through Copybook. */
export function TraderCard({ m }: { m: TraderCardModel }) {
  return (
    <Plate kicker="trader · dreamDEX perps · Somnia" footer={`read ${m.asOf} from the dreamDEX indexer and the chain`}>
      <div style={col({ flexGrow: 1, justifyContent: "space-between" })}>
        <div style={col({ gap: 14 })}>
          <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 112, letterSpacing: "-0.045em", lineHeight: 0.95 }}>{m.name}</span>
          <div style={row({ gap: 16, fontFamily: MONO, fontSize: 18, color: C.night4 })}>
            <span>{m.address}</span>
            {m.demo && <span style={{ color: C.gold }}>demo leader · run by Copybook</span>}
          </div>
        </div>
        <div style={row({ alignItems: "flex-end" })}>
          {m.stats ? (
            m.stats.map((s, i, all) => <Figure key={s.label} label={s.label} value={s.value} note={s.note} last={!m.verdict && i === all.length - 1} />)
          ) : (
            <div style={row({ marginRight: 44, fontFamily: MONO, fontSize: 20, color: C.bone2 })}>
              {m.noTrades ? "no trades in the last 30 days" : "30-day record unavailable: the indexer did not answer"}
            </div>
          )}
          {m.verdict && <Figure label="AI guard" value={m.verdict} gold={m.verdict === "CAUTION"} last />}
        </div>
        <div style={row({ fontFamily: MONO, fontSize: 19, color: C.bone2 })}>{m.followers ?? "followers: the hub's log did not answer"}</div>
      </div>
    </Plate>
  );
}

/** A thesis: its name, its legs drawn by weight (long filled, short hollow: shape, not colour), its minimum. */
export function ThesisCard({ m }: { m: ThesisCardModel }) {
  return (
    <Plate kicker={`thesis #${m.id} · v${m.version} · dreamDEX perps`} footer={`read ${m.asOf} from the ThemeRegistry and each leg's pool`}>
      <div style={col({ flexGrow: 1, justifyContent: "space-between" })}>
        <div style={col({ gap: 12 })}>
          <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: m.name.length > 22 ? 76 : 100, letterSpacing: "-0.045em", lineHeight: 0.95 }}>{m.name}</span>
          <span style={{ fontFamily: MONO, fontSize: 18, color: C.night4 }}>
            {`by ${m.creator}${m.ours ? " · Copybook's wallet" : ""} · gross ${m.gross} · net ${m.net}`}
          </span>
        </div>
        <div style={col({ gap: 10 })}>
          {m.legs.map((l) => (
            <div key={l.market} style={row({ alignItems: "center", gap: 20 })}>
              <span style={{ width: 230, fontFamily: DISPLAY, fontWeight: 600, fontSize: 30, letterSpacing: "-0.01em" }}>{l.market}</span>
              <span style={{ width: 90, fontFamily: MONO, fontSize: 18, color: C.bone2 }}>{l.side}</span>
              <div style={row({ width: 420, height: 14 })}>
                <div
                  style={{
                    display: "flex",
                    width: Math.max(10, Math.round(420 * l.share)),
                    height: 14,
                    borderRadius: 999,
                    ...(l.side === "long" ? { backgroundColor: C.bone } : { border: `1.5px dashed ${C.bone}` }),
                  }}
                />
              </div>
              <span style={{ fontFamily: MONO, fontSize: 22, color: C.bone }}>{l.pct}</span>
            </div>
          ))}
          {m.more > 0 && <span style={{ fontFamily: MONO, fontSize: 16, color: C.night4 }}>{`and ${m.more} more leg${m.more === 1 ? "" : "s"}`}</span>}
        </div>
        <div style={row({ alignItems: "flex-end", justifyContent: "space-between" })}>
          {m.opensFrom ? (
            <Figure label="opens from, at today's marks" value={m.opensFrom} last />
          ) : (
            <span style={{ fontFamily: MONO, fontSize: 18, color: C.bone2 }}>minimum unknown: a leg's market did not answer</span>
          )}
          <span style={{ fontFamily: MONO, fontSize: 19, color: C.bone2 }}>{m.followers ?? "followers: the hub's log did not answer"}</span>
        </div>
      </div>
    </Plate>
  );
}

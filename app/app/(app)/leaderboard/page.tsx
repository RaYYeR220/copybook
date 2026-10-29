import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { getAddress, type Address } from "viem";
import { sourceIdOf } from "@copybook/sdk";
import { Ledger } from "@/components/Ledger";
import b from "@/components/app/Board.module.css";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { SourceLead, SourceLedger, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { DataState } from "@/components/app/State";
import t from "@/components/app/Table.module.css";
import { fmtInt, shortHex } from "@/lib/format";
import { FEW_EVENTS, boardRows, fidelityParts, fidelityText, rankRows, type BoardRow, type RankBy } from "@/lib/leaderboard";
import { REASON_LABEL } from "@/lib/reasons";
import { hubLog } from "@/lib/server/chain";
import { config } from "@/lib/server/config";
import { thesisList } from "@/lib/server/theses";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Traders and theses followed through Copybook, ranked by who follows them now and by how many of their moves the hub copied.",
};

type Props = { searchParams: Promise<{ by?: string }> };

const traderOf = (ref: bigint): Address => getAddress(`0x${ref.toString(16).padStart(40, "0")}`);

/** On phones the rank column folds away: the rank (or that there is none) rides on the kind line. */
const RankMark = ({ rank }: { rank: number | null }) => <span className={b.rankM}>{rank === null ? "unranked · " : `#${rank} · `}</span>;

function Source({ r, rank, names }: { r: BoardRow; rank: number | null; names: Map<string, { name: string; creator: Address }> }) {
  if (r.kind === "Trader") {
    const a = traderOf(r.ref);
    const demo = a.toLowerCase() === config.demoLeader.toLowerCase();
    return (
      <>
        <Link href={`/t/${a}`} className={t.addr} title={a} prefetch={false}>
          {shortHex(a)}
        </Link>
        <span className={b.kind}>
          <RankMark rank={rank} />
          trader{demo && <span className={b.ours}>demo leader · ours</span>}
        </span>
      </>
    );
  }
  const th = names.get(r.ref.toString());
  const ours = !!th && config.isOurs(th.creator);
  return (
    <>
      <Link href={`/thesis/${r.ref}`} prefetch={false}>
        {th?.name ?? `Thesis #${r.ref}`}
      </Link>
      <span className={b.kind}>
        <RankMark rank={rank} />
        thesis #{r.ref.toString()}
        {ours && <span className={b.ours}>ours</span>}
      </span>
    </>
  );
}

const reasons = (r: BoardRow) =>
  Object.entries(r.refusedBy)
    .sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))
    .map(([k, n]) => `${REASON_LABEL[k as keyof typeof REASON_LABEL] ?? k} ${n}`)
    .join(" · ");

/** Sources followed through the hub, from the hub's own log: who follows them now, and how much of their moves got copied. */
export default async function Leaderboard({ searchParams }: Props) {
  const by: RankBy = (await searchParams).by === "fidelity" ? "fidelity" : "followers";
  const [logR, thesesR] = await Promise.allSettled([hubLog.read({ budgetMs: 20_000 }), thesisList()]);
  after(() => hubLog.settled());
  const theses = thesesR.status === "fulfilled" ? thesesR.value : [];
  const names = new Map(theses.map((x) => [x.id, { name: x.name, creator: x.creator }]));
  const log = logR.status === "fulfilled" ? logR.value : null;
  const rows = log ? boardRows(log.events, theses.map((x) => ({ sourceId: sourceIdOf("Theme", BigInt(x.id)), kind: "Theme" as const, ref: BigInt(x.id) }))) : [];
  const ranked = rankRows(rows, by);
  const traders = rows.filter((r) => r.kind === "Trader").length;

  return (
    <AppMain label="Leaderboard">
      <Col>
        <Panel id="lb-h" order={1}>
          <SourceTop kick="Leaderboard" step={log ? `read to blk #${fmtInt(log.toBlock)}` : "hub's log not answering"} quiet={!log} />
          <SourceTitle id="lb-h">Leaderboard</SourceTitle>
          <SourceLead>
            Every trader and thesis followed through Copybook, ranked by <b>who follows them now</b> or by <b>copy fidelity</b>: how many of the increases the hub tried for their
            followers it copied. All of it is counted from the hub&apos;s own events.
          </SourceLead>
          <nav className={b.sort} aria-label="Rank by">
            <Link href="/leaderboard" aria-current={by === "followers" ? "page" : undefined} prefetch={false}>
              By followers
            </Link>
            <Link href="/leaderboard?by=fidelity" aria-current={by === "fidelity" ? "page" : undefined} prefetch={false}>
              By copy fidelity
            </Link>
          </nav>
          {log && (
            <SourceLedger>
              <Ledger
                size="md"
                rows={[
                  { label: "Window", value: `#${fmtInt(log.fromBlock)} → #${fmtInt(log.toBlock)}`, note: "from the hub's deployment to the newest block read" },
                  { label: "Hub and gate events", value: <b>{fmtInt(log.events.length)}</b>, note: log.complete ? "the whole log" : "part of the log; the rest is still being read" },
                  { label: "Sources", value: `${traders} trader${traders === 1 ? "" : "s"} · ${rows.length - traders} thes${rows.length - traders === 1 ? "is" : "es"}` },
                ]}
              />
            </SourceLedger>
          )}
          <PanelNote>
            Testnet: every wallet that has followed through the hub so far is one of Copybook&apos;s own demo wallets, so these counts show the
            mechanics, not demand. Copybook&apos;s own sources are labelled ours; small counts say little, so n is printed next to every share.
          </PanelNote>
        </Panel>
      </Col>

      <Col>
        <Panel id="rank-h" title={by === "followers" ? "By followers" : <>By copy <em>fidelity</em></>} aside={<Kick>hub log · on chain</Kick>} order={2} d={0.05}>
          {!log ? (
            <DataState kind="unavailable" title="The hub's log could not be read from the chain.">
              The leaderboard is counted from it; reload in a moment.
            </DataState>
          ) : rows.length === 0 ? (
            <DataState kind="empty" title="No source has been followed through the hub yet." />
          ) : (
            <>
              {!log.complete && (
                <DataState kind="unavailable" title="The hub's log is still being read.">
                  {log.missing.length} block range{log.missing.length === 1 ? "" : "s"} not covered yet, so every count below is a floor. Reload in a moment.
                </DataState>
              )}
              <table className={`${t.table} ${b.board}`}>
                <caption className="sr-only">Sources ranked {by === "followers" ? "by followers now" : "by copy fidelity"}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={t.rank}>
                      #
                    </th>
                    <th scope="col">Source</th>
                    <th scope="col" className={t.num}>
                      Following
                    </th>
                    <th scope="col" className={t.num}>
                      Copied
                    </th>
                    <th scope="col" className={t.num}>
                      Refused
                    </th>
                    <th scope="col" className={t.num}>
                      Fidelity
                    </th>
                    <th scope="col" className={t.num}>
                      Exits
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map(({ row: r, rank }) => (
                    <tr key={r.sourceId} data-source={r.kind} data-few={r.few ? "" : undefined}>
                      <td className={t.rank}>{rank ?? "·"}</td>
                      <td className={t.name}>
                        <Source r={r} rank={rank} names={names} />
                      </td>
                      <td className={t.num} data-label="Following">
                        <b>{fmtInt(r.followersNow)}</b>
                        <span className={b.why}>{fmtInt(r.followersEver)} ever</span>
                      </td>
                      <td className={t.num} data-label="Copied">
                        <b>{fmtInt(r.copied)}</b>
                      </td>
                      <td className={t.num} data-label="Refused">
                        <b>{fmtInt(r.refused)}</b>
                        {r.refused > 0 && <span className={b.why}>{reasons(r)}</span>}
                      </td>
                      <td className={`${t.num} ${t.full}`} data-label="Fidelity">
                        {fidelityParts(r) ? (
                          <>
                            <b>{fidelityParts(r)!.pct}</b>
                            <span className={b.why}>{fidelityParts(r)!.counts}</span>
                          </>
                        ) : (
                          <span className={t.dim}>{fidelityText(r)}</span>
                        )}
                        {r.few && <span className={b.few}>few events</span>}
                      </td>
                      <td className={t.num} data-label="Exits">
                        {fmtInt(r.exits)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <dl className={b.notes} aria-label="What each column counts">
            <div>
              <dt>#</dt>
              <dd>By followers every source is ranked. By copy fidelity only a source with at least {FEW_EVENTS} decisions (Copied + Refused) is; the rest follow, unranked.</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                A trader some wallet followed through the hub, or a thesis in the ThemeRegistry. Ours: Copybook&apos;s demo leader, and theses published from a wallet Copybook runs.
              </dd>
            </div>
            <div>
              <dt>Following</dt>
              <dd>Wallets whose latest Followed event names this source, with no Unfollowed after it. Ever: distinct wallets that followed it at any point.</dd>
            </div>
            <div>
              <dt>Copied</dt>
              <dd>
                A trader: Copied events that grew a follower&apos;s position (opened it, added to it, or put it on the other side). A thesis: syncs, one per follower per
                transaction, whose increases went through with nothing refused; its legs open as one set, so a sync is one decision however many legs moved.
              </dd>
            </div>
            <div>
              <dt>Refused</dt>
              <dd>
                A trader: Refused events, every reason, named under the count. A thesis: syncs with any refusal in them, each reason counted once per sync; a sync with a refusal counts as
                refused even when some leg moved in it.
              </dd>
            </div>
            <div>
              <dt>Fidelity</dt>
              <dd>Copied ÷ (Copied + Refused), floored to a tenth of a percent, always with both counts. Fewer than {FEW_EVENTS} is flagged few events.</dd>
            </div>
            <div>
              <dt>How it leans</dt>
              <dd>
                A trader&apos;s figure reads low where a refusal was an exit the venue left unfilled or rejected (Band, Venue rejected: the event does not say which half of a sync it came
                from), and where a partly filled increase counts once each way. A thesis&apos;s reads low where the only refusal in a sync was such an exit. For both, a follower the
                handler deferred for gas (Deferred) is not counted until catchUp answers it.
              </dd>
            </div>
            <div>
              <dt>Exits</dt>
              <dd>Copied events that shrank or closed a position. Not part of fidelity: the hub never gates them.</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>Every hub event from its deployment to the block read, through follows, copies by the validators&apos; handler and copies by direct calls (follow, catchUp, resync).</dd>
            </div>
          </dl>
        </Panel>
        <Colophon>
          Hub <b>{shortHex(config.deployments.hub)}</b> · ThemeRegistry <b>{shortHex(config.deployments.themes)}</b> · Somnia Hideki testnet
        </Colophon>
      </Col>
    </AppMain>
  );
}

"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { eventKey, type Market } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { ConnectButton } from "@/components/ConnectButton";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { HubFeedProvider, useHubFeed } from "@/components/app/HubFeed";
import { useNow } from "@/components/app/HoldClock";
import { FeedStatusLine, TapeRows, type TapeNames } from "@/components/app/LiveTape";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { SourceActs, SourceLead, SourceLedger, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { DataState } from "@/components/app/State";
import { Call, TxLine } from "@/components/follow/parts";
import { txFor, useReader, useTx, useWalletInstalled, useWriter } from "@/components/follow/hooks";
import { fmtInt, shortHex } from "@/lib/format";
import { fromJsonSafe } from "@/lib/json";
import { currentFollowEvent, followTerms, lastRefusals, openDeferral, refusalCounts, tankStats } from "@/lib/me/activity";
import { catchUpOffer, gateIncreases, themeBook, traderBook, traderPools } from "@/lib/me/book";
import { ourWalletLabels } from "@/lib/ours";
import { dashboardBanners, offerOnOpen, withdrawable } from "@/lib/me/issues";
import { readMe, readPools, type MeReads } from "@/lib/me/read";
import type { PublicConfig } from "@/lib/publicConfig";
import type { MarketMeta } from "@/lib/tape";
import { fmtStt, fmtUsd18 } from "@/lib/units";
import { hideki } from "@/lib/wallet/hideki";
import { Banners } from "./Banners";
import { BookTable } from "./BookTable";
import { GuardCard } from "./GuardCard";
import { Refusals } from "./Refusals";
import { SourceCard, type Drawer } from "./SourceCard";
import { TankPanel } from "./TankPanel";
import styles from "./Me.module.css";

interface Props {
  pub: PublicConfig;
  markets: Record<string, MarketMeta>;
  theses: { id: string; name: string }[];
  /** lower-case trader address → label (the demo leader). */
  traders: Record<string, string>;
  renderedAt: number;
}

const lc = (a: string) => a.toLowerCase();

/** The follower dashboard: the connected wallet's follow, read from the chain on every load and after every transaction. */
export function Dashboard(props: Props) {
  const { address, chainId, status } = useAccount();
  const installed = useWalletInstalled();
  const who = address ? getAddress(address) : undefined;
  const connected = (status === "connected" || status === "reconnecting") && !!who;

  if (!connected || chainId !== hideki.id)
    return (
      <AppMain label="Dashboard">
        <Col>
          <Panel id="src-h" order={1}>
            <SourceTop kick="Dashboard" />
            <SourceTitle id="src-h">{connected ? "Wrong network" : "Your follow"}</SourceTitle>
            <SourceLead>
              {connected
                ? `The wallet is on another network. Copybook runs on ${hideki.name} (chain ${hideki.id}); switch to see this wallet's follow and send its calls.`
                : installed
                  ? "Connect the wallet that follows a trader or a thesis. Everything here is read from the chain for that wallet: its book against the source's, every copy and refusal, the AI guard and the gas tank."
                  : "This browser has no wallet. Install one, such as Rabby or MetaMask, to see a follow and send its calls."}
            </SourceLead>
            <SourceActs>
              <ConnectButton inline />
            </SourceActs>
          </Panel>
        </Col>
      </AppMain>
    );

  return (
    <HubFeedProvider key={who} pub={props.pub} follower={who} cap={1000}>
      <Mine {...props} who={who} />
    </HubFeedProvider>
  );
}

function Mine({ pub, markets, theses, traders, renderedAt, who }: Props & { who: Address }) {
  const reader = useReader(pub);
  const writer = useWriter(reader);
  const feed = useHubFeed();
  const qc = useQueryClient();
  const now = useNow(renderedAt);
  const [drawer, setDrawer] = useState<Drawer>(null);

  const me = useQuery({ queryKey: ["me", who], queryFn: () => readMe(reader.copybook, reader.publicClient, who), refetchInterval: 30_000, retry: 1 });
  const refetchAll = () => {
    void qc.invalidateQueries({ queryKey: ["me", who] });
    void qc.invalidateQueries({ queryKey: ["book", who] });
  };
  const tx = useTx(who, reader.publicClient, refetchAll);

  // a new event for this wallet (a copy, a refusal, a charge) re-reads the chain, once things settle
  const newest = feed.events[0] ? eventKey(feed.events[0]) : "";
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!feed.loaded) return;
    if (seen.current === null) {
      seen.current = newest;
      return;
    }
    if (seen.current === newest) return;
    seen.current = newest;
    const t = setTimeout(refetchAll, 1_500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest, feed.loaded]);

  // the wallets Copybook runs keep their labels; this wallet is "you", whoever it is
  const names: TapeNames = useMemo(
    () => ({ markets, theses, traders, wallets: { ...ourWalletLabels(reader.deployments), [lc(who)]: "you" } }),
    [markets, theses, traders, who, reader.deployments],
  );

  if (!me.data && !me.isError)
    return (
      <AppMain label="Dashboard">
        <Col>
          <Panel id="src-h" order={1}>
            <SourceTop kick="Dashboard" />
            <SourceTitle id="src-h" address>
              {shortHex(who)}
            </SourceTitle>
            <DataState kind="loading" title="Reading this wallet's follow from the chain…">
              The follow and its policy, the tank, latched exits and stops, the guard, the grant and the perps equity.
            </DataState>
          </Panel>
        </Col>
      </AppMain>
    );
  if (!me.data)
    return (
      <AppMain label="Dashboard">
        <Col>
          <Panel id="src-h" order={1}>
            <SourceTop kick="Dashboard" />
            <SourceTitle id="src-h" address>
              {shortHex(who)}
            </SourceTitle>
            <DataState kind="unavailable" title="The chain did not answer.">
              {me.error instanceof Error ? me.error.message : "The reads failed"}. Nothing is known about this wallet&apos;s follow right now, so nothing is offered.
            </DataState>
            <SourceActs>
              <Button size="md" onClick={() => void me.refetch()}>
                Read again
              </Button>
            </SourceActs>
          </Panel>
        </Col>
      </AppMain>
    );

  const data = me.data;
  if (!data.status.follow) return <NotFollowing who={who} data={data} names={names} reader={reader} writer={writer} tx={tx} />;
  return <Following who={who} data={data} names={names} markets={markets} traders={traders} pub={pub} reader={reader} writer={writer} tx={tx} now={now} drawer={drawer} setDrawer={setDrawer} />;
}

interface FollowingProps {
  who: Address;
  data: MeReads;
  names: TapeNames;
  markets: Record<string, MarketMeta>;
  traders: Record<string, string>;
  pub: PublicConfig;
  reader: ReturnType<typeof useReader>;
  writer: ReturnType<typeof useWriter>;
  tx: ReturnType<typeof useTx>;
  now: number;
  drawer: Drawer;
  setDrawer: (d: Drawer) => void;
}

function Following({ who, data, names, markets, traders, pub, reader, writer, tx, now, drawer, setDrawer }: FollowingProps) {
  const feed = useHubFeed();
  const st = data.status;
  const follow = st.follow!;
  const trader = follow.kind === "Trader" ? follow.trader : undefined;

  const followEv = currentFollowEvent(feed.events, who, follow.sourceId);
  const since = followEv?.log.blockNumber;
  const followTx = followEv?.log.transactionHash;

  // the market list, from the follow transaction itself
  const terms = useQuery({
    queryKey: ["terms", followTx],
    // null: the transaction is there but is not a plain follow call (sent through a contract)
    queryFn: async () => followTerms((await reader.publicClient.getTransaction({ hash: followTx! })).input),
    enabled: !!trader && !!followTx,
    staleTime: Infinity,
    retry: 1,
  });
  const joinPools: Address[] | null | undefined = !trader
    ? []
    : followTx
      ? terms.isError
        ? null
        : terms.data === undefined
          ? undefined
          : (terms.data?.joinPools ?? null)
      : // no Followed event read yet: unknown while the history is still being read, missing once it is whole
        feed.loaded && feed.complete
        ? null
        : undefined;
  const termsNote: "reading" | "not-found" | "not-plain" | "unread" | undefined =
    !trader || (joinPools !== null && joinPools !== undefined)
      ? undefined
      : joinPools === undefined
        ? "reading"
        : !followTx
          ? "not-found"
          : terms.isError
            ? "unread"
            : "not-plain";
  // a refusal still unread could make a market look never tried: nothing is offered until the history is whole
  const refusalsRead = feed.loaded && feed.complete;

  const held = useQuery({
    queryKey: ["held", trader],
    queryFn: async () => {
      const r = await fetch(`/api/positions/${trader}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return fromJsonSafe<{ positions: { pool: Address }[] }>(await r.json()).positions.map((p) => getAddress(p.pool));
    },
    enabled: !!trader,
    refetchInterval: 60_000,
    retry: 1,
  });

  const pools = useMemo(() => {
    if (follow.kind === "Theme") {
      const out = new Map<string, Address>();
      for (const l of st.theme?.legs ?? []) out.set(lc(l.pool), l.pool);
      for (const s of st.synced) if (!out.has(lc(s))) out.set(lc(s), s);
      return [...out.values()];
    }
    // while the follow's market list is still unknown, the book covers the markets the hub has synced for you
    return traderPools(st.synced, joinPools ?? null, held.data ?? []);
  }, [follow.kind, st.theme, st.synced, joinPools, held.data]);

  const book = useQuery({
    queryKey: ["book", who, pools.join(","), trader ?? ""],
    queryFn: () => readPools(reader.copybook, who, pools, trader),
    refetchInterval: 30_000,
    retry: 1,
  });

  const refusalsByPool = useMemo(() => lastRefusals(feed.events, since ?? 0n), [feed.events, since]);

  const blocked = !!data.verdict?.blocking && st.guardOn;
  const rows = useMemo(() => {
    if (!book.data) return undefined;
    if (follow.kind === "Theme") return themeBook(follow.policy, st.theme?.legs ?? [], book.data, refusalsByPool);
    // the gates an increase meets now, read from the chain: a market whose only move they refuse is not offered
    return gateIncreases(traderBook(follow.policy, book.data, refusalsByPool), {
      paused: follow.paused,
      equityFloor: follow.policy.equityFloor,
      equity: data.equity,
      maxTotalNotional: follow.policy.maxTotalNotional,
      tank: st.tank,
      blocked,
      synced: st.synced,
    });
  }, [book.data, follow.kind, follow.policy, follow.paused, st.theme, st.tank, st.synced, data.equity, blocked, refusalsByPool]);
  const marketsRead = useMemo(() => Object.fromEntries((book.data ?? []).map((p) => [lc(p.pool), p.market])) as Record<string, Market | null>, [book.data]);

  const marketName = (a: string) => (markets[lc(a)] ? `${markets[lc(a)]!.symbol}-PERP` : undefined);
  const banners = dashboardBanners({
    status: st,
    catchUp: trader && rows ? catchUpOffer(rows) : undefined,
    refusalsRead,
    deferredAt: openDeferral(feed.events, since ?? 0n),
    approved: data.approved,
    names: marketName,
  });
  const offer = offerOnOpen(banners);
  const counts = refusalCounts(feed.events, since ?? 0n);
  const totalRefusals = counts.reduce((s, c) => s + c.n, 0);
  const stats = tankStats(feed.events, st.tank, since);
  const inStep = rows ? { n: rows.filter((r) => r.state === "in-step" || r.state === "flat").length, of: rows.length } : undefined;
  const name = follow.kind === "Trader" ? (traders[lc(trader!)] ? `${traders[lc(trader!)]}` : shortHex(trader!)) : (st.theme?.name ?? `Thesis #${follow.themeId}`);
  const sourceLabel = follow.kind === "Trader" ? `trader ${shortHex(trader!)}` : `thesis ${name}`;

  return (
    <AppMain label={`Dashboard: following ${sourceLabel}`}>
      <Recalled tx={tx} />
      <Banners banners={banners} offer={offer} writer={writer} tx={tx} onFixPolicy={() => setDrawer("policy")} />
      <Col>
        <Panel id="src-h" order={1} d={0.03}>
          <SourceCard
            who={who}
            follow={follow}
            name={name}
            versions={st.theme && st.themeSync ? { thesis: st.theme.version, synced: st.themeSync.syncedVersion } : undefined}
            since={since}
            joinPools={joinPools}
            termsNote={termsNote}
            held={held.data ?? []}
            guardOn={st.guardOn}
            approved={data.approved}
            equity={data.equity}
            inStep={inStep}
            stopped={follow.paused}
            flattenPending={st.pending.flattenPending}
            markets={markets}
            reader={reader}
            writer={writer}
            tx={tx}
            drawer={drawer}
            setDrawer={setDrawer}
          />
        </Panel>
        <Panel id="guard-h" title="AI guard" aside={<Kick>Validators&apos; verdict · on chain</Kick>} order={2} d={0.08}>
          <GuardCard kind={follow.kind} trader={trader} verdict={data.verdict} guardOn={st.guardOn} pub={pub} now={now} writer={writer} tx={tx} />
        </Panel>
        <Panel id="gas-h" title="Gas tank" aside={<Kick>Pays for every run</Kick>} order={5} d={0.12}>
          <TankPanel tank={st.tank} stats={stats} sinceKnown={since !== undefined} following writer={writer} tx={tx} balance={data.balance} />
        </Panel>
      </Col>
      <Col>
        <Panel id="book-h" title={<>Your book <em>vs</em> theirs</>} aside={<Kick>{follow.kind === "Trader" ? `per market · scale ${(follow.policy.scaleBps / 10_000).toString()}×` : `per leg · ${fmtUsd18(follow.policy.allocation)}`}</Kick>} order={3} d={0.05}>
          <BookTable
            kind={follow.kind}
            rows={rows}
            markets={marketsRead}
            names={markets}
            sourceLabel={sourceLabel}
            loading={book.isLoading}
            refusalsRead={refusalsRead}
            error={book.error instanceof Error ? book.error.message : undefined}
          />
          {trader && held.isError && <PanelNote>The dreamDEX indexer did not list the trader&apos;s open markets, so only the markets the hub has traded for you are shown.</PanelNote>}
        </Panel>
        <Panel id="feed-h" title="Live copy feed" aside={<FeedStatusLine extra="this wallet · newest first" />} order={4} d={0.1}>
          <TapeRows names={names} label="Copies, refusals and stops for this wallet, newest first" empty="Nothing for this wallet yet: the first copy lands at the source's next move." />
        </Panel>
        <Panel id="ref-h" title="Refusals, by reason" aside={<Kick>{since !== undefined ? `${totalRefusals} since block #${fmtInt(since)}` : `${totalRefusals} in the events read`} · all on chain</Kick>} order={6} d={0.14}>
          <Refusals counts={counts} />
        </Panel>
        <Colophon>
          Hub <b>{shortHex(reader.deployments.hub)}</b> · RiskGate <b>{shortHex(reader.deployments.gate)}</b> · Somnia Hideki testnet · exits always copied
        </Colophon>
      </Col>
    </AppMain>
  );
}

function NotFollowing({ who, data, names, reader, writer, tx }: { who: Address; data: MeReads; names: TapeNames; reader: ReturnType<typeof useReader>; writer: ReturnType<typeof useWriter>; tx: ReturnType<typeof useTx> }) {
  const st = data.status;
  const free = withdrawable(st.tank, false);
  const mine = txFor(tx, ["withdrawTank", "revoke"]);
  const rows: LedgerRow[] = [
    { label: "Gas tank", value: <b>{fmtStt(st.tank)}</b>, note: st.tank > 0n ? "left from an earlier follow: all of it can come out" : undefined },
    { label: "Operator grant", value: data.approved === undefined ? "unread" : data.approved ? "global" : "none", note: data.approved ? "it outlives a follow until you revoke it" : undefined },
    { label: "Perps equity", value: data.equity !== null ? fmtUsd18(data.equity) : "unread" },
    { label: "AI guard", value: st.guardOn ? "On" : "Off", note: "applies to the next trader this wallet follows" },
  ];
  return (
    <AppMain label="Dashboard: not following">
      <Recalled tx={tx} />
      <Col>
        <Panel id="src-h" order={1}>
          <SourceTop kick="Dashboard" step="not following" quiet />
          <SourceTitle id="src-h">Not following</SourceTitle>
          <SourceLead>
            This wallet <b>{shortHex(who)}</b> follows nothing right now. Pick a trader or a thesis on Discover; a fresh wallet per source keeps each book a clean copy.
          </SourceLead>
          <SourceLedger>
            <Ledger size="md" rows={rows} />
          </SourceLedger>
          <SourceActs>
            <Button size="md" href="/app" prefetch={false} arrow>
              Find a source on Discover
            </Button>
            {free > 0n && (
              <Button size="md" variant="secondary" disabled={tx.busy} onClick={() => tx.run("withdrawTank", () => writer().withdrawTank(free))}>
                Withdraw {fmtStt(free)}
              </Button>
            )}
          </SourceActs>
          {data.approved && (
            <div className={styles.revoke}>
              <PanelNote>
                Revoking ends the hub&apos;s permission to place orders for this wallet. Following again asks for it first.
              </PanelNote>
              <Call>
                <b>setOperatorApprovalGlobal</b>(hub {shortHex(reader.deployments.hub)}, [placeOrderFor], false) on {shortHex(reader.deployments.operatorRegistry)}
              </Call>
              <SourceActs>
                <Button size="md" variant="quiet" disabled={tx.busy} onClick={() => tx.run("revoke", () => writer().approveOperator(false))}>
                  Revoke the operator grant
                </Button>
              </SourceActs>
            </div>
          )}
          <div className={styles.txBox}>
            <TxLine tx={mine} recalled={tx.recalled} />
          </div>
        </Panel>
      </Col>
      <Col>
        <Panel id="feed-h" title="This wallet's history" aside={<FeedStatusLine extra="newest first" />} order={2} d={0.06}>
          <TapeRows names={names} label="Copybook events for this wallet, newest first" empty="This wallet has never followed through Copybook." />
        </Panel>
        <Colophon>
          Hub <b>{shortHex(reader.deployments.hub)}</b> · Somnia Hideki testnet
        </Colophon>
      </Col>
    </AppMain>
  );
}

/** A transaction this wallet sent before the page loaded, until it lands: shown once, above everything. */
function Recalled({ tx }: { tx: ReturnType<typeof useTx> }) {
  const t = txFor(tx, [], true);
  if (t.phase === "idle") return null;
  return (
    <div className={styles.recalled}>
      <TxLine tx={t} recalled />
    </div>
  );
}

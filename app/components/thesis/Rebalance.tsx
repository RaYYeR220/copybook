"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import type { Leg } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { ConnectButton } from "@/components/ConnectButton";
import { Kick, Panel } from "@/components/app/Panel";
import { useReader, useTx, useWriter } from "@/components/follow/hooks";
import { Acts, Block, Call, Hint, TxLine } from "@/components/follow/parts";
import f from "@/components/follow/Flow.module.css";
import { bpsToPct, checkRebalance, legDiff, rebalanceWait, type BasketRow, type RegistryRules } from "@/lib/builder/basket";
import { readUpdatedAt, type BasketMinimum } from "@/lib/builder/registry";
import { fmtInt, shortHex } from "@/lib/format";
import { fromJsonSafe } from "@/lib/json";
import type { PublicConfig } from "@/lib/publicConfig";
import type { MarketMeta } from "@/lib/tape";
import { fmtDuration, fmtUsd18, fmtUtc } from "@/lib/units";
import { hideki } from "@/lib/wallet/hideki";
import { FollowerTerms } from "./FollowerTerms";
import { useChainClock } from "./hooks";
import { IssueList, LegsEditor } from "./LegsEditor";
import { LegsCall, MinimumBox, ShapeLedger } from "./Summary";
import { useBasket } from "./useBasket";
import styles from "./Builder.module.css";

export interface RebalanceThesis {
  id: bigint;
  creator: Address;
  version: number;
  legs: Leg[];
}

interface Props {
  pub: PublicConfig;
  /** `RebalanceThesis`, JSON-safe. */
  thesis: unknown;
  markets: Record<string, MarketMeta>;
  registered: Record<string, boolean>;
  bank: Address | null;
  rules: RegistryRules;
}

const rowsOf = (legs: readonly Leg[], version: number): BasketRow[] =>
  legs.map((l, i) => ({ key: `v${version}-${i}`, pool: l.pool, side: l.weightBps < 0 ? "short" : "long", weight: bpsToPct(l.weightBps) }));

const signed = (bps: number) => (bps === 0 ? "flat" : `${bps < 0 ? "short" : "long"} ${bpsToPct(bps)}%`);

/** Current followers' allocations and caps, from the hub's log and their follows on chain. */
function useFollowerPolicies(id: bigint, cb: ReturnType<typeof useReader>["copybook"]) {
  return useQuery({
    queryKey: ["thesis-follower-policies", id.toString()],
    queryFn: async () => {
      const r = await fetch(`/api/history?source=${id}&limit=1`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = fromJsonSafe<{ summary?: { followers?: { current: Address[] } }; complete: boolean }>(await r.json());
      const current = body.summary?.followers?.current ?? [];
      const sample = current.slice(0, 25);
      const follows = await Promise.all(sample.map((a) => cb.followOf(a).catch(() => null)));
      return {
        count: current.length,
        complete: body.complete,
        policies: follows.filter((x): x is NonNullable<typeof x> => !!x && x.themeId === id).map((x) => ({ follower: x.follower, allocation: x.policy.allocation, maxNotional: x.policy.maxNotional })),
      };
    },
    staleTime: 30_000,
    retry: 1,
  });
}

/** How many of the current followers the new minimum would leave short, at these marks. */
function FollowersNote({ q, minimum }: { q: ReturnType<typeof useFollowerPolicies>; minimum: BasketMinimum }) {
  if (q.isPending) return <p className={f.checking}>Counting who follows this thesis from the hub&apos;s log…</p>;
  if (q.isError) return <p className={f.checking}>The hub&apos;s log did not answer, so who follows this thesis now is unknown.</p>;
  const d = q.data;
  const floor = d.complete ? "" : "at least ";
  if (d.count === 0) return <p className={f.checking}>Nobody follows this thesis now{d.complete ? "" : " (as far as the log has been read)"}, so a rebalance moves no book.</p>;
  if (minimum.status !== "ok")
    return (
      <p className={f.checking}>
        {floor}
        {d.count} wallet{d.count === 1 ? "" : "s"} follow{d.count === 1 ? "s" : ""} this thesis now. Their allocations are compared once every leg&apos;s market is read.
      </p>
    );
  const m = minimum.minimum;
  const short = d.policies.filter((p) => p.allocation < m.allocation || p.maxNotional < m.maxNotional);
  return (
    <p className={f.checking} data-short={short.length}>
      {floor}
      {d.count} wallet{d.count === 1 ? "" : "s"} follow{d.count === 1 ? "s" : ""} this thesis now
      {d.policies.length < d.count ? ` (${d.policies.length} read)` : ""}.{" "}
      {short.length === 0
        ? `Every allocation read is at least ${fmtUsd18(m.allocation, "up")} with a cap of at least ${fmtUsd18(m.maxNotional, "up")}, so each new leg can open for them at these marks.`
        : `${short.length} ${short.length === 1 ? "has an allocation or cap" : "have allocations or caps"} below ${fmtUsd18(m.allocation, "up")} / ${fmtUsd18(m.maxNotional, "up")}: when a leg they do not hold has to open, their whole set of increases is held back (BelowMinimum), and their reductions still run.`}
    </p>
  );
}

/**
 * The creator's rebalance, on the thesis page. Shown to the wallet that created the thesis only: the registry
 * refuses anyone else (NotCreator), and the form says why before anything is signed.
 */
export function RebalancePanel(props: Props) {
  const thesis = useMemo(() => fromJsonSafe<RebalanceThesis>(props.thesis), [props.thesis]);
  const { address } = useAccount();
  // nothing is read for anyone else: the panel does not exist for them
  if (!address || address.toLowerCase() !== thesis.creator.toLowerCase()) return null;
  return <RebalanceForm {...props} thesis={thesis} who={getAddress(address)} />;
}

function RebalanceForm({ pub, thesis, who, markets, registered, bank, rules }: Omit<Props, "thesis"> & { thesis: RebalanceThesis; who: Address }) {
  const reader = useReader(pub);
  const writer = useWriter(reader);
  const router = useRouter();
  const { chainId, status } = useAccount();

  const [rows, setRows] = useState<BasketRow[]>(() => rowsOf(thesis.legs, thesis.version));
  useEffect(() => setRows(rowsOf(thesis.legs, thesis.version)), [thesis.legs, thesis.version]);

  const updated = useQuery({
    queryKey: ["thesis-updated-at", thesis.id.toString(), thesis.version],
    queryFn: () => readUpdatedAt(reader.publicClient, reader.deployments.themes, thesis.id, { creator: thesis.creator, version: thesis.version }),
    staleTime: Infinity,
    retry: 1,
  });
  const clock = useChainClock(reader.publicClient);
  const updatedAt = updated.data ?? null;
  const chainNow = clock.now;
  const tx = useTx(who, reader.publicClient, () => router.refresh(), `thesis-${thesis.id}`);

  const ctx = useMemo(() => ({ cb: reader.copybook, client: reader.publicClient, bank, markets, registered, rules }), [reader, bank, markets, registered, rules]);
  const b = useBasket(rows, ctx, (legs, registration, label) =>
    checkRebalance({
      creator: thesis.creator,
      account: who,
      current: thesis.legs,
      next: legs,
      updatedAt,
      chainNow: chainNow ?? null,
      rules,
      registered: registration,
      label,
    }),
  );
  const followers = useFollowerPolicies(thesis.id, reader.copybook);

  // the countdown runs on the browser's clock; signing waits for a block whose own timestamp is past the interval
  const opensAt = updatedAt === null ? null : updatedAt + rules.minRebalanceInterval;
  const shownWait = opensAt === null || chainNow === undefined ? 0 : rebalanceWait(updatedAt!, chainNow, rules.minRebalanceInterval);
  const confirmedOpen = opensAt === null || (clock.read !== undefined && clock.read.ts >= opensAt);
  useEffect(() => {
    if (shownWait === 0 && !confirmedOpen) void clock.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownWait, confirmedOpen]);

  const errors = b.issues.filter((x) => x.severity !== "wait");
  const waiting = !confirmedOpen;
  const ready = errors.length === 0 && !waiting && updated.isFetched && chainNow !== undefined;
  const diff = legDiff(thesis.legs, b.parsed.legs);
  const wrongChain = chainId !== hideki.id;
  const send = () => void tx.run("rebalance", () => writer().rebalance(thesis.id, b.parsed.legs));

  return (
    <Panel id="rebal-h" title="Rebalance" aside={<Kick>creator only · your wallet</Kick>} order={3} d={0.04}>
      <div className={f.body}>
        <p className={f.lead}>
          Your wallet created this thesis, so it alone can change its legs. The new weights reach every follower in the block the rebalance lands in; the version goes to{" "}
          <b>v{thesis.version + 1}</b>.
        </p>

        <div className={styles.clock} data-wait={waiting ? "" : undefined} role="status" aria-live="polite">
          {updated.isPending || chainNow === undefined ? (
            <span>Reading when this thesis last changed…</span>
          ) : opensAt === null ? (
            <span>When this thesis last changed could not be read; the gas estimate checks the {rules.minRebalanceInterval} s rule before you sign.</span>
          ) : waiting ? (
            <>
              <span>Next change accepted in</span>
              <b>{shownWait > 0 ? `${shownWait} s` : "a moment"}</b>
              <span>at {fmtUtc(opensAt)} chain time</span>
            </>
          ) : (
            <>
              <span>Last changed</span>
              <b>{fmtDuration(chainNow - updatedAt!)} ago</b>
              <span>· the registry takes a change now</span>
            </>
          )}
        </div>

        <Block title="New legs">
          <LegsEditor
            rows={rows}
            setRows={setRows}
            markets={markets}
            registered={b.registration}
            rules={rules}
            reads={b.reads}
            minimum={b.minimum}
            rowIssues={b.rowIssues}
            idPrefix="rebal"
          />
        </Block>

        <Block title="What changes">
          <ul className={styles.diff} aria-label="Change per market">
            {diff.map((d) => (
              <li key={d.pool} data-change={d.change}>
                <b>{b.label(d.pool)}</b>
                <span>
                  {signed(d.from)} → {signed(d.to)}
                </span>
                <span className={styles.change}>{d.change}</span>
              </li>
            ))}
          </ul>
        </Block>

        <Block title="What a follower needs">
          <MinimumBox minimum={b.minimum} readAt={b.readAt} label={b.label} />
          <FollowersNote q={followers} minimum={b.minimum} />
        </Block>

        <Block title="Against the registry's limits">
          <ShapeLedger legs={b.parsed.legs} rules={rules} />
        </Block>

        <IssueList issues={b.issues} label="What would stop this rebalance" onFix={(row, weight) => setRows((rs) => rs.map((r, i) => (i === row ? { ...r, weight } : r)))} />

        <Call>
          ThemeRegistry {shortHex(reader.deployments.themes)} · <LegsCall fn="rebalance" head={[thesis.id.toString()]} legs={b.parsed.legs} label={b.label} />
        </Call>

        {status !== "connected" || wrongChain ? (
          <Acts>
            <ConnectButton inline />
          </Acts>
        ) : (
          <Acts>
            <Button size="md" variant="secondary" onClick={send} disabled={!ready || tx.busy}>
              {tx.busy ? "Check your wallet…" : `Rebalance to v${thesis.version + 1}`}
            </Button>
            <Hint>
              {ready
                ? "Gas only. Followers pay their own sync from their tanks."
                : waiting
                  ? "Waiting for the registry's interval to pass."
                  : `${errors.length} point${errors.length === 1 ? "" : "s"} above to settle first.`}
            </Hint>
          </Acts>
        )}
        <TxLine tx={tx.tx} recalled={tx.recalled} />
        {tx.tx.phase === "confirmed" && <p className={styles.created}>Rebalanced in block #{fmtInt(tx.tx.block)}. The page reads the thesis again.</p>}
      </div>
      <FollowerTerms rebalance />
    </Panel>
  );
}

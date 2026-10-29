"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { MIN_TANK, sourceIdOf, type Leg, type PreflightInput } from "@copybook/sdk";
import { Ledger, type LedgerRow } from "@/components/Ledger";
import { AppMain, Col, Colophon, Kick, Panel, PanelNote } from "@/components/app/Panel";
import { SourceLedger, SourceLine, SourceTitle, SourceTop } from "@/components/app/SourceHead";
import { useNow } from "@/components/app/HoldClock";
import { addressUrl } from "@/lib/explorer";
import { NO_CHOICES, STEP_LABEL, deriveFlow, type ChainReads, type LocalChoices, type ReadsState, type StepId } from "@/lib/follow/flow";
import { marginTarget } from "@/lib/follow/margin";
import { defaultPolicyForm, parsePolicyForm, parseTank, type FormField, type PolicyFormValues } from "@/lib/follow/policyForm";
import { readFollowState } from "@/lib/follow/read";
import { fmtInt, shortHex } from "@/lib/format";
import { fromJsonSafe } from "@/lib/json";
import type { PublicConfig } from "@/lib/publicConfig";
import type { MarketMeta } from "@/lib/tape";
import { TIER_LABEL } from "@/lib/tape";
import { fmtStt, fmtUsd18, fmtUtc } from "@/lib/units";
import { verdictView } from "@/lib/verdict";
import { hideki } from "@/lib/wallet/hideki";
import { usePreflight, useReader, useTx, useWalletInstalled, useWriter } from "./hooks";
import { StepList } from "./parts";
import { StepBody } from "./StepBody";

export interface ThesisMinimumJson {
  allocation: bigint;
  recommended: bigint;
  maxNotional: bigint;
  bindingPool: Address;
}

/** What the server knows about the source, JSON-safe. */
export type FollowSource =
  | { kind: "Trader"; trader: Address; demo: boolean; held: Address[] | null }
  | { kind: "Theme"; themeId: bigint; name: string; version: number; creator: Address; legs: Leg[]; minimum: ThesisMinimumJson | null };

interface Props {
  pub: PublicConfig;
  /** `FollowSource`, JSON-safe. */
  source: unknown;
  markets: Record<string, MarketMeta>;
  renderedAt: number;
}

const DEFAULT_TANK = "0.5";

/**
 * The follow flow. The step comes from `deriveFlow` over fresh chain reads for the connected wallet; the page's
 * own state is only the policy being typed, the tank, and the person's explicit choices.
 */
export function FollowFlow({ pub, source: raw, markets, renderedAt }: Props) {
  const source = useMemo(() => fromJsonSafe<FollowSource>(raw), [raw]);
  const reader = useReader(pub);
  const writer = useWriter(reader);
  const { address, chainId, status } = useAccount();
  const installed = useWalletInstalled();
  const now = useNow(renderedAt);
  const qc = useQueryClient();

  const trader = source.kind === "Trader" ? source.trader : undefined;
  const sourceId = source.kind === "Trader" ? sourceIdOf("Trader", source.trader) : sourceIdOf("Theme", source.themeId);
  const who = address ? getAddress(address) : undefined;

  const q = useQuery({
    queryKey: ["follow-state", who, sourceId],
    queryFn: () => readFollowState(reader.copybook, reader.publicClient, who!, trader),
    enabled: !!who,
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: true,
  });
  const reads: ReadsState = !who
    ? { status: "idle" }
    : q.data && q.data.address === who
      ? { status: "ready", data: q.data }
      : q.isError
        ? { status: "error", address: who, error: q.error instanceof Error ? q.error.message : String(q.error) }
        : { status: "loading", address: who };
  const refetch = () => void qc.invalidateQueries({ queryKey: ["follow-state", who, sourceId] });

  // the page's choices belong to one account: another account starts over (its chain state decides the rest)
  const [local, setLocal] = useState<LocalChoices>(NO_CHOICES);
  const lastWho = useRef(who);
  useEffect(() => {
    if (lastWho.current !== who) setLocal(NO_CHOICES);
    lastWho.current = who;
  }, [who]);

  const thesisMax = source.kind === "Theme" ? Math.max(0, ...source.legs.map((l) => Math.abs(l.weightBps))) : 0;
  const [form, setForm] = useState<PolicyFormValues>(() =>
    defaultPolicyForm(
      source.kind,
      source.kind === "Theme" ? { recommendedAllocation: source.minimum?.recommended, maxWeightBps: thesisMax, minMaxNotional: source.minimum?.maxNotional } : undefined,
    ),
  );
  const [tankInput, setTankInput] = useState(DEFAULT_TANK);
  const tx = useTx(who, reader.publicClient, refetch);

  // the follower's own open positions: a follow resizes any of them in a market it manages
  const mineQ = useQuery({
    queryKey: ["mine", who],
    queryFn: async () => {
      const r = await fetch(`/api/positions/${who}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = fromJsonSafe<{ positions: { pool: Address; market: string | null; side: "long" | "short"; size: bigint; decimals: number | null }[] }>(await r.json()).positions;
      return rows.map((p) => ({ pool: getAddress(p.pool), market: p.market, side: p.side, size: p.size, decimals: p.decimals }));
    },
    enabled: !!who,
    staleTime: 15_000,
    retry: 1,
  });
  const mine = mineQ.data ?? (mineQ.isError ? null : undefined);

  const target = useMemo(() => marginTarget(source), [source]);
  const view = deriveFlow({
    kind: source.kind,
    sourceId,
    expectedChainId: hideki.id,
    wallet: { installed, status, address: who, chainId },
    reads,
    local,
    now,
    risk: pub.risk,
    marginTarget: target?.amount,
  });
  const data = reads.status === "ready" ? reads.data : undefined;
  const guardOn = local.guardWanted ?? data?.guardOn ?? true;

  // the policy the person is typing, and the live preflight over it
  const parsed = parsePolicyForm(source.kind, form);
  const tank = parseTank(tankInput);
  const formStep = view.step === "policy" || view.step === "guard" || view.step === "tank" || view.step === "follow";
  const preflightInput: PreflightInput | null =
    formStep && who && parsed.policy
      ? {
          account: who,
          kind: source.kind,
          source: source.kind === "Trader" ? source.trader : source.themeId,
          policy: parsed.policy,
          joinPools: parsed.joinPools,
          ...(source.kind === "Trader" && form.allowAll && source.held ? { checkPools: source.held } : {}),
          // the policy step checks the policy against the least tank; the tank step checks the real one
          tank: view.step === "policy" ? MIN_TANK : (tank ?? 0n),
          walletChainId: chainId,
          ...(data ? { walletBalance: data.balance } : {}),
          ...(source.kind === "Trader" ? { guardOn } : {}),
        }
      : null;
  const preflightKey = preflightInput ? JSON.stringify(preflightInput, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : "";
  const preflight = usePreflight(reader.copybook, preflightInput, preflightKey);

  const apply = (field: FormField | "tank", value: string) => {
    if (field === "tank") setTankInput(value);
    else if (field !== "markets") setForm((f) => ({ ...f, [field]: value }));
  };

  // short notes in the step list, all from the chain or the confirmed choices
  const notes: Partial<Record<StepId, string>> = {};
  if (who && view.steps.find((s) => s.id === "connect")?.state === "done") notes.connect = shortHex(who);
  if (chainId === hideki.id && who) notes.network = "Hideki";
  if (data) {
    if (data.equity !== null) notes.margin = `${fmtUsd18(data.equity)} equity`;
    if (data.approved) notes.approve = "granted · global";
    if (data.follow && view.followingThis) notes.follow = "on chain";
    if (local.guardWanted !== undefined) notes.guard = local.guardWanted ? "on" : "off";
  }
  if (local.policyDone && parsed.policy) notes.policy = source.kind === "Trader" ? `${(parsed.policy.scaleBps / 10_000).toString()}× · cap ${fmtUsd18(parsed.policy.maxNotional)}` : `${fmtUsd18(parsed.policy.allocation)}`;
  if (local.tankDone && tank !== null) notes.tank = fmtStt(tank);
  if (view.review === "pending") notes.review = "on its way";
  if (view.review === "fresh") notes.review = "verdict fresh";

  const at = view.steps.findIndex((s) => s.id === view.step);

  // a new step moves focus to its heading, so keyboard and screen-reader users land on it (not on first render)
  const shownStep = useRef<string | null>(null);
  useEffect(() => {
    if (shownStep.current !== null && shownStep.current !== view.step) document.getElementById("step-h")?.focus();
    shownStep.current = view.step;
  }, [view.step]);
  const title = source.kind === "Trader" ? shortHex(source.trader) : source.name;

  return (
    <AppMain label={`Follow ${source.kind === "Trader" ? `trader ${source.trader}` : `thesis ${source.name}`}`}>
      <Col>
        <Panel id="src-h" order={1}>
          <SourceTop kick={source.kind === "Trader" ? (source.demo ? <>Follow · demo leader · <b>run by Copybook</b></> : "Follow a trader") : `Follow thesis #${source.themeId}`} />
          <SourceTitle id="src-h" address={source.kind === "Trader"}>
            {title}
          </SourceTitle>
          <SourceLine>
            {source.kind === "Trader" ? (
              <>
                <a href={`/t/${source.trader}`}>{source.trader}</a> <span>· dreamDEX perps</span>
              </>
            ) : (
              <>
                <span>by</span>{" "}
                <a href={addressUrl(source.creator)} target="_blank" rel="noopener noreferrer">
                  {shortHex(source.creator)}
                </a>{" "}
                <span>
                  · v{source.version} · {source.legs.length} leg{source.legs.length === 1 ? "" : "s"} ·{" "}
                </span>
                <a href={`/thesis/${source.themeId}`}>legs and minimums</a>
              </>
            )}
          </SourceLine>
          <SourceFacts source={source} data={data} now={now} pub={pub} />
        </Panel>

        <Panel id="steps-h" title="Steps" aside={<Kick>read back from the chain</Kick>} order={3} d={0.05}>
          <StepList view={view} notes={notes} label="Follow steps" />
          <PanelNote>
            Every load reads this wallet&apos;s approval, follow, tank and margin from the chain, so the flow resumes where the chain stands: after a reload, in another tab, or a day later.
          </PanelNote>
        </Panel>
      </Col>

      <Col>
        <Panel id="step-h" focusTitle title={STEP_LABEL[view.step]} aside={<Kick>{at >= 0 ? `step ${at + 1} of ${view.steps.length}` : ""}</Kick>} order={2} d={0.03}>
          <StepBody
            view={view}
            source={source}
            pub={pub}
            reader={reader}
            writer={writer}
            data={data}
            reads={reads}
            who={who}
            tx={tx}
            local={local}
            setLocal={setLocal}
            form={form}
            setForm={setForm}
            parsed={parsed}
            tankInput={tankInput}
            setTankInput={setTankInput}
            tank={tank}
            preflight={preflight}
            preflightKey={preflightKey}
            apply={apply}
            markets={markets}
            mine={mine}
            guardOn={guardOn}
            refetch={refetch}
            now={now}
            target={target}
          />
        </Panel>
        <Colophon>
          Hub <b>{shortHex(reader.deployments.hub)}</b> · operator registry <b>{shortHex(reader.deployments.operatorRegistry)}</b> · Somnia Hideki testnet · exits always copied
        </Colophon>
      </Col>
    </AppMain>
  );
}

/** Under the source's name: for a trader the gate's verdict, for a thesis its minimum. All read, none typed. */
function SourceFacts({ source, data, now, pub }: { source: FollowSource; data: ChainReads | undefined; now: number; pub: PublicConfig }) {
  const rows: LedgerRow[] = [];
  if (source.kind === "Theme") {
    if (source.minimum) {
      rows.push({ label: "Opens from", value: <b>{fmtUsd18(source.minimum.allocation, "up")}</b>, note: "every leg opens at the marks as this page loaded" });
      rows.push({ label: "With headroom", value: fmtUsd18(source.minimum.recommended, "up") });
    } else rows.push({ label: "Opens from", value: "unknown", note: "a leg's market could not be read; the form checks it live" });
    rows.push({ label: "AI guard", value: "not applied", note: "theses are never gated" });
  } else if (data?.verdict) {
    const v = verdictView(data.verdict, now, pub.risk);
    rows.push({
      label: "AI verdict",
      value: <b>{v.reviewed ? TIER_LABEL[v.tier] : "not reviewed"}</b>,
      note: v.tier === "Block" && v.expiresAt ? (v.blocking ? `stops new size for guarded followers until ${fmtUtc(v.expiresAt)}` : "lapsed") : v.reviewed && v.reviewedAt ? `reviewed ${fmtUtc(v.reviewedAt)}` : "no validator has reviewed this trader yet",
    });
    if (data.reviewPending) rows.push({ label: "Review", value: `#${fmtInt(data.reviewPending.nonce)} pending` });
  }
  if (rows.length === 0) return null;
  return (
    <SourceLedger>
      <Ledger size="md" rows={rows} />
    </SourceLedger>
  );
}


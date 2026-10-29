"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type Dispatch, type SetStateAction } from "react";
import type { Address } from "viem";
import { MIN_TANK, MIN_TANK_FOR_INCREASE, PLACE_ORDER_FOR_SELECTOR, type Copybook, type Policy } from "@copybook/sdk";
import { Button } from "@/components/Button";
import { ConnectButton } from "@/components/ConnectButton";
import { Ledger, Gold, type LedgerRow } from "@/components/Ledger";
import { DataState } from "@/components/app/State";
import { DREAMDEX_URL } from "@/content/site";
import { askValidators, type AskPhase } from "@/lib/ask";
import { txUrl } from "@/lib/explorer";
import type { ChainReads, FlowView, LocalChoices, ReadsState } from "@/lib/follow/flow";
import { suggestedDeposit, type MarginTarget } from "@/lib/follow/margin";
import type { FormField, ParsedPolicy, PolicyFormValues } from "@/lib/follow/policyForm";
import { blocks, reasonsFor } from "@/lib/follow/reasons";
import { takeovers, type HeldPosition, type Takeover } from "@/lib/follow/takeover";
import { fmtInt, shortHex } from "@/lib/format";
import type { PublicConfig } from "@/lib/publicConfig";
import type { MarketMeta } from "@/lib/tape";
import { fmtStt, fmtUnits, fmtUsd18 } from "@/lib/units";
import { hideki } from "@/lib/wallet/hideki";
import type { FollowSource } from "./FollowFlow";
import { txFor, type PreflightState, type useReader, type useTx } from "./hooks";
import { FundsHelp, MoveUsdso } from "./MoveUsdso";
import { Acts, Block, Call, Field, Hint, Lead, Notes, ReasonList, Segmented, TxLine } from "./parts";
import { PolicyFields } from "./PolicyFields";
import styles from "./Flow.module.css";

export interface StepBodyProps {
  view: FlowView;
  source: FollowSource;
  pub: PublicConfig;
  reader: ReturnType<typeof useReader>;
  writer: () => Copybook;
  data: ChainReads | undefined;
  reads: ReadsState;
  who: Address | undefined;
  tx: ReturnType<typeof useTx>;
  local: LocalChoices;
  setLocal: Dispatch<SetStateAction<LocalChoices>>;
  form: PolicyFormValues;
  setForm: Dispatch<SetStateAction<PolicyFormValues>>;
  parsed: ParsedPolicy;
  tankInput: string;
  setTankInput: (v: string) => void;
  tank: bigint | null;
  preflight: PreflightState;
  /** The inputs the current preflight answer must be for. */
  preflightKey: string;
  apply: (field: FormField | "tank", value: string) => void;
  markets: Record<string, MarketMeta>;
  /** The follower's own open positions (indexer): undefined while reading, null when it did not answer. */
  mine: HeldPosition[] | null | undefined;
  guardOn: boolean;
  refetch: () => void;
  now: number;
  /** The margin the follow should start with; undefined when unknown. */
  target?: MarginTarget;
}

const usd = (x: bigint) => fmtUsd18(x);
/** Below this much STT left after the tank, the follow transaction's own gas may not be covered. */
const GAS_HEADROOM = 10n ** 16n;

const held = (p: HeldPosition) => `${p.side} ${p.decimals !== null ? fmtUnits(p.size, p.decimals) : `${p.size} units`}`;

function takeoverText(t: Takeover, kind: FollowSource["kind"]): string {
  const what = `you hold ${held(t.position)}`;
  if (t.when === "now")
    return kind === "Theme"
      ? `${what}. The follow transaction resizes it to this leg's target from your allocation, short legs included.`
      : `${what}. The follow transaction resizes it to the trader's size here times your scale, inside your caps, and closes it if they are flat here.`;
  if (t.when === "next-move")
    return `${what}, and the trader holds this market now. At their next move here, or when you run catchUp, it is resized to theirs times your scale, inside your caps.`;
  return `${what}. If the trader trades this market while you follow, it is resized to theirs times your scale, and closed when they go flat.`;
}

/**
 * Positions the follower already holds in markets this follow would manage: the hub syncs a market to the source's
 * size whoever opened the position there, so each one is named with when it happens.
 */
function Takeovers({ source, mine, form, parsed, markets }: StepBodyProps) {
  if (mine === undefined) return <p className={styles.checking}>Reading your open positions from the dreamDEX indexer…</p>;
  if (mine === null)
    return (
      <p className={styles.checking}>
        Your open positions could not be read from the dreamDEX indexer. Any position you hold in a market this follow manages is resized to the source&apos;s size, or closed.
      </p>
    );
  const list = takeovers(
    source.kind === "Theme"
      ? { kind: "Theme", legs: source.legs }
      : { kind: "Trader", allowAll: form.allowAll, joinPools: parsed.joinPools, traderHeld: source.held },
    mine,
  );
  if (list.length === 0)
    return (
      <p className={styles.checking}>
        {mine.length === 0 ? "You hold no open perp position, so nothing of yours is taken over." : "None of your open positions is in a market this follow manages."}
      </p>
    );
  return (
    <Block title="Positions you already hold">
      <Notes>
        {list.map((t) => (
          <li key={t.position.pool} data-takeover={t.when}>
            <b>{t.position.market ?? markets[t.position.pool.toLowerCase()]?.symbol ?? shortHex(t.position.pool)}</b>: {takeoverText(t, source.kind)}
          </li>
        ))}
      </Notes>
      <p className={styles.help}>A wallet of its own for each source keeps what you trade by hand out of the follow.</p>
    </Block>
  );
}
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const scaleText = (bps: number) => `${(bps / 10_000).toString()}×`;

/** The policy as the ledger shows it, from parsed values only. */
export function policyRows(kind: FollowSource["kind"], p: Policy, extra: { markets?: string; guard?: boolean } = {}): LedgerRow[] {
  const rows: LedgerRow[] = [];
  rows.push(kind === "Trader" ? { label: "Scale", value: <b>{scaleText(p.scaleBps)}</b> } : { label: "Allocation", value: <b>{usd(p.allocation)}</b> });
  rows.push({ label: "Cap per position", value: usd(p.maxNotional) });
  rows.push({ label: "Total cap", value: p.maxTotalNotional > 0n ? usd(p.maxTotalNotional) : "none" });
  rows.push({ label: "Price band", value: `±${pct(p.bandBps)}` });
  rows.push({ label: "Equity floor", value: p.equityFloor > 0n ? usd(p.equityFloor) : "off" });
  if (extra.markets) rows.push({ label: "Markets", value: extra.markets });
  if (extra.guard !== undefined) rows.push({ label: "AI guard", value: extra.guard ? <Gold>On · validators&apos; verdict</Gold> : "Off" });
  return rows;
}

function Checking({ preflight }: { preflight: PreflightState }) {
  if (preflight.status === "checking") return <p className={styles.checking} role="status">Checking against the venue and the hub…</p>;
  if (preflight.status === "error")
    return (
      <p className={styles.checking} role="alert">
        The check could not read the chain ({preflight.error}). It runs again when you change a value.
      </p>
    );
  return null;
}

const lastResult = (p: PreflightState) => (p.status === "ready" ? p.result : p.status === "checking" || p.status === "error" ? p.last : undefined);

/**
 * The current step. A transaction sent before the page loaded (remembered across the reload) shows above whichever
 * step the chain puts the flow on, until it lands; the steps' own lines show only what this page sent.
 */
export function StepBody(props: StepBodyProps) {
  const recalled = txFor(props.tx, [], true);
  return (
    <>
      {recalled.phase !== "idle" && (
        <div className={styles.recalled} data-recalled="">
          <TxLine tx={recalled} recalled />
        </div>
      )}
      <StepContent {...props} />
    </>
  );
}

function StepContent(props: StepBodyProps) {
  const { view, source, data, reads, setLocal, refetch } = props;
  const sourceName = source.kind === "Trader" ? `trader ${shortHex(source.trader)}` : `thesis “${source.name}”`;

  switch (view.step) {
    case "connect":
      return (
        <div className={styles.body}>
          <Lead>
            Copybook copies into the wallet you connect: its own dreamDEX perps account, paid from its own gas tank on the hub. A wallet follows one source at a time, so a fresh wallet
            for each source keeps every book a clean copy.
          </Lead>
          {view.blocker === "no-wallet" && <Lead>This browser has no wallet. Install one, such as Rabby or MetaMask, then reload this page.</Lead>}
          <Acts>
            <ConnectButton inline />
          </Acts>
        </div>
      );

    case "network":
      return (
        <div className={styles.body}>
          <Lead>
            The wallet is on another network. Copybook runs on <b>{hideki.name}</b> (chain {hideki.id}), where dreamDEX perps and the hub live. Switching changes nothing on either chain.
          </Lead>
          <Acts>
            <ConnectButton inline />
          </Acts>
        </div>
      );

    case "source":
      if (view.blocker === "following-other" && data?.follow) {
        const f = data.follow;
        const href = f.kind === "Theme" ? `/thesis/${f.ref}` : `/t/0x${f.ref.toString(16).padStart(40, "0")}`;
        return (
          <div className={styles.body}>
            <Lead>
              This wallet already follows {f.kind === "Theme" ? <>thesis #{f.ref.toString()}</> : <>trader {shortHex(`0x${f.ref.toString(16).padStart(40, "0")}`)}</>}. The hub keeps one source per wallet, so
              following {sourceName} here means unfollowing that one first, on your dashboard.
            </Lead>
            <Lead>A separate wallet for this follow is cleaner: each wallet&apos;s book then mirrors exactly one source, and nothing you hold by hand gets managed by mistake.</Lead>
            <Acts>
              <Button size="md" href="/me" prefetch={false}>
                Open your dashboard
              </Button>
              <Button size="md" variant="quiet" href={href} prefetch={false}>
                What it follows now
              </Button>
            </Acts>
          </div>
        );
      }
      if (view.blocker === "read-failed")
        return (
          <div className={styles.body}>
            <DataState kind="unavailable" title="The chain did not answer.">
              {reads.status === "error" ? reads.error : "The reads failed"}. Nothing is known about this wallet yet, so no step is offered.
            </DataState>
            <Acts>
              <Button size="md" onClick={refetch}>
                Read again
              </Button>
            </Acts>
          </div>
        );
      return (
        <div className={styles.body}>
          <DataState kind="loading" title="Reading this wallet from the chain…">
            Its operator approval, current follow, perps equity, gas tank and STT balance.
          </DataState>
        </div>
      );

    case "margin":
      return <MarginStep {...props} />;

    case "approve":
      return <ApproveStep {...props} />;
    case "policy":
      return <PolicyStep {...props} />;
    case "guard":
      return <GuardStep {...props} />;
    case "tank":
      return <TankStep {...props} />;
    case "follow":
      return <FollowStep {...props} />;
    case "review":
      return <ReviewStep {...props} />;
    case "done":
      return <DoneStep {...props} sourceName={sourceName} />;
  }
}

/** What the suggested margin covers, as the margin step says it. */
const targetText = (t: MarginTarget) =>
  t.basis === "trader-cap" ? "one position at the default cap per position, held without leverage, takes" : "the basket at the suggested allocation, held without leverage, takes";

/**
 * The perps account's margin. With USDso on spot the step moves it in (approve, then deposit); with none it says
 * where testnet funds come from. Either way the person can go on: the step only says what the venue will do.
 */
function MarginStep({ view, data, reader, writer, tx, setLocal, refetch, target }: StepBodyProps) {
  const equity = data?.equity ?? null;
  const spot = data?.spot ?? null;
  const unreadable = view.blocker === "margin-unreadable";
  const low = view.blocker === "low-margin" && equity !== null && target !== undefined;
  const moving = !unreadable && spot !== null && spot > 0n;
  return (
    <div className={styles.body}>
      {unreadable ? (
        <Lead>The dreamDEX margin bank did not answer, so this wallet&apos;s perps equity is unknown right now, which is not the same as empty.</Lead>
      ) : low ? (
        <Lead>
          Copies are orders in this wallet&apos;s dreamDEX perps account. It holds <b>{fmtUsd18(equity)}</b>; {targetText(target)} <b>{fmtUsd18(target.amount)}</b>. Move more
          in from spot, or go on with what is there.
        </Lead>
      ) : (
        <>
          <Lead>
            Copies are orders in this wallet&apos;s dreamDEX perps account, and it holds no margin: equity reads <b>{equity !== null ? fmtUsd18(equity) : "—"}</b>. Until margin
            arrives the venue refuses every copy, and each refusal still costs the tank a run.
          </Lead>
          {moving && (
            <Lead>
              Move USDso in from spot here{target ? (
                <>
                  : {targetText(target)} <b>{fmtUsd18(target.amount)}</b>
                </>
              ) : null}
              .
            </Lead>
          )}
        </>
      )}
      {!unreadable &&
        (spot === null ? (
          <p className={styles.checking}>This wallet&apos;s USDso could not be read. Check again, or move it on dreamDEX with the Perps ⇆ Spot transfer.</p>
        ) : spot > 0n ? (
          <MoveUsdso id="move-usdso" spot={spot} allowance={data?.marginAllowance ?? null} initial={suggestedDeposit(equity, target?.amount, spot)} bank={reader.deployments.marginBank} writer={writer} tx={tx} />
        ) : (
          <FundsHelp />
        ))}
      <Acts>
        <Button size="md" variant={moving ? "secondary" : "primary"} disabled={tx.busy} onClick={refetch}>
          Check again
        </Button>
        {(unreadable || spot === null) && (
          <Button size="md" variant="secondary" href={DREAMDEX_URL} target="_blank">
            Open dreamDEX ↗
          </Button>
        )}
        <Button size="md" variant="quiet" disabled={tx.busy} onClick={() => setLocal((l) => ({ ...l, marginWaived: true }))}>
          {low ? `Continue with ${fmtUsd18(equity)}` : "Continue without margin"}
        </Button>
      </Acts>
    </div>
  );
}

function ApproveStep({ reader, writer, tx }: StepBodyProps) {
  const d = reader.deployments;
  const mine = txFor(tx, ["approve"]);
  return (
    <div className={styles.body}>
      <Lead>
        The hub places your copies with the venue&apos;s operator permission. This wallet grants it once, for every perps market, in one transaction to dreamDEX&apos;s operator registry.
      </Lead>
      <div className={styles.scope}>
        <div>
          <h3>It lets the hub</h3>
          <ul>
            <li>place orders for this wallet&apos;s perps account: open, increase, reduce and close positions</li>
            <li>
              through one function only, <span className="mono">placeOrderFor</span> ({PLACE_ORDER_FOR_SELECTOR})
            </li>
          </ul>
        </div>
        <div className={styles.cannot}>
          <h3>It cannot</h3>
          <ul>
            <li>withdraw or move funds out of the account</li>
            <li>cancel orders (that is a different function, not granted)</li>
          </ul>
        </div>
      </div>
      <Notes>
        <li>
          <b>It stays after you unfollow</b>, until you revoke it: your dashboard offers the same call with <span className="mono">false</span> once this wallet follows nothing.
        </li>
        <li>Global means every perps market of the venue, not one pool. The hub only trades the markets your follow manages.</li>
      </Notes>
      <Call>
        <b>setOperatorApprovalGlobal</b>(hub {shortHex(d.hub)}, [{PLACE_ORDER_FOR_SELECTOR}], true) on {shortHex(d.operatorRegistry)}
      </Call>
      <Acts>
        <Button size="md" disabled={tx.busy} onClick={() => tx.run("approve", () => writer().approveOperator(true))}>
          {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : "Approve the hub"}
        </Button>
      </Acts>
      <TxLine tx={mine} recalled={tx.recalled} />
    </div>
  );
}

function ThesisMinimum({ props }: { props: StepBodyProps }) {
  const { source, preflight } = props;
  if (source.kind !== "Theme") return null;
  const live = lastResult(preflight)?.themeMinimum;
  const min = live ? { allocation: live.allocation, recommended: live.recommendedAllocation, maxNotional: live.maxNotional } : source.minimum;
  if (!min) return <p className={styles.help}>The minimum is unknown right now: a leg&apos;s market could not be read. The check below still runs against the venue.</p>;
  return (
    <div className={styles.min} aria-label="Minimums at today's marks">
      <div>
        Opens from<b>{fmtUsd18(min.allocation, "up")}</b>
      </div>
      <div>
        With headroom<b>{fmtUsd18(min.recommended, "up")}</b>
      </div>
      <div>
        Cap at least<b>{fmtUsd18(min.maxNotional, "up")}</b>
      </div>
    </div>
  );
}

function PolicyStep(props: StepBodyProps) {
  const { source, form, setForm, parsed, preflight, preflightKey, apply, markets, setLocal, local, data, guardOn } = props;
  const result = lastResult(preflight);
  const shown = result ? reasonsFor("policy", result.reasons) : [];
  const ready = preflight.status === "ready" && preflight.key === preflightKey && !!parsed.policy && !blocks("policy", preflight.result.reasons);
  const recommended = result?.themeMinimum?.recommendedAllocation ?? (source.kind === "Theme" ? source.minimum?.recommended : undefined);
  return (
    <div className={styles.body}>
      <Lead>
        {source.kind === "Trader"
          ? "How your copies are sized and where the hub stops. Each value is checked live against the venue's markets and the hub's rules, so anything the hub would refuse shows up here, before you sign."
          : "How the basket is sized and where the hub stops. The check runs live against every leg's market: an allocation that cannot open every leg is caught here, before you sign."}
      </Lead>
      <Block>
        <ThesisMinimum props={props} />
        <PolicyFields kind={source.kind} values={form} onChange={setForm} errors={parsed.errors} markets={markets} held={source.kind === "Trader" ? (source.held ?? []) : []} />
        {source.kind === "Trader" && (
          <div className={styles.field}>
            <div className={styles.choiceLine}>
              <span className={styles.fieldLabel}>AI guard</span>
              <Segmented
                name="guard"
                label="AI guard"
                value={guardOn ? "on" : "off"}
                onChange={(v) => {
                  const want = v === "on";
                  // matching the gate again drops the choice: no transaction needed
                  setLocal((l) => ({ ...l, guardWanted: data && want === data.guardOn ? undefined : want }));
                }}
                options={[
                  { value: "on", label: "On", gold: true },
                  { value: "off", label: "Off" },
                ]}
              />
            </div>
            <p className={styles.help}>
              On: while the validators&apos; verdict on this trader is a fresh BLOCK, the hub gives this wallet no new size from them. Exits are never gated. It is this wallet&apos;s setting on
              the RiskGate (on unless turned off){data && !data.guardOn ? "; it is off for this wallet now" : ""}
              {local.guardWanted !== undefined ? ". Changing it is its own transaction, before the follow." : "."}
            </p>
          </div>
        )}
      </Block>
      {source.kind === "Trader" && form.allowAll && source.held === null && (
        <p className={styles.checking}>The dreamDEX indexer did not list the trader&apos;s open markets, so the cap is checked only in the markets you pick (none with the whole book).</p>
      )}
      <Takeovers {...props} />
      <ReasonList reasons={shown} markets={markets} recommendedAllocation={recommended} onApply={apply} label="What the check found" />
      <Checking preflight={preflight} />
      <Acts>
        <Button size="md" disabled={!ready} onClick={() => setLocal((l) => ({ ...l, policyDone: true }))}>
          Continue
        </Button>
        {!ready && parsed.errors.length > 0 && <Hint>Fix the fields marked above.</Hint>}
        {!ready && parsed.errors.length === 0 && preflight.status === "ready" && <Hint>The hub would refuse this follow: see the refused items.</Hint>}
      </Acts>
    </div>
  );
}

function GuardStep({ reader, writer, tx, local, setLocal }: StepBodyProps) {
  const want = local.guardWanted ?? true;
  const mine = txFor(tx, ["guard"]);
  return (
    <div className={styles.body}>
      <Lead>
        {want
          ? "You chose to follow with the AI guard on. It is off for this wallet now, so it is turned on first, in its own transaction."
          : "You chose to follow with the AI guard off: a BLOCK verdict on this trader will not stop new size for this wallet. The guard is this wallet's setting on the RiskGate, so it also applies to anything the wallet follows later."}
      </Lead>
      <Call>
        <b>setGuard</b>({String(want)}) on RiskGate {shortHex(reader.deployments.gate)}
      </Call>
      <Acts>
        <Button size="md" disabled={tx.busy} onClick={() => tx.run("guard", () => writer().setGuard(want))}>
          {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : want ? "Turn the guard on" : "Turn the guard off"}
        </Button>
        <Button size="md" variant="quiet" disabled={tx.busy} onClick={() => setLocal((l) => ({ ...l, guardWanted: undefined }))}>
          {want ? "Leave it off" : "Keep it on"}
        </Button>
      </Acts>
      <TxLine tx={mine} recalled={tx.recalled} />
    </div>
  );
}

function TankStep(props: StepBodyProps) {
  const { tankInput, setTankInput, tank, preflight, preflightKey, data, markets, apply, setLocal, parsed } = props;
  const result = lastResult(preflight);
  const shown = result ? reasonsFor("tank", result.reasons).filter((r) => r.field === "tank" || r.severity === "error") : [];
  const err = tank === null ? "Type the tank in STT, like 0.5." : undefined;
  const ready = preflight.status === "ready" && preflight.key === preflightKey && tank !== null && !!parsed.policy && !blocks("tank", preflight.result.reasons);
  return (
    <div className={styles.body}>
      <Lead>
        The follow sends STT into this wallet&apos;s gas tank on the hub. The validators&apos; handler pays for each run from the hub, and every run that reaches this wallet is billed
        back to its tank: a run that copies or refuses logs the charge as a TankCharged event, a run with nothing to do is billed without one.
      </Lead>
      <Block>
        <div className={styles.fields}>
          <Field
            id="tank"
            label="Gas tank"
            value={tankInput}
            onChange={setTankInput}
            suffix="STT"
            error={err}
            help={
              <>
                At least {fmtStt(MIN_TANK)}. This wallet holds {data ? fmtStt(data.balance) : "—"}
                {data && data.tank > 0n ? `, and its tank already holds ${fmtStt(data.tank)}` : ""}.
              </>
            }
          />
        </div>
      </Block>
      <Notes>
        <li>
          Below <b>{fmtStt(MIN_TANK_FOR_INCREASE)}</b> every increase is refused as Tank empty; exits are never gated.
        </li>
        <li>While following, the tank keeps at least {fmtStt(MIN_TANK)}. Top it up or take out what is above that from your dashboard; after you unfollow, all of it comes out.</li>
        <li>How many runs it covers depends on the gas each run uses. Your dashboard estimates it from this follow&apos;s own charges once there are some.</li>
      </Notes>
      {data && tank !== null && data.balance >= tank && data.balance - tank < GAS_HEADROOM && (
        <p className={styles.checking} role="status">
          This leaves {fmtStt(data.balance - tank)} in the wallet, which may not cover the follow transaction&apos;s gas. A smaller tank, or more STT in the wallet, avoids a failed send.
        </p>
      )}
      <ReasonList reasons={shown} markets={markets} onApply={apply} label="What the check found" />
      <Checking preflight={preflight} />
      <Acts>
        <Button size="md" disabled={!ready} onClick={() => setLocal((l) => ({ ...l, tankDone: true }))}>
          Continue
        </Button>
        <Button size="md" variant="quiet" onClick={() => setLocal((l) => ({ ...l, policyDone: false }))}>
          Back to the policy
        </Button>
      </Acts>
    </div>
  );
}

function FollowStep(props: StepBodyProps) {
  const { source, parsed, tank, preflight, preflightKey, markets, apply, writer, tx, setLocal, guardOn, reader, form } = props;
  const result = lastResult(preflight);
  const shown = result ? reasonsFor("follow", result.reasons) : [];
  const policy = parsed.policy;
  const ready = preflight.status === "ready" && preflight.key === preflightKey && !!policy && tank !== null && !blocks("follow", preflight.result.reasons);
  const mine = txFor(tx, ["follow"]);
  const marketText =
    source.kind === "Trader"
      ? form.allowAll
        ? "whole book"
        : parsed.joinPools.map((p) => (markets[p.toLowerCase()] ? `${markets[p.toLowerCase()]!.symbol}-PERP` : shortHex(p))).join(", ")
      : undefined;
  const send = () =>
    tx.run("follow", () =>
      writer().follow({
        target: source.kind === "Trader" ? { kind: "Trader", trader: source.trader, joinPools: parsed.joinPools } : { kind: "Theme", themeId: source.themeId },
        policy: policy!,
        tank: tank!,
      }),
    );
  return (
    <div className={styles.body}>
      <Lead>This is what the follow transaction sends. Nothing else is signed until you press the button.</Lead>
      {policy && (
        <div className={styles.summary}>
          <Ledger size="md" rows={[...policyRows(source.kind, policy, { markets: marketText, guard: source.kind === "Trader" ? guardOn : undefined }), { label: "Gas tank", value: tank !== null ? fmtStt(tank) : "—" }]} />
        </div>
      )}
      <Notes>
        <li>
          Copies land in <b>the same block</b> as the source&apos;s move: Somnia&apos;s validators run the hub&apos;s handler for it.
        </li>
        <li>
          <b>Exits are never gated:</b> no cap, tank, pause or AI verdict holds back a close. A close is one immediate-or-cancel order; if the book cannot fill it near the mark,
          it is recorded as BandUnfilled.
        </li>
        <li>Increases pass your band and caps, the equity floor and the tank{source.kind === "Trader" ? ", and the AI guard" : ""}.</li>
        {source.kind === "Trader" ? (
          form.allowAll ? (
            <li>The whole book: every market the trader holds or trades is managed, including positions already open (at their next move there, or when you run catchUp).</li>
          ) : (
            <li>The trader&apos;s current positions in the chosen markets are copied in this transaction.</li>
          )
        ) : (
          <>
            <li>The basket opens in this transaction, every leg or none. A rebalance resizes your legs in its own block; between versions the legs drift with prices until you resync.</li>
            <li>The AI guard applies to trader follows only: a thesis is never gated.</li>
          </>
        )}
        <li>A copy&apos;s recorded price is its order&apos;s limit, not the fill. This is a testnet: STT and USDso have no value.</li>
      </Notes>
      {policy && (
        <Call>
          <b>follow</b>({source.kind === "Trader" ? `Trader, ${shortHex(source.trader)}` : `Theme, ${source.themeId.toString()}`}, policy, [{parsed.joinPools.map((p) => shortHex(p)).join(", ")}]) on hub {shortHex(reader.deployments.hub)}
          {tank !== null && <> · value {fmtStt(tank)}</>}
        </Call>
      )}
      <Takeovers {...props} />
      <ReasonList reasons={shown} markets={markets} onApply={apply} label="What the check found" />
      <Checking preflight={preflight} />
      <Acts>
        <Button size="md" disabled={!ready || tx.busy} onClick={send}>
          {mine.phase === "signing" ? "Confirm in your wallet…" : mine.phase === "pending" ? "Waiting for the block…" : `Follow · send ${tank !== null ? fmtStt(tank) : "STT"}`}
        </Button>
        <Button size="md" variant="quiet" disabled={tx.busy} onClick={() => setLocal((l) => ({ ...l, tankDone: false }))}>
          Back
        </Button>
      </Acts>
      <TxLine tx={mine} recalled={tx.recalled} />
    </div>
  );
}

function ReviewStep({ source, reader, writer, data, who, pub, setLocal, refetch }: StepBodyProps) {
  const trader = source.kind === "Trader" ? source.trader : undefined;
  const fee = useQuery({ queryKey: ["review-fee"], queryFn: () => reader.copybook.reviewFee(), staleTime: 30_000 });
  const [phase, setPhase] = useState<AskPhase>({ phase: "idle" });
  if (!trader || !who) return null;
  const busy = phase.phase === "checking" || phase.phase === "signing" || phase.phase === "sent";
  const stale = data?.verdict && data.verdict.tier !== "None" && data.verdict.reviewedAt > 0;
  const days = Math.round(pub.risk.verdictTtlSeconds / 86_400);
  const ask = async () => {
    const out = await askValidators(
      {
        verdict: () => reader.copybook.verdictOf(trader),
        pending: () => reader.copybook.reviewPendingOf(trader),
        fee: () => reader.copybook.reviewFee(),
        balance: () => reader.publicClient.getBalance({ address: who }),
        send: (value) => writer().requestReview(trader, value),
        now: () => Math.floor(Date.now() / 1000),
        risk: pub.risk,
      },
      setPhase,
    );
    if (out.phase === "requested" || out.phase === "blocked") refetch();
  };
  return (
    <div className={styles.body}>
      <Lead>
        You follow this trader now. {stale ? `Its last verdict is older than its ${days}-day life` : "No validator has reviewed this trader yet"}, so the AI guard has nothing to go on.
      </Lead>
      <Lead>
        You can ask the committee for a first verdict from this wallet. The fee is exactly the gate&apos;s <span className="mono">reviewFee</span>
        {fee.data !== undefined ? (
          <>
            : <b>{fmtStt(fee.data)}</b>
          </>
        ) : (
          ", read when you ask"
        )}
        . It pays a committee of {pub.committee.size} validators on Shannon; the verdict comes back to the gate over Hyperlane.
      </Lead>
      <Acts>
        <Button size="md" disabled={busy} onClick={ask}>
          {phase.phase === "checking"
            ? "Checking the gate…"
            : phase.phase === "signing"
              ? "Confirm in your wallet…"
              : phase.phase === "sent"
                ? "Waiting for the block…"
                : `Ask the validators${fee.data !== undefined ? ` · ${fmtStt(fee.data)}` : ""}`}
        </Button>
        <Button size="md" variant="quiet" disabled={busy} onClick={() => setLocal((l) => ({ ...l, reviewSkipped: true }))}>
          Skip for now
        </Button>
      </Acts>
      <p className={styles.help}>Skipping leaves the guard without a verdict: nothing stops this trader&apos;s new size until someone asks for a review, from this page or the trader&apos;s.</p>
      <div aria-live="polite">
        {phase.phase === "blocked" && <p className={styles.tx}>The gate would not take a request now ({phase.state.kind === "pending" ? "a review is already on its way" : "the trader was reviewed minutes ago"}). Nothing was sent.</p>}
        {phase.phase === "sent" && (
          <p className={`${styles.tx} ${styles.pending}`}>
            <i aria-hidden="true" />
            Sent · waiting for the block ·{" "}
            <a href={txUrl(phase.hash)} target="_blank" rel="noopener noreferrer">
              {shortHex(phase.hash, 6, 4)} ↗
            </a>
          </p>
        )}
        {phase.phase === "requested" && (
          <p className={`${styles.tx} ${styles.ok}`}>
            <i aria-hidden="true" />
            Review{phase.nonce !== undefined ? ` #${phase.nonce}` : ""} requested in block #{fmtInt(phase.block)}.
          </p>
        )}
        {phase.phase === "failed" && (
          <p className={`${styles.tx} ${styles.bad}`} role="alert">
            <i aria-hidden="true" />
            {phase.message}
          </p>
        )}
      </div>
    </div>
  );
}

function DoneStep({ view, source, sourceName }: StepBodyProps & { sourceName: string }) {
  const href = source.kind === "Trader" ? `/t/${source.trader}` : `/thesis/${source.themeId}`;
  return (
    <div className={styles.body}>
      <Lead>
        This wallet follows <b>{sourceName}</b>. From the source&apos;s next move, copies land in your account in the same block, and every one of them, copied or refused, shows on your
        dashboard.
      </Lead>
      {source.kind === "Trader" && view.review === "pending" && <Lead>A review of this trader is on its way; the guard uses the verdict as soon as it reaches the gate.</Lead>}
      {source.kind === "Trader" && view.review === "needed" && <Lead>The review was skipped: the guard has no verdict on this trader yet, so nothing stops its new size.</Lead>}
      {source.kind === "Trader" && view.guardOn === false && (
        <Lead>The AI guard is off for this wallet: a Block verdict on this trader does not stop new size. Exits are never gated either way.</Lead>
      )}
      {view.noGrant && (
        <Lead>
          <b>This wallet holds no operator grant.</b> The hub cannot place a copy, not even an exit, until it grants placeOrderFor again; your dashboard
          offers the call.
        </Lead>
      )}
      <Acts>
        <Button size="md" href="/me" prefetch={false} arrow>
          Open your dashboard
        </Button>
        <Button size="md" variant="quiet" href={href} prefetch={false}>
          Back to the {source.kind === "Trader" ? "trader" : "thesis"}
        </Button>
      </Acts>
    </div>
  );
}

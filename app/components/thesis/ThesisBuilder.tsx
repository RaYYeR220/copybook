"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { Button } from "@/components/Button";
import { ConnectButton } from "@/components/ConnectButton";
import { Panel, Kick } from "@/components/app/Panel";
import { useReader, useTx, useWriter } from "@/components/follow/hooks";
import { Acts, Block, Call, Field, Hint, TxLine } from "@/components/follow/parts";
import f from "@/components/follow/Flow.module.css";
import { checkName, checkUri, type BasketRow, type RegistryRules } from "@/lib/builder/basket";
import { fmtInt, shortHex } from "@/lib/format";
import type { PublicConfig } from "@/lib/publicConfig";
import type { MarketMeta } from "@/lib/tape";
import { hideki } from "@/lib/wallet/hideki";
import { IssueList, LegsEditor, blankRow } from "./LegsEditor";
import { LegsCall, MinimumBox, ShapeLedger } from "./Summary";
import { useBasket } from "./useBasket";
import styles from "./Builder.module.css";

interface Props {
  pub: PublicConfig;
  markets: Record<string, MarketMeta>;
  registered: Record<string, boolean>;
  bank: Address | null;
  rules: RegistryRules;
}

/** Publishing a thesis: a name, up to MAX_LEGS legs, the registry's rules checked as you type, then createTheme. */
export function ThesisBuilder({ pub, markets, registered, bank, rules }: Props) {
  const reader = useReader(pub);
  const writer = useWriter(reader);
  const router = useRouter();
  const { address, chainId, status } = useAccount();
  const who = address ? getAddress(address) : undefined;
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const [rows, setRows] = useState<BasketRow[]>(() => [blankRow("r1")]);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<{ id: bigint } | { missing: true } | null>(null);
  const tx = useTx(who, reader.publicClient, () => {}, "thesis");

  const ctx = useMemo(() => ({ cb: reader.copybook, client: reader.publicClient, bank, markets, registered, rules }), [reader, bank, markets, registered, rules]);
  const b = useBasket(rows, ctx);
  const nameIssues = checkName(name);
  const uriIssues = checkUri(uri);
  const blocking = [...nameIssues, ...uriIssues, ...b.issues];
  const ready = blocking.length === 0;
  const edit = (fn: (rs: BasketRow[]) => BasketRow[]) => {
    setTouched(true);
    setRows(fn);
  };

  // once createTheme lands, its ThemeCreated event names the new thesis
  const landed = tx.tx.phase === "confirmed" && tx.tx.action === "createTheme" ? tx.tx.hash : undefined;
  useEffect(() => {
    if (!landed) return;
    let live = true;
    reader.publicClient
      .getTransactionReceipt({ hash: landed })
      .then((r) => {
        const e = reader.copybook.decodeLogs(r.logs).find((x) => x.name === "ThemeCreated");
        if (!live) return;
        if (e && e.name === "ThemeCreated") {
          setCreated({ id: e.themeId });
          router.push(`/thesis/${e.themeId}`);
        } else setCreated({ missing: true });
      })
      .catch(() => live && setCreated({ missing: true }));
    return () => {
      live = false;
    };
  }, [landed, reader, router]);

  const publish = () =>
    void tx.run("createTheme", () => writer().createTheme(name.trim(), uri.trim(), b.parsed.legs));

  const wrongChain = !!who && chainId !== hideki.id;
  const shown = touched ? blocking : blocking.filter((x) => x.severity !== "error" || x.by === "registry");

  return (
    <>
      <Panel id="build-h" title="The thesis" aside={<Kick>{`ThemeRegistry ${shortHex(reader.deployments.themes)}`}</Kick>} order={2} d={0.03}>
        <div className={f.body}>
          <div className={f.fields}>
            <Field
              id="t-name"
              label="Name"
              value={name}
              onChange={(v) => {
                setTouched(true);
                setName(v);
              }}
              placeholder="Name it"
              inputMode="text"
              wide
              help="Shown on the thesis page, in every follower's dashboard and on its share card. The registry stores it as typed."
              error={touched && name !== "" ? nameIssues[0]?.message : undefined}
            />
            <Field
              id="t-uri"
              label="Write-up"
              value={uri}
              onChange={setUri}
              placeholder="optional · https://"
              inputMode="text"
              wide
              help="A link to why you hold these legs. Optional; https or ipfs."
              error={uriIssues[0]?.message}
            />
          </div>

          <Block title="Legs">
            <LegsEditor
              rows={rows}
              setRows={(v) => edit(typeof v === "function" ? v : () => v)}
              markets={markets}
              registered={b.registration}
              rules={rules}
              reads={b.reads}
              minimum={b.minimum}
              rowIssues={touched ? b.rowIssues : new Map()}
              idPrefix="new"
            />
          </Block>

          <Block title="What a follower needs">
            <MinimumBox minimum={b.minimum} readAt={b.readAt} label={b.label} />
          </Block>

          <Block title="Against the registry's limits">
            <ShapeLedger legs={b.parsed.legs} rules={rules} />
          </Block>

          <IssueList
            issues={shown}
            label="What would stop this thesis"
            onRetry={b.retryRegistration}
            onFix={(row, weight) => edit((rs) => rs.map((r, i) => (i === row ? { ...r, weight } : r)))}
          />

          <Call>
            ThemeRegistry {shortHex(reader.deployments.themes)} ·{" "}
            <LegsCall fn="createTheme" head={[JSON.stringify(name.trim()), JSON.stringify(uri.trim())]} legs={b.parsed.legs} label={b.label} />
          </Call>

          {!who || status !== "connected" || wrongChain ? (
            <Acts>
              <ConnectButton inline />
              <Hint>Publishing is one transaction from your wallet, gas only. The wallet that publishes is the only one that can rebalance it.</Hint>
            </Acts>
          ) : (
            <Acts>
              <Button size="md" onClick={publish} disabled={!ready || tx.busy} aria-describedby="publish-why">
                {tx.busy ? "Check your wallet…" : "Publish thesis"}
              </Button>
              <Hint>
                <span id="publish-why">
                  {ready ? `From ${shortHex(who)}: you alone can rebalance it.` : !touched ? "Name the thesis and give it legs first." : `${blocking.length} point${blocking.length === 1 ? "" : "s"} above to settle first.`}
                </span>
              </Hint>
            </Acts>
          )}
          <TxLine tx={tx.tx} recalled={tx.recalled} />
          <div aria-live="polite">
            {created && "id" in created && (
              <p className={styles.created} role="status">
                Published as thesis #{fmtInt(created.id)}. Opening its page…
              </p>
            )}
            {created && "missing" in created && (
              <p className={styles.created} role="alert">
                The transaction landed, but its receipt has no ThemeCreated event. The newest thesis is listed on Discover.
              </p>
            )}
          </div>
        </div>
      </Panel>
    </>
  );
}

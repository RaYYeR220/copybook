// Writes docs/PROOF.md from the ledger's checked rows (see proof-ledger.ts).
import { getAddress } from "viem";
import {
  CHAINS,
  VENUE_ERRORS,
  type ChainName,
  type CheckedRow,
  type ContractResult,
  type DecodedEvent,
  type GasResult,
  type Outcome,
  type PairResult,
  type ReviewResult,
  type Section,
} from "./proof-ledger.ts";

export interface ProofContext {
  runs: Record<string, string>;
  markets: Record<string, { symbol: string; decimals: number }>;
  /** Copybook's own wallets (deployments/hideki.json demoWallets), lowercase address → role. */
  wallets: Record<string, string>;
  hub: string;
  /** The review shown step by step. */
  exampleNonce?: number;
}
export interface ProofInput {
  generatedAt: string;
  heads: Record<ChainName, number>;
  rows: CheckedRow[];
  pairs: PairResult[];
  contracts: ContractResult[];
  reviews: ReviewResult[];
  gas: GasResult[];
  context: ProofContext;
}

// ---------------------------------------------------------------- formatting

const int = (n: number) => n.toLocaleString("en-US");
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;
const isAddr = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);
const shortAddr = (a: string) => {
  const c = isAddr(a) ? getAddress(a) : a;
  return `${c.slice(0, 6)}…${c.slice(-4)}`;
};
/** Events that name the follower they happened to. */
const MEMBER_EVENTS = new Set(["Copied", "Refused", "TankCharged", "Stopped", "Deferred"]);
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const txLink = (chain: ChainName, hash: string) => `[${shortHash(hash)}](${CHAINS[chain].explorerTx}${hash})`;
const addrLink = (chain: ChainName, a: string) => `[${shortAddr(a)}](${CHAINS[chain].explorerAddress}${a})`;
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const anchor = (id: string) => `<a id="${id}"></a>`;

/** A fixed-point amount in base units as a decimal, optionally rounded to `maxFrac` places. */
export function units(value: string | bigint, decimals: number, maxFrac = decimals): string {
  let n = BigInt(value);
  const neg = n < 0n;
  if (neg) n = -n;
  let d = decimals;
  let whole = n / 10n ** BigInt(d);
  let frac = n % 10n ** BigInt(d);
  if (maxFrac < d) {
    const cut = 10n ** BigInt(d - maxFrac);
    frac = (frac + cut / 2n) / cut;
    d = maxFrac;
    if (frac >= 10n ** BigInt(d)) {
      whole += 1n;
      frac = 0n;
    }
  }
  const f = d > 0 ? frac.toString().padStart(d, "0").replace(/0+$/, "") : "";
  return `${neg && (whole > 0n || f) ? "-" : ""}${whole}${f ? `.${f}` : ""}`;
}

function mark(r: { outcome: Outcome; reason?: string }): string {
  if (r.outcome === "verified") return "✓";
  if (r.outcome === "unverified") return `unverified (RPC): ${esc(r.reason ?? "")}`;
  return `**FAILED**: ${esc(r.reason ?? "")}`;
}

function makeDescribe(ctx: ProofContext) {
  const who = (a: string) => {
    if (a.toLowerCase() === ctx.hub.toLowerCase()) return "the hub";
    const role = ctx.wallets[a.toLowerCase()];
    return role ? `${role} ${shortAddr(a)}` : shortAddr(a);
  };
  const market = (pool: string) => ctx.markets[pool.toLowerCase()];
  const size = (pool: string, v: string) => {
    const m = market(pool);
    return m ? units(v, m.decimals) : v;
  };
  const sym = (pool: string) => market(pool)?.symbol ?? shortAddr(pool);
  const event = (e: DecodedEvent): string => {
    const a = e.args;
    switch (e.name) {
      case "Copied":
        return `copied ${sym(a.pool)} ${size(a.pool, a.fromSize)} → ${size(a.pool, a.toSize)}`;
      case "Refused": {
        const venue = a.venueError && a.venueError !== "0x" ? ` (venue error ${VENUE_ERRORS[a.venueError.slice(0, 10)] ?? a.venueError})` : "";
        return `**refused** ${sym(a.pool)}: \`${a.reason}\`${venue}`;
      }
      case "TankCharged":
        return `tank charged ${units(a.amount, 18, 4)} STT`;
      case "Followed":
        return `Followed (${a.kind}${a.kind === "Theme" ? ` ${a.ref}` : ""})`;
      case "Unfollowed":
        return `Unfollowed${a.flattened === "true" ? ", flattened" : ""}`;
      case "GroupOpened":
        return `group ${a.group} opened (relay ${shortAddr(a.relay)}, subscription ${a.subscriptionId})`;
      case "GroupClosed":
        return `group ${a.group} closed${a.cancelled === "true" ? ", subscription cancelled" : ""}`;
      case "Stopped":
        return `**Stopped** (equity ${units(a.equity, 18, 2)} USDso)`;
      case "ThemeCreated":
        return `thesis ${a.themeId} "${a.name}" created`;
      case "ThemeRebalanced":
        return `thesis ${a.themeId} now v${a.version}`;
      case "GuardSet":
        return `guard ${a.on === "true" ? "on" : "off"}`;
      case "ReviewRequested":
        return `review ${a.nonce} requested`;
      case "VerdictReceived":
        return `verdict ${a.tier} stored for ${shortAddr(a.trader)}`;
      case "BlockHeld":
        return `${a.newTier} arrived; the earlier Block is held`;
      case "ReviewReceived":
        return `review ${a.nonce} received`;
      case "SummaryRequested":
        return `data requested (${units(a.deposit, 18, 4)} STT deposit)`;
      case "SummaryReceived":
        return `data agreed (${shortHash(a.summaryHash)})`;
      case "VerdictRequested":
        return `verdict requested (${units(a.deposit, 18, 4)} STT deposit)`;
      case "VerdictTallied":
        return `**${a.tier}**: ${a.ok} OK / ${a.caution} CAUTION / ${a.blocked} BLOCK of ${a.responded} answers`;
      case "VerdictSent":
        return `${a.tier} sent to Hideki`;
      case "RiskGateSet":
        return `risk gate ${shortAddr(a.gate)}`;
      case "ReviewerSet":
        return `reviewer ${shortAddr(a.reviewer)}`;
      case "GasParamsSet":
        return `gas params: floor ${int(Number(a.floor))}, charge overhead ${int(Number(a.chargeOverhead))}, risk-gate budget ${int(Number(a.riskGateGas))}`;
      case "SubParamsSet":
        return `subscription params: guaranteed ${a.guaranteed}`;
      default:
        return e.name;
    }
  };
  const call = (r: CheckedRow): string => {
    const f = r.result.facts;
    if (!f) return "";
    if (!f.to) return "contract creation";
    const keys = Object.keys(r.expect?.args ?? {});
    const args = keys.map((k) => {
      const v = f.args?.[k] ?? "";
      return `${k}=${isAddr(v) ? who(v) : v}`;
    });
    const parts: string[] = [];
    if (f.method) parts.push(`\`${f.method}\`${args.length ? `(${args.join(", ")})` : ""}`);
    else if (r.expect?.input) parts.push(`data \`${shortHash(f.input)}\` as recorded`);
    if (f.to.toLowerCase() === f.from.toLowerCase()) parts.push("sent to itself");
    if (f.value > 0n) parts.push(`${units(f.value, 18, 6)} STT sent`);
    return parts.join(", ");
  };
  /** Events in order; when one handler transaction carries several followers, each one's are grouped under it. */
  const events = (evs: DecodedEvent[]): string => {
    const perFollower = (e: DecodedEvent) => MEMBER_EVENTS.has(e.name) && Boolean(e.args.follower);
    const followers = [...new Set(evs.filter(perFollower).map((e) => e.args.follower.toLowerCase()))];
    if (followers.length <= 1) return evs.map(event).join(" · ");
    const parts = [evs.filter((e) => !perFollower(e)).map(event).join(" · ")].filter(Boolean);
    for (const fl of followers)
      parts.push(`${who(fl)}: ${evs.filter((e) => perFollower(e) && e.args.follower.toLowerCase() === fl).map(event).join(" · ")}`);
    return parts.join("; ");
  };
  const says = (r: CheckedRow) => {
    const f = r.result.facts;
    if (!f) return "";
    return esc([call(r), events(f.events.filter((e) => e.name !== "TankCharged" || r.role === "copy")), r.note].filter(Boolean).join(" · "));
  };
  return { who, event, events, call, says };
}

const posOf = (r: CheckedRow) => (r.result.facts ? `${int(r.result.facts.block)} · #${r.result.facts.index}` : r.result.block !== undefined ? int(r.result.block) : "");
const rowMark = (r: CheckedRow) => mark(r.result);

function pairMark(p: PairResult): string {
  if (p.outcome === "verified") return "✓";
  const reasons = [...p.reasons, ...[p.move, p.copy].filter((r) => r.result.reason).map((r) => `${r.role}: ${r.result.reason}`)];
  return mark({ outcome: p.outcome, reason: reasons.join("; ") });
}

// ---------------------------------------------------------------- the document

export function renderProof(input: ProofInput): string {
  const { rows, pairs, contracts, reviews, gas, context: ctx } = input;
  const d = makeDescribe(ctx);
  const out: string[] = [];
  const shown = new Set<string>();
  const key = (r: { chain: ChainName; hash: string }) => `${r.chain}:${r.hash.toLowerCase()}`;
  const show = (r: CheckedRow) => shown.add(key(r));
  const runName = (run?: string) => (run ? (({ e2e: "e2e", app: "app", risk: "risk", deploy: "deploy" }) as Record<string, string>)[run] ?? run : "");

  // counts, per transaction
  const perTx = new Map<string, Outcome>();
  for (const r of rows) {
    const prev = perTx.get(key(r)) ?? "verified";
    const o = r.result.outcome;
    perTx.set(key(r), prev === "failed" || o === "failed" ? "failed" : prev === "unverified" || o === "unverified" ? "unverified" : "verified");
  }
  const n = (o: Outcome) => [...perTx.values()].filter((x) => x === o).length;
  const pairsOk = pairs.filter((p) => p.outcome === "verified").length;

  out.push("# Proof ledger", "");
  out.push(
    `Every transaction Copybook's documents cite, read back from the chain. \`npm run proof\` (in \`e2e/\`) wrote this file at **Hideki block ${int(input.heads.hideki)}** and **Shannon block ${int(input.heads.shannon)}**, ${utc(input.generatedAt)}.`,
    "",
  );
  const summary = [`**${perTx.size} transactions checked: ${n("verified")} verified, ${n("failed")} failed, ${n("unverified")} unverified.**`];
  if (pairs.length) summary.push(`${pairsOk} of ${pairs.length} same-block pairs check out.`);
  if (contracts.length) summary.push(`${contracts.filter((c) => c.outcome === "verified").length} of ${contracts.length} contracts check out.`);
  out.push(summary.join(" "), "");
  out.push(
    "Testnet only: Hideki (chain 50383; its explorer is the Tokyo explorer) and Shannon (chain 50312) are Somnia testnets, and STT and USDso have no market value. A wallet shown with a role (demo leader, demo follower, …) is one of Copybook's own (`demoWallets` in `deployments/hideki.json`); the traders in the review table are dreamDEX traders the AI guard reviewed.",
    "",
    "**What a ✓ means.** The transaction is on the chain named and succeeded, and everything recorded for it matches the chain: its block and position in the block, sender, target, the function it called and the arguments listed, its gas, and the events Copybook's contracts emitted in it, as far as the row records them. A same-block pair also needs the copy in the move's block, after the move, sent by the hub. A transaction the RPC could not return after retries is marked unverified, never ✓.",
    "",
  );
  const runs = Object.entries(ctx.runs);
  if (runs.length) {
    out.push("**Runs:**");
    for (const [k, v] of runs) out.push(`- \`${k}\`: ${v}`);
    out.push("");
  }

  const failures = rows.filter((r) => r.result.outcome !== "verified");
  const badPairs = pairs.filter((p) => p.reasons.length);
  const badContracts = contracts.filter((c) => c.outcome !== "verified");
  if (failures.length || badPairs.length || badContracts.length) {
    out.push("## Not verified", "");
    out.push("| Row | Chain | Tx | Check |", "|---|---|---|---|");
    for (const r of failures) out.push(`| ${esc(r.id)} | ${CHAINS[r.chain].name} | ${txLink(r.chain, r.hash)} | ${rowMark(r)} |`);
    for (const p of badPairs) out.push(`| pair ${p.id} | Hideki | ${txLink("hideki", p.copy.hash)} | ${pairMark(p)} |`);
    for (const c of badContracts) out.push(`| contract ${c.id} | ${CHAINS[c.chain].name} | ${addrLink(c.chain, c.address)} | ${mark({ outcome: c.outcome, reason: c.reasons.join("; ") })} |`);
    out.push("");
  }

  const sectionRows = (s: Section) => rows.filter((r) => r.section === s);
  const stepTable = (rs: CheckedRow[], opts: { run?: boolean } = {}) => {
    if (!rs.length) return;
    out.push(
      `| ${opts.run ? "Run | " : ""}Step | Tx | Block · position | From | What the chain says | Check |`,
      `|${opts.run ? "---|" : ""}---|---|---|---|---|---|`,
    );
    for (const r of rs) {
      show(r);
      const f = r.result.facts;
      out.push(
        `| ${opts.run ? `${runName(r.run)} | ` : ""}${anchor(r.id)}${esc(r.label)} | ${txLink(r.chain, r.hash)} | ${posOf(r)} | ${f ? d.who(f.from) : ""} | ${d.says(r)} | ${rowMark(r)} |`,
      );
    }
    out.push("");
  };
  /** `home`: the section this table is in; a pair gets its anchor only there. */
  const pairTable = (ps: PairResult[], home: Section, numbered = false) => {
    if (!ps.length) return;
    out.push(
      `| ${numbered ? "# | " : ""}Run | The move | Block | Move · position | Copy · position | What the copy did | Check |`,
      `|${numbered ? "---|" : ""}---|---|---|---|---|---|---|`,
    );
    ps.forEach((p, i) => {
      show(p.move);
      show(p.copy);
      const mf = p.move.result.facts;
      const cf = p.copy.result.facts;
      const did = cf ? d.events(cf.events) || "nothing to copy" : "";
      out.push(
        `| ${numbered ? `${i + 1} | ` : ""}${runName(p.move.run)} | ${p.section === home ? anchor(p.id) : ""}${esc(p.move.label)} | ${mf ? int(mf.block) : ""} | ${txLink(p.move.chain, p.move.hash)} · #${mf?.index ?? "?"} | ${txLink(p.copy.chain, p.copy.hash)} · #${cf?.index ?? "?"} | ${esc(did)} | ${pairMark(p)} |`,
      );
    });
    out.push("");
  };
  const pairsIn = (s: Section, subsection?: string) =>
    pairs.filter((p) => p.section === s && (subsection === undefined || p.move.subsection === subsection));
  const pairsAlsoIn = (s: Section) => pairs.filter((p) => p.section !== s && p.move.alsoIn?.includes(s));

  // ---- contracts
  if (contracts.length || sectionRows("contracts").length) {
    out.push("## Contracts", "");
    if (contracts.length) {
      out.push(
        "Each address holds code now, and its deploy transaction created exactly that address (CopyEngine through the CREATE2 deployer, the relays by the hub inside a follow). Each address also matches `deployments/*.json`.",
        "",
        "| Contract | Chain | Address | Deployed in | Source | Check |",
        "|---|---|---|---|---|---|",
      );
      for (const c of contracts) {
        const opened = c.openedIn ? rows.find((r) => r.id === c.openedIn) : undefined;
        const deployed = c.deploy
          ? `${txLink(c.chain, c.deploy.hash)} · block ${c.deploy.result.facts ? int(c.deploy.result.facts.block) : "?"}`
          : opened
            ? `opened by the hub in ${txLink(opened.chain, opened.hash)} (\`GroupOpened\`)`
            : "";
        if (c.deploy) show(c.deploy);
        const source = [c.source, c.readBackNote].filter(Boolean).join("; ");
        out.push(
          `| ${anchor(`contract-${c.id}`)}${esc(c.name)} | ${CHAINS[c.chain].name} | ${addrLink(c.chain, c.address)} | ${deployed} | ${esc(source)} | ${mark({ outcome: c.outcome, reason: c.reasons.join("; ") })} |`,
        );
      }
      out.push("");
    }
    const config = sectionRows("contracts").filter((r) => !r.id.startsWith("deploy-"));
    if (config.length) {
      out.push("### Configuration", "");
      stepTable(config);
    }
  }

  // ---- same-block copies
  if (pairsIn("same-block").length) {
    out.push("## Same-block copies", "");
    out.push(
      "When a source's position changes, Somnia's validators run the hub's reactive handler inside the same block, and the handler places the copy in the follower's own dreamDEX account. Each row is a move and the hub's handler transaction for it.",
      "",
      `**${pairsOk} of ${pairs.length} pairs in this ledger** (this table and the pairs under Refusals, Theses and AI guard) have the copy in the move's block, after it, sent by the hub.`,
      "",
    );
    pairTable(pairsIn("same-block"), "same-block", true);
    const setup = sectionRows("same-block").filter((r) => !r.pair);
    if (setup.length) {
      out.push("Setup for the residue pairs:", "");
      stepTable(setup);
    }
  }

  // ---- refusals
  if (sectionRows("refusals").length) {
    out.push("## Refusals on chain", "");
    out.push(
      "A refused copy is recorded too: the handler writes `Refused(follower, source, market, reason, venueError)` in the block of the move it refused, and the follower's position stays where it was. Exits are never refused.",
      "",
    );
    pairTable([...pairsIn("refusals"), ...pairsAlsoIn("refusals")], "refusals");
    const own = sectionRows("refusals").filter((r) => !r.pair && !r.context);
    if (own.length) {
      out.push("The equity floor: when equity falls under the follower's floor, anyone may call `poke`, which flattens the copied positions and stops the follow until the follower resumes.", "");
      stepTable(own);
    }
    const ctxRows = sectionRows("refusals").filter((r) => !r.pair && r.context);
    if (ctxRows.length) {
      out.push("The steps around them:", "");
      stepTable(ctxRows);
    }
  }

  // ---- theses
  if (sectionRows("theses").length) {
    out.push("## Theses", "");
    out.push("A thesis is a weighted basket of perps legs in `ThemeRegistry`. A follow opens every leg in one transaction, and a rebalance is copied in the rebalance's own block.", "");
    stepTable(sectionRows("theses").filter((r) => !r.pair), { run: true });
    pairTable(pairsIn("theses"), "theses");
  }

  // ---- follow lifecycle
  if (sectionRows("lifecycle").length) {
    out.push("## Follow lifecycle", "");
    const byRun = (run: string) => sectionRows("lifecycle").filter((r) => r.run === run);
    if (byRun("app").length) {
      out.push("### In the app", "", ctx.runs.app ? `${ctx.runs.app}. The follower's transactions were sent from the app's own pages (the follow flow and the dashboard) and signed by its wallet; the leader traded through the e2e tooling.` : "", "");
      stepTable(byRun("app"));
    }
    if (byRun("e2e").length) {
      out.push("### In the end-to-end run", "", ctx.runs.e2e ? `${ctx.runs.e2e}.` : "", "");
      stepTable(byRun("e2e"));
    }
  }

  // ---- AI guard
  const guardRows = sectionRows("guard");
  const example = reviews.find((r) => r.nonce === ctx.exampleNonce);
  if (guardRows.length || reviews.length || sectionRows("anchors").length) {
    out.push("## AI guard", "");
    out.push(
      "A review is requested on Hideki, crosses to the `RiskReviewer` on Shannon over Hyperlane, where one committee of validators fetches the trader's 30-day line and another classifies it OK, CAUTION or BLOCK; the verdict crosses back to the `RiskGate` on Hideki. The hub asks the gate only before an increase, and only for a follower whose guard is on.",
      "",
    );
    if (example) {
      out.push(`### One review, end to end (review ${example.nonce})`, "");
      out.push("| Step | Chain | Tx | Block · position | What the chain says | Check |", "|---|---|---|---|---|---|");
      for (const r of example.rows) {
        show(r);
        out.push(`| ${anchor(`example-${r.id}`)}${esc(r.label.replace(/^review \d+: /, ""))} | ${CHAINS[r.chain].name} | ${txLink(r.chain, r.hash)} | ${posOf(r)} | ${d.says(r)} | ${rowMark(r)} |`);
      }
      out.push("");
    }
    if (pairsIn("guard", "gate").length) {
      out.push("### The gate in the copy path", "");
      pairTable(pairsIn("guard", "gate"), "guard");
    }
    if (pairsIn("guard", "block").length) {
      out.push("### A BLOCK refuses new size, never an exit", "");
      stepTable(guardRows.filter((r) => !r.pair && r.subsection === "block"));
      pairTable(pairsIn("guard", "block"), "guard");
    }
    if (sectionRows("anchors").length) {
      out.push("### Answer keys written on chain before the reviews", "", "Each input is the commit that holds the answer key followed by the key file's keccak256 (see `eval/SCORECARD.md`).", "");
      stepTable(sectionRows("anchors"));
    }
    if (reviews.length) {
      out.push(`### Every review (${reviews.length})`, "");
      out.push(
        "The committee's tier is read from `VerdictTallied` on Shannon, and what the gate did from `VerdictReceived` or `BlockHeld` on Hideki. Runs, prompts and scoring: `eval/SCORECARD.md`.",
        "",
        "| Review | Trader | Committee | Gate | Request | To Shannon | Data | Verdict | To Hideki | Check |",
        "|---|---|---|---|---|---|---|---|---|---|",
      );
      for (const rv of reviews) {
        const step = (suffix: string) => rv.rows.find((r) => r.id.endsWith(`-${suffix}`));
        const link = (suffix: string) => {
          const r = step(suffix);
          if (!r) return "";
          show(r);
          return txLink(r.chain, r.hash);
        };
        const c = rv.committee;
        const committee = c ? `${c.tier} (${c.ok}/${c.caution}/${c.blocked} of ${c.responded})` : "";
        const gate = rv.gate ? (rv.gate.name === "BlockHeld" ? `${rv.gate.args.newTier}, earlier Block held` : `${rv.gate.args.tier} stored`) : "";
        const bad = rv.rows.filter((r) => r.result.outcome !== "verified");
        const check = bad.length ? bad.map((r) => `${r.id}: ${mark(r.result)}`).join("; ") : "✓";
        out.push(
          `| ${anchor(`review-${rv.nonce}`)}${rv.nonce} | ${addrLink("hideki", rv.trader)} | ${committee} | ${gate} | ${link("request")} | ${link("toShannon")} | ${link("summary")} | ${link("verdict")} | ${link("toHideki")} | ${esc(check)} |`,
        );
      }
      out.push("");
    }
  }

  // ---- MCP
  if (sectionRows("mcp").length) {
    out.push("## MCP agent", "");
    out.push("An AI agent's own wallet (the demo agent), driven through `@copybook/mcp` over stdio: every write below was first returned as a dry run, then sent with `dryRun: false`.", "");
    stepTable(sectionRows("mcp"));
  }

  // ---- gas
  if (gas.length) {
    const prices = new Set(gas.map((g) => g.row?.result.facts?.gasPrice.toString()).filter(Boolean));
    const price = prices.size === 1 ? ` (${units([...prices][0]!, 9)} gwei on every row)` : "";
    out.push("## Gas", "");
    out.push(`Measured in the app run. Gas is each transaction's \`gasUsed\`; STT is that gas at the transaction's own gas price${price}.`, "");
    out.push("| Call | Gas | STT | Tx | Check |", "|---|---|---|---|---|");
    for (const g of gas) {
      const f = g.row?.result.facts;
      const stt = f ? units(BigInt(f.gasUsed) * f.gasPrice, 18, 4) : "";
      const tank = g.tankCharges?.length
        ? `. Charged to the followers' tanks in this transaction: ${g.tankCharges.map((t) => `${d.who(t.follower)} ${units(t.amount, 18, 4)} STT`).join(", ")}`
        : "";
      out.push(
        `| ${esc(g.label + tank)} | ${f ? int(f.gasUsed) : int(g.recorded)} | ${stt} | ${g.row ? txLink(g.row.chain, g.row.hash) : ""} | ${mark({ outcome: g.outcome, reason: g.reason })} |`,
      );
    }
    out.push("");
  }

  // ---- landing
  if (sectionRows("landing").length) {
    out.push("## The landing page's proof", "");
    out.push("Every transaction the landing page shows (`app/content/proof.ts`), checked at the block and position the page states, and the review's tier and votes.", "");
    stepTable(sectionRows("landing"));
  }

  // ---- everything else
  const rest = rows.filter((r) => !shown.has(key(r)) || r.result.outcome !== "verified");
  const restUnique = new Map<string, CheckedRow>();
  for (const r of rest) if (!restUnique.has(`${key(r)}:${r.result.outcome}`)) restUnique.set(`${key(r)}:${r.result.outcome}`, r);
  if (restUnique.size) {
    const recheck = rows.filter((r) => shown.has(key(r)) && r.result.outcome === "verified" && (r.section === "other" || r.section === "reviews")).length;
    out.push("## Every other transaction", "");
    out.push(
      `Everything else recorded in \`deployments/*.json\`, the app run's funding and cleanup, and transaction links in the docs. ${recheck ? `Another ${recheck} rows re-check transactions shown above against what \`deployments/*.json\` recorded for them; all verified.` : ""}`.trim(),
      "",
      `<details><summary>${restUnique.size} transactions</summary>`,
      "",
      "| Source | Step | Chain | Tx | Block · position | Check |",
      "|---|---|---|---|---|---|",
    );
    for (const r of restUnique.values())
      out.push(`| ${esc(r.source ?? runName(r.run))} | ${esc(r.label)} | ${CHAINS[r.chain].name} | ${txLink(r.chain, r.hash)} | ${posOf(r)} | ${rowMark(r)} |`);
    out.push("", "</details>", "");
  }

  out.push("## Regenerate", "");
  out.push(
    "```sh",
    "cd e2e && npm ci && npm run proof",
    "```",
    "",
    "It only reads (public RPCs, no key). It exits 0 when everything verifies, 1 when anything fails and 2 when the RPC kept failing for some transactions. The transactions and what was recorded for them are in `e2e/proof/sources.json`, `deployments/*.json` and `eval/*/anchor.json`; `HIDEKI_RPC` and `SHANNON_RPC` override the endpoints.",
    "",
  );
  return out.join("\n");
}

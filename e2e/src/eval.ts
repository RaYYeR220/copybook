// Pre-registered evaluation of the validator risk review. The rubric and the reviewer's prompt are in eval/rubric.ts.
// Run v2 (eval/answer-key.json, eval/results.json): the rubric in the user prompt, the full summary as the stats.
// Run v3 (eval/v3/): the rubric as the system message, and only the keys it reads (the endpoint's `rubric` field).
// COPYBOOK_ENV=<env file> tsx src/eval.ts select
//   picks 20 Hideki traders from the indexer (quotas below), fetches each one's summary from the public endpoint and
//   writes eval/answer-key.json with the rubric's expected tier. The env file is read only to exclude our own wallets.
// tsx src/eval.ts key v3
//   the same 20 traders, in the same order: each one's rubric line from the public endpoint, the rubric's tier for it,
//   into eval/v3/answer-key.json. Commit it before requesting any review of the run.
// COPYBOOK_ENV=<env file> tsx src/eval.ts anchor v3 <commit>
//   writes the commit hash and the keccak256 of the committed key on Hideki (a zero-value self-transfer from the hub
//   owner), after checking the committed key is byte-identical to the file; the transaction goes to eval/v3/anchor.json.
// tsx src/eval.ts score [v3]
//   reads the reviews recorded in deployments/risk.json (npm run risk review <trader>) for the traders in the key and
//   writes the run's results.json: the committee's tier against the expected one, per trader and as a confusion matrix.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Indexer, getTraderStats, riskSummary, type TraderStats } from "@copybook/stats";
import { RUBRIC, SYSTEM_PROMPT, TIERS, rubricTier, type Tier } from "../../eval/rubric.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEY_FILE = resolve(ROOT, "eval/answer-key.json");
const RESULTS_FILE = resolve(ROOT, "eval/results.json");
const RISK_FILE = resolve(ROOT, "deployments/risk.json");
/** Each run's files: v2 sits at the top of eval/ (its key is anchored there), later runs in their own folder. */
const RUNS = {
  v2: { key: KEY_FILE, results: RESULTS_FILE, anchor: undefined },
  v3: { key: resolve(ROOT, "eval/v3/answer-key.json"), results: resolve(ROOT, "eval/v3/results.json"), anchor: resolve(ROOT, "eval/v3/anchor.json") },
} as const;
type Run = keyof typeof RUNS;
const runOf = (name: string | undefined): Run => {
  const r = (name ?? "v2") as Run;
  if (!(r in RUNS)) throw new Error(`unknown run ${name}: ${Object.keys(RUNS).join(" | ")}`);
  return r;
};
const ENDPOINT = "https://copybook-eosin.vercel.app/api/risk/";
/** The endpoint's row cap per trader and table; screening uses the same so it sees what the endpoint sees. */
const ROW_CAP = 2000;
const WINDOW_DAYS = 30;
const MAX_SCREENED = 60;

/** The e2e leader (copied by the test follower) and the two other traders of the first live run. */
const LEADER = getAddress("0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d");
const FIRST_RUN = [getAddress("0xfc2fb08cccf87bfc472cded8e7ebef588fcf7fd2"), getAddress("0xa14d4561f2697859ab6c2d5eb62e1172a6cc3d14")];

type Category = "liquidated-2+" | "liquidated-1" | "thin" | "clean" | "leader";
/** 19 picked by category plus the leader = 20. */
const QUOTAS: Record<Exclude<Category, "leader">, number> = { "liquidated-2+": 6, "liquidated-1": 4, thin: 3, clean: 6 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const write = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, big, 2) + "\n");

function categoryOf(s: TraderStats): Exclude<Category, "leader"> {
  if (s.liquidations30d >= 2) return "liquidated-2+";
  if (s.liquidations30d === 1) return "liquidated-1";
  return s.trades30d < 10 || !s.hasHistory ? "thin" : "clean";
}

/** Our own wallets (every *_PK in the env file) and contracts: never candidates, except the leader. */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  const path = process.env.COPYBOOK_ENV;
  if (!path) throw new Error("set COPYBOOK_ENV: our own wallets are excluded from the sample");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+_PK)\s*=\s*(0x[0-9a-fA-F]{64})\s*$/.exec(line);
    if (m) out.add(privateKeyToAccount(m[2] as Hex).address.toLowerCase());
  }
  const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments/hideki.json"), "utf8")) as Record<string, unknown>;
  for (const k of ["hub", "engine", "themes", "owner"]) if (typeof dep[k] === "string") out.add((dep[k] as string).toLowerCase());
  const risk = JSON.parse(readFileSync(RISK_FILE, "utf8")) as { hideki: { gate: string }; shannon: { reviewer: string } };
  out.add(risk.hideki.gate.toLowerCase());
  out.add(risk.shannon.reviewer.toLowerCase());
  out.delete(LEADER.toLowerCase());
  return out;
}

const LIQUIDATED_ACCOUNTS = `query LiquidatedAccounts($since:numeric!){
  LiquidationEvent(where:{timestamp:{_gte:$since},kind:{_in:["AccountLiquidated","PositionLiquidated"]}},order_by:[{timestamp:desc},{id:desc}],limit:1000){ account timestamp txHash }}`;
const ACTIVE_ACCOUNTS = `query ActiveAccounts($since:numeric!){
  PerpPositionChange(where:{timestamp:{_gte:$since}},order_by:[{timestamp:desc},{id:desc}],limit:1000){ account timestamp }}`;

type Pool = { name: string; target: Exclude<Category, "leader">; accounts: string[] };

/** Candidate pools, each in a fixed order, so the sample follows from the indexer's state and not from a choice. */
async function pools(ix: Indexer, since: number): Promise<Pool[]> {
  const liq = await ix.query<{ LiquidationEvent: { account: string; timestamp: string; txHash: string }[] }>("LiquidatedAccounts", LIQUIDATED_ACCOUNTS, { since: String(since) });
  const byAccount = new Map<string, { txs: Set<string>; last: number }>();
  for (const r of liq.LiquidationEvent) {
    const a = r.account.toLowerCase();
    const e = byAccount.get(a) ?? { txs: new Set<string>(), last: 0 };
    e.txs.add(r.txHash);
    e.last = Math.max(e.last, Number(r.timestamp));
    byAccount.set(a, e);
  }
  const liqRows = [...byAccount].map(([a, e]) => ({ a, n: e.txs.size, last: e.last }));
  // most liquidations first (in the latest 1000 liquidation rows), then the most recent
  const multi = liqRows.filter((x) => x.n >= 2).sort((x, y) => y.n - x.n || y.last - x.last || x.a.localeCompare(y.a));
  const single = liqRows.filter((x) => x.n === 1).sort((x, y) => y.last - x.last || x.a.localeCompare(y.a));

  const act = await ix.query<{ PerpPositionChange: { account: string; timestamp: string }[] }>("ActiveAccounts", ACTIVE_ACCOUNTS, { since: String(since) });
  const rows = new Map<string, { n: number; last: number }>();
  for (const r of act.PerpPositionChange) {
    const a = r.account.toLowerCase();
    const e = rows.get(a) ?? { n: 0, last: 0 };
    e.n += 1;
    e.last = Math.max(e.last, Number(r.timestamp));
    rows.set(a, e);
  }
  // fewest rows among the latest 1000 position changes first (thin candidates), then the most recent
  const recent = [...rows].map(([a, e]) => ({ a, ...e })).sort((x, y) => x.n - y.n || y.last - x.last || x.a.localeCompare(y.a));

  // the accounts behind the largest single realized gains in the window (packages/stats' leaderboard candidates)
  const gainers = await ix.candidateAccounts(since, 25);

  return [
    { name: "first live run", target: "clean", accounts: FIRST_RUN.map((a) => a.toLowerCase()) },
    { name: "2+ liquidations in the latest 1000 liquidation rows", target: "liquidated-2+", accounts: multi.map((x) => x.a) },
    { name: "1 liquidation in the latest 1000 liquidation rows", target: "liquidated-1", accounts: single.map((x) => x.a) },
    { name: "fewest rows in the latest 1000 position changes", target: "thin", accounts: recent.map((x) => x.a) },
    { name: "largest single realized gains", target: "clean", accounts: gainers.map((a) => a.toLowerCase()) },
    { name: "latest position changes", target: "clean", accounts: [...recent].sort((x, y) => y.last - x.last || x.a.localeCompare(y.a)).map((x) => x.a) },
  ];
}

type Fetched = { url: string; fetchedAt: string; status: number; summary: string; rubric?: string; asOf: string; cache: string | null; age: string | null };

/** The trader's summary from the public endpoint, at the URL the reviewer's validators fetch (lowercase address). */
async function fetchSummary(trader: Address): Promise<Fetched> {
  const url = ENDPOINT + trader.toLowerCase();
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(3_000 * attempt);
    const fetchedAt = new Date().toISOString();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const body = await res.text();
      if (res.status === 200) {
        const j = JSON.parse(body) as { summary: string; rubric?: string; asOf: string };
        if (typeof j.summary !== "string" || !j.summary) throw new Error("no summary in the response");
        return { url, fetchedAt, status: res.status, summary: j.summary, rubric: j.rubric, asOf: j.asOf, cache: res.headers.get("x-vercel-cache"), age: res.headers.get("age") };
      }
      last = `HTTP ${res.status} ${body.slice(0, 120)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    console.log(`  (endpoint retry for ${trader}: ${last})`);
  }
  throw new Error(`endpoint failed for ${trader}: ${last}`);
}

async function select() {
  const own = ownAddresses();
  const now = Math.floor(Date.now() / 1000);
  const since = now - WINDOW_DAYS * 86400;
  const ix = new Indexer({ maxRows: ROW_CAP, delayMs: 150 });
  const candidatePools = await pools(ix, since);

  const picked: { trader: Address; pickedAs: Category; pool: string; screened: string }[] = [];
  const screened: { trader: string; pool: string; category: string; taken: boolean }[] = [];
  const seen = new Set<string>([LEADER.toLowerCase()]);
  const open = (c: Exclude<Category, "leader">) => picked.filter((p) => p.pickedAs === c).length < QUOTAS[c];

  for (const pool of candidatePools) {
    for (const a of pool.accounts) {
      if (!open(pool.target) && pool.name !== "first live run") break;
      if (seen.has(a) || own.has(a)) continue;
      if (screened.length >= MAX_SCREENED) break;
      seen.add(a);
      let s: TraderStats;
      try {
        s = await getTraderStats(a as Address, { indexer: ix, now, windowDays: WINDOW_DAYS });
      } catch (e) {
        screened.push({ trader: a, pool: pool.name, category: `error: ${e instanceof Error ? e.message : String(e)}`, taken: false });
        continue;
      }
      const c = categoryOf(s);
      const taken = open(c);
      screened.push({ trader: a, pool: pool.name, category: c, taken });
      const line = riskSummary(s);
      console.log(`  ${taken ? "take" : "skip"} ${c.padEnd(13)} ${a}  ${line}`);
      if (taken) picked.push({ trader: getAddress(a), pickedAs: c, pool: pool.name, screened: line });
    }
  }
  const short = (Object.keys(QUOTAS) as (keyof typeof QUOTAS)[]).filter((c) => open(c));
  if (short.length) throw new Error(`quotas not met within ${MAX_SCREENED} screened accounts: ${short.join(", ")}`);
  const leader = await getTraderStats(LEADER, { indexer: ix, now, windowDays: WINDOW_DAYS });
  picked.push({ trader: LEADER, pickedAs: "leader", pool: "our e2e leader", screened: riskSummary(leader) });

  // the answer key: the summary the endpoint serves now, and the rubric's tier for it
  const traders = [];
  for (const p of picked) {
    const f = await fetchSummary(p.trader);
    const r = rubricTier(f.summary);
    traders.push({
      trader: p.trader,
      pickedAs: p.pickedAs,
      pool: p.pool,
      summary: f.summary,
      summaryHash: keccak256(toBytes(f.summary)),
      expectedTier: r.tier,
      reasons: r.reasons,
      fetchedAt: f.fetchedAt,
      endpoint: { url: f.url, asOf: f.asOf, cache: f.cache, age: f.age },
    });
    console.log(`  ${r.tier.padEnd(7)} ${p.trader}  ${f.summary}`);
    await sleep(1_000);
  }
  const count = <K extends string>(keys: K[]) => keys.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {} as Record<K, number>);
  write(KEY_FILE, {
    about: "Pre-registered answer key: each trader's summary from the public endpoint and the rubric's tier for it, committed before any review of this sample was requested.",
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    windowDays: WINDOW_DAYS,
    rubric: RUBRIC,
    systemPrompt: SYSTEM_PROMPT,
    summaryHash: "keccak256 of the summary's UTF-8 bytes, as RiskReviewer hashes the agreed summary",
    selection: {
      rule:
        "Pools are read in order and each pool in its fixed order; a screened account is taken when the quota of its category (from packages/stats over the endpoint's row cap) is open. Our own wallets and contracts are excluded, except the leader, which is added last.",
      quotas: QUOTAS,
      pools: candidatePools.map((p) => ({ name: p.name, target: p.target, size: p.accounts.length })),
      screened,
    },
    counts: { pickedAs: count(traders.map((t) => t.pickedAs)), expectedTier: count(traders.map((t) => t.expectedTier)) },
    traders,
  });
  console.log(`  wrote ${KEY_FILE}: ${traders.length} traders, expected ${JSON.stringify(count(traders.map((t) => t.expectedTier)))}`);
}

// ---------------------------------------------------------------- later runs: same sample, new answer key

const count = <K extends string>(keys: K[]) => keys.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {} as Record<K, number>);

/** Run v3's answer key: run v2's traders in run v2's order, each with the rubric line the endpoint serves now. */
async function keyV3() {
  const v2 = JSON.parse(readFileSync(KEY_FILE, "utf8")) as { generatedAt: string; traders: { trader: Address; pickedAs: Category; pool: string }[] };
  const risk = JSON.parse(readFileSync(RISK_FILE, "utf8")) as { shannon: { reviewer: string; summarySelector?: string; systemPrompt?: string } };
  if (risk.shannon.summarySelector !== "rubric" || risk.shannon.systemPrompt !== SYSTEM_PROMPT) {
    throw new Error("the reviewer in deployments/risk.json does not read the rubric field with the rubric as its system message");
  }
  const traders = [];
  for (const t of v2.traders) {
    const f = await fetchSummary(t.trader);
    if (typeof f.rubric !== "string" || !f.rubric) throw new Error(`no rubric line for ${t.trader}`);
    const r = rubricTier(f.rubric);
    const onSummary = rubricTier(f.summary).tier;
    if (onSummary !== r.tier) throw new Error(`${t.trader}: the rubric line says ${r.tier}, the summary ${onSummary}`);
    traders.push({
      trader: t.trader,
      pickedAs: t.pickedAs,
      pool: t.pool,
      rubric: f.rubric,
      rubricHash: keccak256(toBytes(f.rubric)),
      expectedTier: r.tier,
      reasons: r.reasons,
      summary: f.summary,
      fetchedAt: f.fetchedAt,
      endpoint: { url: f.url, asOf: f.asOf, cache: f.cache, age: f.age },
    });
    console.log(`  ${r.tier.padEnd(7)} ${t.trader}  ${f.rubric}`);
    await sleep(1_000);
  }
  mkdirSync(dirname(RUNS.v3.key), { recursive: true });
  write(RUNS.v3.key, {
    about:
      "Pre-registered answer key, run v3: run v2's 20 traders in the same order, each with the rubric line the public endpoint serves now (the only text the LLM committee classifies) and the rubric's tier for it, committed before any review of this run was requested.",
    run: "v3",
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    field: "rubric",
    windowDays: WINDOW_DAYS,
    rubric: RUBRIC,
    systemPrompt: SYSTEM_PROMPT,
    inference: 'inferString(prompt = "Stats: " + rubric line, system = systemPrompt, chainOfThought = false, allowedValues = ["OK", "CAUTION", "BLOCK"])',
    reviewer: risk.shannon.reviewer,
    rubricHash: "keccak256 of the rubric line's UTF-8 bytes, as RiskReviewer hashes the line the JSON committee agreed on",
    sample: { from: "eval/answer-key.json (run v2, pre-registered in commit 6b1b07437b29c95c8d41916858cabdc73a7d6e07)", v2GeneratedAt: v2.generatedAt, rule: "the same traders in the same order" },
    counts: { pickedAs: count(traders.map((t) => t.pickedAs)), expectedTier: count(traders.map((t) => t.expectedTier)) },
    traders,
  });
  console.log(`  wrote ${RUNS.v3.key}: ${traders.length} traders, expected ${JSON.stringify(count(traders.map((t) => t.expectedTier)))}`);
}

/** Commit hash + keccak256 of the committed key, written on Hideki by the hub owner in a zero-value self-transfer. */
async function anchor(run: Run, commit: string) {
  const file = RUNS[run].anchor;
  if (!file) throw new Error(`run ${run} has no anchor file`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("a full commit sha1 expected");
  const path = relative(ROOT, RUNS[run].key).split("\\").join("/");
  const committed = execFileSync("git", ["show", `${commit}:${path}`], { cwd: ROOT });
  const onDisk = readFileSync(RUNS[run].key);
  if (!committed.equals(onDisk)) throw new Error(`${path} differs from its copy in ${commit}`);
  const keyHash = keccak256(committed);
  const data = concat([`0x${commit}`, keyHash]);
  const { pub, wallet, chain, EXPLORER_TX } = await import("./env.ts");
  const w = wallet("HUB_OWNER");
  const est = await pub.estimateGas({ account: w.account, to: w.account.address, data, value: 0n });
  const hash = await w.sendTransaction({ to: w.account.address, data, value: 0n, gas: (est * 3n) / 2n, chain, account: w.account } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  const b = await pub.getBlock({ blockNumber: r.blockNumber });
  const out = { run, commit, key: path, keyKeccak: keyHash, data, tx: hash, url: EXPLORER_TX + hash, block: Number(r.blockNumber), timestamp: new Date(Number(b.timestamp) * 1000).toISOString(), from: w.account.address, status: r.status, gasUsed: Number(r.gasUsed) };
  write(file, out);
  console.log(JSON.stringify(out, null, 2));
  if (r.status !== "success") throw new Error("the anchor transaction failed");
}

// ---------------------------------------------------------------- score

/** A key row holds the line the committee was to classify: the full summary in run v2, the rubric line later. */
type KeyRow = { trader: Address; pickedAs: Category; summary: string; summaryHash?: Hex; rubric?: string; rubricHash?: Hex; expectedTier: Tier; reasons: string[]; fetchedAt: string };
type Key = { generatedAt: string; systemPrompt: string; traders: KeyRow[] };
type AgentRequest = { agentId: string; call: string; args: unknown[] };
type Ev = { event: string; tx: Hex; block: number; args: Record<string, unknown> };
type Resp = { validator: Address; status: number; receipt: string; executionCost: string; result: string };
type Review = {
  trader: string;
  at: string;
  nonce?: number;
  requestTx?: Hex;
  deliveryToShannon?: Hex;
  deliveryToHideki?: Hex;
  shannonEvents?: Ev[];
  reviewer?: string;
  summaryRequest?: AgentRequest[];
  callbacks?: { tx: Hex; submittedBy: string; committee: { callback: string; requestId: string; status: number; responses: Resp[] }[]; agentRequests?: AgentRequest[] }[];
  gateEvents?: { event: string; args: Record<string, unknown> }[];
  verdict?: { tier: string };
  failure?: string;
};

const GATE_TIERS = ["None", "OK", "CAUTION", "BLOCK"] as const;
type Outcome = Tier | "None";
const HIDEKI_TX = "https://explorer.testnet.somnia.network/tokyo/tx/";
const SHANNON_TX = "https://shannon-explorer.somnia.network/tx/";

function score(run: Run) {
  const key = JSON.parse(readFileSync(RUNS[run].key, "utf8")) as Key;
  const risk = JSON.parse(readFileSync(RISK_FILE, "utf8")) as { reviews: Review[]; shannon: Record<string, unknown> };
  const after = Date.parse(key.generatedAt);
  // the previous run's committee tier per trader, for the side-by-side column
  const previous = run === "v2" ? undefined : (JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as { rows: { trader: string; committee: Outcome }[] }).rows;
  const rows = key.traders.map((k) => {
    const line = k.rubric ?? k.summary;
    const lineHash = k.rubricHash ?? k.summaryHash;
    // the first review of this trader requested after the key was written
    const r = risk.reviews.find((x) => getAddress(x.trader) === getAddress(k.trader) && Date.parse(x.at) > after);
    const ev = (name: string) => r?.shannonEvents?.find((e) => e.event === name);
    const seen = ev("SummaryReceived")?.args.summary as string | undefined;
    const seenHash = ev("SummaryReceived")?.args.summaryHash as Hex | undefined;
    const tallied = ev("VerdictTallied");
    const sent = ev("VerdictSent");
    const committee: Outcome = sent ? GATE_TIERS[Number(sent.args.tier)] : "None";
    const stage = (name: string) => r?.callbacks?.flatMap((c) => c.committee.filter((x) => x.callback === name).map((x) => ({ ...x, tx: c.tx, submittedBy: c.submittedBy })))[0];
    const json = stage("handleSummary");
    const llm = stage("handleVerdict");
    const gate = r?.gateEvents?.find((g) => ["VerdictReceived", "BlockHeld", "ReviewFailed", "StaleVerdict"].includes(g.event));
    const expectedOnSeen = seen !== undefined ? rubricTier(seen).tier : undefined;
    // exactly what the agents were asked (decoded from the reviewer's platform calls; recorded from run v3 on)
    const fetch = r?.summaryRequest?.find((q) => q.call === "fetchString");
    const infer = r?.callbacks?.flatMap((c) => c.agentRequests ?? []).find((q) => q.call === "inferString");
    const inference = infer && { prompt: infer.args[0] as string, system: infer.args[1] as string, chainOfThought: infer.args[2] as boolean, allowed: infer.args[3] as string[] };
    return {
      trader: k.trader,
      pickedAs: k.pickedAs,
      expected: k.expectedTier,
      reasons: k.reasons,
      preRegisteredLine: line,
      preRegisteredHash: lineHash,
      reviewed: !!r,
      requestedAt: r?.at,
      nonce: r?.nonce,
      seenSummary: seen,
      seenHash,
      seenHashRecomputed: seen !== undefined ? keccak256(toBytes(seen)) === seenHash : undefined,
      summaryMatch: seenHash !== undefined ? seenHash === lineHash : undefined,
      reviewer: r?.reviewer,
      fetched: fetch && { url: fetch.args[0] as string, field: fetch.args[1] as string },
      inference,
      inferenceAsPublished: inference && seen !== undefined ? inference.system === key.systemPrompt && inference.prompt === `Stats: ${seen}` : undefined,
      expectedOnSeen,
      expectedOnSeenReasons: seen !== undefined ? rubricTier(seen).reasons : undefined,
      committee,
      previousRun: previous?.find((p) => getAddress(p.trader) === getAddress(k.trader))?.committee,
      votes: tallied ? { ok: Number(tallied.args.ok), caution: Number(tallied.args.caution), block: Number(tallied.args.blocked), responded: Number(tallied.args.responded) } : undefined,
      jsonStage: json && {
        requestId: json.requestId,
        status: json.status,
        identical: new Set(json.responses.map((x) => x.result)).size === 1,
        validators: json.responses.map((x) => ({ validator: x.validator, status: x.status, receipt: x.receipt, executionCost: x.executionCost })),
      },
      answers: llm?.responses.map((x) => ({ validator: x.validator, status: x.status, receipt: x.receipt, executionCost: x.executionCost, answer: x.result })),
      llmRequestId: llm?.requestId,
      failure: r?.failure,
      gate: gate && { event: gate.event, tier: gate.args.tier !== undefined ? GATE_TIERS[Number(gate.args.tier)] : gate.args.newTier !== undefined ? GATE_TIERS[Number(gate.args.newTier)] : undefined },
      storedOnGate: r?.verdict?.tier,
      txs: {
        gateRequest: r?.requestTx && HIDEKI_TX + r.requestTx,
        summaryRequest: r?.deliveryToShannon && SHANNON_TX + r.deliveryToShannon,
        verdictRequest: ev("VerdictRequested") && SHANNON_TX + ev("VerdictRequested")!.tx,
        verdict: sent && SHANNON_TX + sent.tx,
        gateDelivery: r?.deliveryToHideki && HIDEKI_TX + r.deliveryToHideki,
      },
    };
  });

  const outcomes: Outcome[] = [...TIERS, "None"];
  const matrix = (pick: (x: (typeof rows)[number]) => Tier | undefined) => {
    const m: Record<Tier, Record<Outcome, number>> = Object.fromEntries(TIERS.map((t) => [t, Object.fromEntries(outcomes.map((o) => [o, 0]))])) as never;
    for (const x of rows) {
      const e = pick(x);
      if (e) m[e][x.committee] += 1;
    }
    return m;
  };
  const reviewed = rows.filter((x) => x.reviewed);
  const agree = (pick: (x: (typeof rows)[number]) => Tier | undefined) => reviewed.filter((x) => pick(x) === x.committee).length;
  const answers = reviewed.flatMap((x) => (x.answers ?? []).map((a) => ({ expected: x.expectedOnSeen, answer: (/[A-Za-z]+/.exec(a.answer)?.[0] ?? "").toUpperCase() })));
  const summary = {
    traders: rows.length,
    reviewed: reviewed.length,
    failures: reviewed.filter((x) => x.committee === "None").length,
    summaryChanged: reviewed.filter((x) => x.summaryMatch === false).length,
    agreementPreRegistered: agree((x) => x.expected),
    agreementOnSeenSummary: agree((x) => x.expectedOnSeen),
    falseBlocks: reviewed.filter((x) => x.committee === "BLOCK" && x.expectedOnSeen !== "BLOCK").length,
    missedBlocks: reviewed.filter((x) => x.expectedOnSeen === "BLOCK" && x.committee !== "BLOCK").length,
    // the gate acts on BLOCK only: refuse (BLOCK) or allow (anything else, a failed review included)
    gateDecisionsAgreeing: reviewed.filter((x) => (x.committee === "BLOCK") === (x.expectedOnSeen === "BLOCK")).length,
    blockRecall: { caught: reviewed.filter((x) => x.expectedOnSeen === "BLOCK" && x.committee === "BLOCK").length, expected: reviewed.filter((x) => x.expectedOnSeen === "BLOCK").length },
    falseBlockRate: { falseBlocks: reviewed.filter((x) => x.committee === "BLOCK" && x.expectedOnSeen !== "BLOCK").length, notBlockExpected: reviewed.filter((x) => x.expectedOnSeen !== undefined && x.expectedOnSeen !== "BLOCK").length },
    inferenceAsPublished: run === "v2" ? undefined : reviewed.filter((x) => x.inferenceAsPublished === true).length,
    validatorAnswers: answers.length,
    validatorAnswersAgreeing: answers.filter((a) => a.answer === a.expected).length,
    confusionPreRegistered: matrix((x) => x.expected),
    confusionOnSeenSummary: matrix((x) => x.expectedOnSeen),
  };
  write(RUNS[run].results, { run, scoredAt: new Date().toISOString(), answerKeyGeneratedAt: key.generatedAt, systemPrompt: key.systemPrompt, summary, rows });

  // markdown for the scorecard
  const md: string[] = [];
  const cm = (m: Record<Tier, Record<Outcome, number>>) => {
    md.push("| expected \\ committee | OK | CAUTION | BLOCK | no verdict |", "|---|---|---|---|---|");
    for (const t of TIERS) md.push(`| **${t}** | ${outcomes.map((o) => (o === t ? `**${m[t][o]}**` : String(m[t][o]))).join(" | ")} |`);
  };
  md.push(
    `agreement with the pre-registered key: ${summary.agreementPreRegistered}/${summary.reviewed}; with the rubric on the line the validators saw: ${summary.agreementOnSeenSummary}/${summary.reviewed}; gate decisions: ${summary.gateDecisionsAgreeing}/${summary.reviewed}; BLOCK recall ${summary.blockRecall.caught}/${summary.blockRecall.expected}; false BLOCKs ${summary.falseBlockRate.falseBlocks}/${summary.falseBlockRate.notBlockExpected}; no verdict: ${summary.failures}; lines changed after pre-registration: ${summary.summaryChanged}; missed BLOCKs: ${summary.missedBlocks}; validator answers matching the rubric: ${summary.validatorAnswersAgreeing}/${summary.validatorAnswers}${summary.inferenceAsPublished === undefined ? "" : `; inference calls as published: ${summary.inferenceAsPublished}/${summary.reviewed}`}`,
    "",
  );
  cm(summary.confusionPreRegistered);
  const same = JSON.stringify(summary.confusionPreRegistered) === JSON.stringify(summary.confusionOnSeenSummary);
  md.push("");
  if (same) md.push("(identical on the summaries the validators saw)");
  else cm(summary.confusionOnSeenSummary);

  const inputs = (line?: string) => {
    if (!line) return "–";
    const kv = new Map(line.split(" ").map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] as const));
    const parts = [`liq ${kv.get("liquidations30d")}`, `trades ${kv.get("trades30d")}`];
    if (kv.has("maxDrawdownPct30d")) parts.push(`dd% ${kv.get("maxDrawdownPct30d")}`);
    if (kv.get("partial") === "1") parts.push("partial=1");
    if (kv.get("history") === "none") parts.push("history=none");
    return parts.join(" · ");
  };
  const tick = "`";
  const addr = (a: string) => `[${tick}${a.slice(0, 6)}…${a.slice(-4)}${tick}](https://explorer.testnet.somnia.network/tokyo/address/${a})`;
  const prevCol = previous ? " previous run |" : "";
  md.push("", `| # | trader | picked as | rule inputs seen | seen = key | expected |${prevCol} committee (OK/CAU/BLK) | gate |`, `|---|---|---|---|---|---|${previous ? "---|" : ""}---|---|`);
  rows.forEach((x, i) => {
    const v = x.votes ? `${x.votes.ok}/${x.votes.caution}/${x.votes.block}` : "–";
    const tier = x.committee === x.expectedOnSeen ? x.committee : `**${x.committee}**`;
    const gate = x.gate ? `${x.gate.event}${x.gate.tier ? ` ${x.gate.tier}` : ""}` : "–";
    const seen = x.summaryMatch === undefined ? "–" : x.summaryMatch ? "yes" : "no";
    const prev = previous ? ` ${x.previousRun ?? "–"} |` : "";
    md.push(`| ${i + 1} | ${addr(x.trader)} | ${x.pickedAs} | ${inputs(x.seenSummary)} | ${seen} | ${x.expected} |${prev} ${tier} (${v}) | ${gate} |`);
  });
  const link = (h?: string) => (h ? `[${h.split("/").pop()!.slice(0, 10)}…](${h})` : "–");
  md.push("", "| # | Hideki: requestReview | Shannon: summary request | Shannon: verdict request | Shannon: verdict | Hideki: verdict delivered |", "|---|---|---|---|---|---|");
  rows.forEach((x, i) => md.push(`| ${i + 1} | ${link(x.txs.gateRequest)} | ${link(x.txs.summaryRequest)} | ${link(x.txs.verdictRequest)} | ${link(x.txs.verdict)} | ${link(x.txs.gateDelivery)} |`));
  const vals = new Map<string, { llm: number; agree: number; json: number }>();
  const entry = (v: string) => vals.get(v) ?? vals.set(v, { llm: 0, agree: 0, json: 0 }).get(v)!;
  for (const x of reviewed) {
    for (const a of x.answers ?? []) {
      const e = entry(a.validator);
      e.llm += 1;
      if ((/[A-Za-z]+/.exec(a.answer)?.[0] ?? "").toUpperCase() === x.expectedOnSeen) e.agree += 1;
    }
    for (const j of x.jsonStage?.validators ?? []) entry(j.validator).json += 1;
  }
  md.push("", "| validator | summary fetches | LLM answers | answers matching the rubric |", "|---|---|---|---|");
  for (const [v, e] of [...vals].sort((a, b) => b[1].llm - a[1].llm)) md.push(`| ${tick}${v}${tick} | ${e.json} | ${e.llm} | ${e.agree} |`);
  console.log(md.join("\n"));
  console.log(`\n  wrote ${RUNS[run].results}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "select") await select();
else if (cmd === "key" && args[0] === "v3") await keyV3();
else if (cmd === "anchor") await anchor(runOf(args[0]), args[1]);
else if (cmd === "score") score(runOf(args[0]));
else throw new Error("steps: select | key v3 | anchor <run> <commit> | score [run]");

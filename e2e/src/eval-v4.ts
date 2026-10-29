// Run v4 of the AI-guard evaluation: a held-out sample of 20 dreamDEX traders that no earlier run reviewed or screened.
// Everything the committee is given or scored by stays as it was for run v3: the rubric (eval/rubric.ts), the system
// prompt, the endpoint's rubric line, the RiskReviewer and its settings, and the scorer (e2e/src/eval.ts, which this file
// runs unchanged). This file only picks the sample, writes and anchors its answer key, and hands the key to that scorer.
//
// COPYBOOK_ENV=<env file> tsx src/eval-v4.ts select
//   screens accounts from fixed-order indexer pools by quota (the rule is SELECTION below), fetches each picked
//   trader's rubric line from the public endpoint and writes eval/v4/answer-key.json with the rubric's tier for it.
//   The env file is read only to leave our own wallets out. Commit the key before requesting any review of the run.
// COPYBOOK_ENV=<env file> tsx src/eval-v4.ts anchor <commit>
//   writes the commit hash and the keccak256 of the committed key on Hideki (a zero-value self-transfer from the hub
//   owner), after checking the committed key is byte-identical to the file; the transaction goes to eval/v4/anchor.json.
// COPYBOOK_ENV=<env file> tsx src/eval-v4.ts replay <ISO time>
//   draws the sample again as it stood at that time: every timestamp filter the draw sends to the indexer is also
//   bounded above by it, and the exclusions are read from the commit the key was drawn on (dfceabc). Compares the
//   screened accounts and the 20 picks with the committed key and writes eval/v4/draw.json; the key is not touched.
// tsx src/eval-v4.ts score [--reproduce-v3]
//   runs `tsx e2e/src/eval.ts score v3`, unchanged, in a scratch copy of the tree whose eval/v3/answer-key.json is run
//   v4's key, and writes its results to eval/v4/results.json (run "v4", with the scorer's git blob). With
//   --reproduce-v3 the copy keeps run v3's own key instead, and the output must equal eval/v3/results.json.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, getAddress, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Indexer, getTraderStats, riskRubric, type TraderStats } from "@copybook/stats";
import { RUBRIC, SYSTEM_PROMPT, rubricTier } from "../../eval/rubric.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = resolve(ROOT, "eval/v4/answer-key.json");
const RESULTS = resolve(ROOT, "eval/v4/results.json");
const ANCHOR = resolve(ROOT, "eval/v4/anchor.json");
const DRAW = resolve(ROOT, "eval/v4/draw.json");
/** The commit the sample was drawn on: the parent of the anchored key commit. */
const DRAWN_ON = "dfceabc";
const ENDPOINT = "https://copybook-eosin.vercel.app/api/risk/";
/** The endpoint's row cap per trader and table: screening sees what the endpoint sees. */
const ROW_CAP = 2000;
const WINDOW_DAYS = 30;
const MAX_SCREENED = 100;

type Stratum = "liquidated-2+" | "liquidated-1" | "thin" | "clean";
/** Runs v2 and v3 took 6 / 4 / 3 / 6 plus our leader; this run has no leader, so its place goes to the clean stratum. */
const QUOTAS: Record<Stratum, number> = { "liquidated-2+": 6, "liquidated-1": 4, thin: 3, clean: 7 };
const TOTAL = Object.values(QUOTAS).reduce((a, b) => a + b, 0);

const SELECTION = [
  "Exclusions: every trader reviewed in runs v1 to v3 (deployments/risk.json reviews), every account in run v2's key (its 20 traders and all 59 screened accounts) and run v3's key, our demo wallets (deployments/hideki.json demoWallets), our contracts (hub, engine, themes, gate, both reviewers) and the wallets of our own keys.",
  "Pools, read in this order and each in its fixed order (the same pools as run v2, without its first-live-run pool): accounts with 2 or more liquidations in the latest 1000 liquidation rows of the window (most liquidations first, then most recent); with exactly 1 (most recent first); the fewest rows in the latest 1000 position changes (fewest first, then most recent); the accounts behind the largest single realized gains (packages/stats' leaderboard candidates); the latest position changes (most recent first).",
  "Phase 1: a pool is read while its target stratum's quota is open; each account not excluded is screened with packages/stats over the endpoint's 2,000-row cap and taken when the quota of the stratum it falls in is open. Strata: 2+ liquidations; exactly 1; thin (fewer than 10 trades or no history); clean (the rest).",
  `Fallback, fixed before any review: if a quota is still open after every pool or at ${MAX_SCREENED} screened accounts, the open places are filled from the screened accounts not taken, in screening order, whatever their stratum; the shortfall per stratum is recorded.`,
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const write = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
};
const readJson = <T>(rel: string) => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8")) as T;
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT }).toString().trim();
/** A file as it is in the working tree, or as committed in `rev`. */
const readJsonAt = <T>(rel: string, rev?: string) => (rev ? (JSON.parse(git("show", `${rev}:${rel}`)) as T) : readJson<T>(rel));

function strataOf(s: TraderStats): Stratum {
  if (s.liquidations30d >= 2) return "liquidated-2+";
  if (s.liquidations30d === 1) return "liquidated-1";
  return s.trades30d < 10 || !s.hasHistory ? "thin" : "clean";
}

/** Accounts no earlier run reviewed or screened, and none of ours; from the working tree, or as committed in `rev`. */
function excluded(rev?: string): { all: Set<string>; counts: Record<string, number> } {
  const readJson = <T>(rel: string) => readJsonAt<T>(rel, rev);
  const add = (set: Set<string>, a: unknown) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && set.add(a.toLowerCase());
  const earlier = new Set<string>();
  const risk = readJson<{ reviews: { trader: string }[]; shannon: { reviewer: string }; hideki: { gate: string }; previousReviewers?: { reviewer: string }[] }>("deployments/risk.json");
  for (const r of risk.reviews) add(earlier, r.trader);
  const v2 = readJson<{ traders: { trader: string }[]; selection: { screened: { trader: string }[] } }>("eval/answer-key.json");
  for (const t of v2.traders) add(earlier, t.trader);
  for (const t of v2.selection.screened) add(earlier, t.trader);
  for (const t of readJson<{ traders: { trader: string }[] }>("eval/v3/answer-key.json").traders) add(earlier, t.trader);

  const ours = new Set<string>();
  const dep = readJson<Record<string, unknown> & { demoWallets: { address: string }[] }>("deployments/hideki.json");
  for (const w of dep.demoWallets) add(ours, w.address);
  for (const k of ["hub", "engine", "themes", "owner", "marginBank", "operatorRegistry"]) add(ours, dep[k]);
  add(ours, risk.hideki.gate);
  add(ours, risk.shannon.reviewer);
  for (const p of risk.previousReviewers ?? []) add(ours, p.reviewer);
  const path = process.env.COPYBOOK_ENV;
  if (!path) throw new Error("set COPYBOOK_ENV: our own wallets are left out of the sample");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+)\s*$/.exec(line);
    if (!m || m[1] === "LEADER_PK") continue; // the leader is in demoWallets; its key is never read
    if (m[1].endsWith("_PK") && m[2].length === 66) add(ours, privateKeyToAccount(m[2] as Hex).address);
    else add(ours, m[2]);
  }
  const all = new Set([...earlier, ...ours]);
  return { all, counts: { earlierRuns: earlier.size, ours: ours.size, total: all.size } };
}

const LIQUIDATED_ACCOUNTS = `query LiquidatedAccounts($since:numeric!){
  LiquidationEvent(where:{timestamp:{_gte:$since},kind:{_in:["AccountLiquidated","PositionLiquidated"]}},order_by:[{timestamp:desc},{id:desc}],limit:1000){ account timestamp txHash }}`;
const ACTIVE_ACCOUNTS = `query ActiveAccounts($since:numeric!){
  PerpPositionChange(where:{timestamp:{_gte:$since}},order_by:[{timestamp:desc},{id:desc}],limit:1000){ account timestamp }}`;

type Pool = { name: string; target: Stratum; accounts: string[] };

/** An indexer whose every `timestamp >= since` filter is also bounded above, to read the indexer as it stood at `until`. */
class BoundedIndexer extends Indexer {
  constructor(
    opts: ConstructorParameters<typeof Indexer>[0],
    private readonly until: number,
  ) {
    super(opts);
  }
  override query<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const bounded = query.split("timestamp:{_gte:$since}").join(`timestamp:{_gte:$since,_lte:${this.until}}`);
    // every query the draw sends with a time window must carry the bound; the others (leverage, last active,
    // markets) have no time filter
    if (/\$since/.test(query) && bounded === query) throw new Error(`${operationName}: no timestamp filter to bound`);
    return super.query<T>(operationName, bounded, variables);
  }
}

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
  const recent = [...rows].map(([a, e]) => ({ a, ...e })).sort((x, y) => x.n - y.n || y.last - x.last || x.a.localeCompare(y.a));
  const gainers = await ix.candidateAccounts(since, 25);
  return [
    { name: "2+ liquidations in the latest 1000 liquidation rows", target: "liquidated-2+", accounts: multi.map((x) => x.a) },
    { name: "1 liquidation in the latest 1000 liquidation rows", target: "liquidated-1", accounts: single.map((x) => x.a) },
    { name: "fewest rows in the latest 1000 position changes", target: "thin", accounts: recent.map((x) => x.a) },
    { name: "largest single realized gains", target: "clean", accounts: gainers.map((a) => a.toLowerCase()) },
    { name: "latest position changes", target: "clean", accounts: [...recent].sort((x, y) => y.last - x.last || x.a.localeCompare(y.a)).map((x) => x.a) },
  ];
}

type Fetched = { url: string; fetchedAt: string; rubric: string; summary: string; asOf: string; cache: string | null; age: string | null };

/** The trader's lines from the public endpoint, at the URL the reviewer's validators fetch (lowercase address). */
async function fetchLines(trader: Address): Promise<Fetched> {
  const url = ENDPOINT + trader.toLowerCase();
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(3_000 * attempt);
    const fetchedAt = new Date().toISOString();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const body = await res.text();
      if (res.status === 200) {
        const j = JSON.parse(body) as { rubric?: string; summary?: string; asOf: string };
        if (!j.rubric || !j.summary) throw new Error("no rubric or summary in the response");
        return { url, fetchedAt, rubric: j.rubric, summary: j.summary, asOf: j.asOf, cache: res.headers.get("x-vercel-cache"), age: res.headers.get("age") };
      }
      last = `HTTP ${res.status} ${body.slice(0, 120)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    console.log(`  (endpoint retry for ${trader}: ${last})`);
  }
  throw new Error(`endpoint failed for ${trader}: ${last}`);
}

/** The reviewer's settings as the chain reports them, and whether each is still run v3's. */
async function frozenState() {
  const { shannonPub, pub } = await import("./env.ts");
  const risk = readJson<{ shannon: { reviewer: Address }; hideki: { gate: Address } }>("deployments/risk.json");
  const v3 = readJson<{ reviewer: string; systemPrompt: string }>("eval/v3/answer-key.json");
  const r = parseAbi([
    "function summarySelector() view returns (string)",
    "function systemPrompt() view returns (string)",
    "function baseUrl() view returns (string)",
    "function gate() view returns (address)",
    "function jsonAgentId() view returns (uint256)",
    "function llmAgentId() view returns (uint256)",
  ]);
  const read = <T>(functionName: string) => shannonPub.readContract({ address: risk.shannon.reviewer, abi: r, functionName } as never) as Promise<T>;
  const gateReviewer = (await pub.readContract({ address: risk.hideki.gate, abi: parseAbi(["function reviewer() view returns (address)"]), functionName: "reviewer" })) as Address;
  const state = {
    reviewer: getAddress(risk.shannon.reviewer),
    sameReviewerAsRunV3: getAddress(risk.shannon.reviewer) === getAddress(v3.reviewer),
    gateAsksThisReviewer: getAddress(gateReviewer) === getAddress(risk.shannon.reviewer),
    reviewerAnswersThisGate: getAddress(await read<Address>("gate")) === getAddress(risk.hideki.gate),
    summarySelector: await read<string>("summarySelector"),
    systemPromptIsRunV3s: (await read<string>("systemPrompt")) === v3.systemPrompt && v3.systemPrompt === SYSTEM_PROMPT,
    baseUrl: await read<string>("baseUrl"),
    agents: { json: (await read<bigint>("jsonAgentId")).toString(), llm: (await read<bigint>("llmAgentId")).toString() },
    rubricTsBlob: git("rev-parse", "HEAD:eval/rubric.ts"),
    rubricTsBlobAtRunV3: git("rev-parse", "5aed53b:eval/rubric.ts"),
    scorerBlob: git("rev-parse", "HEAD:e2e/src/eval.ts"),
    scorerBlobAtRunV3: git("rev-parse", "5aed53b:e2e/src/eval.ts"),
    readAt: new Date().toISOString(),
  };
  return state;
}

/** The draw: pools in their fixed order, screening by quota, then the fallback. `now` ends the 30-day window. */
async function draw(now: number, ix: Indexer, exclusionsAt?: string) {
  const { all: skip, counts: excludedCounts } = excluded(exclusionsAt);
  const since = now - WINDOW_DAYS * 86400;
  const candidatePools = await pools(ix, since);

  type Screened = { trader: string; pool: string; stratum: string; taken: boolean; takenBy?: "quota" | "fallback"; line?: string };
  const screened: Screened[] = [];
  const picked: { trader: Address; pickedAs: Stratum; pool: string; by: "quota" | "fallback" }[] = [];
  const seen = new Set<string>();
  const open = (c: Stratum) => picked.filter((p) => p.pickedAs === c).length < QUOTAS[c];

  // phase 1: by quota
  outer: for (const pool of candidatePools) {
    for (const a of pool.accounts) {
      if (!open(pool.target)) break;
      if (screened.length >= MAX_SCREENED) break outer;
      if (seen.has(a) || skip.has(a)) continue;
      seen.add(a);
      let s: TraderStats;
      try {
        s = await getTraderStats(a as Address, { indexer: ix, now, windowDays: WINDOW_DAYS });
      } catch (e) {
        screened.push({ trader: a, pool: pool.name, stratum: `error: ${e instanceof Error ? e.message : String(e)}`, taken: false });
        continue;
      }
      const c = strataOf(s);
      const taken = open(c);
      const line = riskRubric(s);
      screened.push({ trader: a, pool: pool.name, stratum: c, taken, ...(taken ? { takenBy: "quota" as const } : {}), line });
      console.log(`  ${taken ? "take" : "skip"} ${c.padEnd(13)} ${a}  ${line}`);
      if (taken) picked.push({ trader: getAddress(a), pickedAs: c, pool: pool.name, by: "quota" });
    }
  }
  // fallback: open places from the screened accounts not taken, in screening order
  const shortfall = Object.fromEntries((Object.keys(QUOTAS) as Stratum[]).map((c) => [c, QUOTAS[c] - picked.filter((p) => p.pickedAs === c).length]));
  const fallbackUsed = picked.length < TOTAL;
  for (const s of screened) {
    if (picked.length >= TOTAL) break;
    if (s.taken || s.stratum.startsWith("error")) continue;
    s.taken = true;
    s.takenBy = "fallback";
    picked.push({ trader: getAddress(s.trader), pickedAs: s.stratum as Stratum, pool: s.pool, by: "fallback" });
    console.log(`  take (fallback) ${s.stratum.padEnd(13)} ${s.trader}`);
  }
  if (picked.length < TOTAL) throw new Error(`only ${picked.length} of ${TOTAL} traders within ${MAX_SCREENED} screened accounts`);

  return { excludedCounts, candidatePools, screened, picked, shortfall, fallbackUsed };
}

async function select() {
  const frozen = await frozenState();
  console.log("  frozen state", JSON.stringify(frozen));
  const bad = [
    !frozen.sameReviewerAsRunV3 && "reviewer",
    !frozen.gateAsksThisReviewer && "gate.reviewer",
    !frozen.reviewerAnswersThisGate && "reviewer.gate",
    frozen.summarySelector !== "rubric" && "summarySelector",
    !frozen.systemPromptIsRunV3s && "systemPrompt",
    frozen.baseUrl !== ENDPOINT && "baseUrl",
    frozen.scorerBlob !== frozen.scorerBlobAtRunV3 && "scorer",
  ].filter(Boolean);
  if (bad.length) throw new Error(`not run v3's setup: ${bad.join(", ")}`);
  // eval/rubric.ts changed after run v3 only in a comment: its code lines must be identical
  const code = (rev: string) => git("show", `${rev}:eval/rubric.ts`).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  if (code("HEAD") !== code("5aed53b")) throw new Error("eval/rubric.ts code differs from run v3's");

  const now = Math.floor(Date.now() / 1000);
  const { excludedCounts, candidatePools, screened, picked, shortfall, fallbackUsed } = await draw(now, new Indexer({ maxRows: ROW_CAP, delayMs: 150 }));

  // the answer key: the rubric line the endpoint serves now, and the rubric's tier for it
  const traders = [];
  for (const p of picked) {
    const f = await fetchLines(p.trader);
    const r = rubricTier(f.rubric);
    const onSummary = rubricTier(f.summary).tier;
    if (onSummary !== r.tier) throw new Error(`${p.trader}: the rubric line says ${r.tier}, the summary ${onSummary}`);
    traders.push({
      trader: p.trader,
      pickedAs: p.pickedAs,
      pool: p.pool,
      pickedBy: p.by,
      rubric: f.rubric,
      rubricHash: keccak256(toBytes(f.rubric)),
      expectedTier: r.tier,
      reasons: r.reasons,
      summary: f.summary,
      fetchedAt: f.fetchedAt,
      endpoint: { url: f.url, asOf: f.asOf, cache: f.cache, age: f.age },
    });
    console.log(`  ${r.tier.padEnd(7)} ${p.trader}  ${f.rubric}`);
    await sleep(1_000);
  }
  const count = <K extends string>(keys: K[]) => keys.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {} as Record<K, number>);
  write(KEY, {
    about:
      "Pre-registered answer key, run v4 (held out): 20 dreamDEX traders that no earlier run reviewed or screened, each with the rubric line the public endpoint serves now (the only text the LLM committee classifies) and the rubric's tier for it, committed before any review of this run was requested. The rubric, the prompt, the endpoint's line, the reviewer and the scorer are run v3's, unchanged.",
    run: "v4",
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    field: "rubric",
    windowDays: WINDOW_DAYS,
    rubric: RUBRIC,
    systemPrompt: SYSTEM_PROMPT,
    inference: 'inferString(prompt = "Stats: " + rubric line, system = systemPrompt, chainOfThought = false, allowedValues = ["OK", "CAUTION", "BLOCK"])',
    reviewer: frozen.reviewer,
    rubricHash: "keccak256 of the rubric line's UTF-8 bytes, as RiskReviewer hashes the line the JSON committee agreed on",
    frozen,
    selection: {
      rule: SELECTION,
      quotas: QUOTAS,
      maxScreened: MAX_SCREENED,
      excluded: excludedCounts,
      pools: candidatePools.map((p) => ({ name: p.name, target: p.target, size: p.accounts.length })),
      fallback: { used: fallbackUsed, shortfallBeforeFallback: shortfall },
      screened,
    },
    counts: { pickedAs: count(traders.map((t) => t.pickedAs)), expectedTier: count(traders.map((t) => t.expectedTier)) },
    traders,
  });
  console.log(`  wrote ${KEY}: ${traders.length} traders, expected ${JSON.stringify(count(traders.map((t) => t.expectedTier)))}; screened ${screened.length}; fallback ${fallbackUsed ? JSON.stringify(shortfall) : "not used"}`);
}

/** Draws the sample again as the indexer stood at `at`, and compares it with the committed key. */
async function replay(at: string) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error("an ISO time expected, e.g. 2026-10-29T22:39:04Z");
  const now = Math.floor(ms / 1000);
  const key = readJson<{ generatedAt: string; frozen: { readAt: string }; selection: { screened: { trader: string; pool: string; stratum: string; taken: boolean; takenBy?: string; line?: string }[] }; traders: { trader: string; pickedAs: string; pool: string; pickedBy: string }[] }>("eval/v4/answer-key.json");
  const d = await draw(now, new BoundedIndexer({ maxRows: ROW_CAP, delayMs: 150 }, now), DRAWN_ON);
  const pick = (x: { trader: string; pool: string; stratum: string; taken: boolean; takenBy?: string }) => `${x.trader.toLowerCase()}|${x.pool}|${x.stratum}|${x.taken}|${x.takenBy ?? ""}`;
  const was = key.selection.screened.map(pick);
  const is = d.screened.map(pick);
  const firstDiff = was.findIndex((x, i) => x !== is[i]);
  const sameScreened = was.length === is.length && firstDiff === -1;
  const picks = (xs: { trader: string; pickedAs: string; pool: string; by: string }[]) => xs.map((x) => `${x.trader.toLowerCase()}|${x.pickedAs}|${x.pool}|${x.by}`).join(",");
  const samePicks = picks(key.traders.map((t) => ({ ...t, by: t.pickedBy }))) === picks(d.picked);
  const lineDiffs = d.screened.filter((x, i) => key.selection.screened[i] && x.line !== key.selection.screened[i].line).map((x) => x.trader);
  const out = {
    run: "v4",
    about:
      "How run v4's sample was drawn and how to draw it again. Written after the run: the anchored key (eval/v4/answer-key.json) is unchanged.",
    drawnOn: `${DRAWN_ON} (the parent of the anchored key commit a7c42c2)`,
    now: {
      recorded: false,
      note: `The draw's clock (the end of its 30-day window) was not written down. It was read after the reviewer's settings (frozen.readAt ${key.frozen.readAt}) and before the first account was screened; the key was written at ${key.generatedAt}.`,
    },
    windowDays: WINDOW_DAYS,
    rowCap: ROW_CAP,
    maxScreened: MAX_SCREENED,
    replay: {
      command: `COPYBOOK_ENV=<env file> npm run eval:v4 replay ${at}`,
      at: new Date(now * 1000).toISOString(),
      how: `every timestamp filter the draw sends to the indexer is also bounded above by ${now} (${new Date(now * 1000).toISOString()}); the exclusions come from deployments/risk.json, deployments/hideki.json, eval/answer-key.json and eval/v3/answer-key.json as committed in ${DRAWN_ON}, and from the env file's own wallets`,
      ranAt: new Date().toISOString(),
      screened: d.screened.length,
      sameScreenedAccounts: sameScreened,
      ...(sameScreened ? {} : { firstDifference: { index: firstDiff, key: was[firstDiff], replay: is[firstDiff] } }),
      samePicks,
      excluded: d.excludedCounts,
      pools: d.candidatePools.map((p) => ({ name: p.name, size: p.accounts.length })),
      screenedLinesThatDiffer: lineDiffs.length,
      ...(lineDiffs.length ? { screenedLinesThatDifferNote: "lines carry figures the bound does not cover (leverage settings change the drawdown percentage); the strata and picks above are what the draw used" } : {}),
    },
  };
  write(DRAW, out);
  console.log(JSON.stringify(out.replay, null, 2));
  if (!sameScreened || !samePicks) process.exitCode = 1;
}

async function anchor(commit: string) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("a full commit sha1 expected");
  const path = relative(ROOT, KEY).split("\\").join("/");
  const committed = execFileSync("git", ["show", `${commit}:${path}`], { cwd: ROOT });
  if (!committed.equals(readFileSync(KEY))) throw new Error(`${path} differs from its copy in ${commit}`);
  const keyHash = keccak256(committed);
  const data = concat([`0x${commit}`, keyHash]);
  const { pub, wallet, chain, EXPLORER_TX } = await import("./env.ts");
  const w = wallet("HUB_OWNER");
  const est = await pub.estimateGas({ account: w.account, to: w.account.address, data, value: 0n });
  const hash = await w.sendTransaction({ to: w.account.address, data, value: 0n, gas: (est * 3n) / 2n, chain, account: w.account } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  const b = await pub.getBlock({ blockNumber: r.blockNumber });
  const out = { run: "v4", commit, key: path, keyKeccak: keyHash, data, tx: hash, url: EXPLORER_TX + hash, block: Number(r.blockNumber), timestamp: new Date(Number(b.timestamp) * 1000).toISOString(), from: w.account.address, status: r.status, gasUsed: Number(r.gasUsed) };
  write(ANCHOR, out);
  console.log(JSON.stringify(out, null, 2));
  if (r.status !== "success") throw new Error("the anchor transaction failed");
}

/** Runs the unchanged scorer (`eval.ts score v3`) in a scratch copy of the tree. The copy sits under e2e/.scratch/
 * (ignored by git), so its imports resolve to e2e/node_modules by walking up, with no link to remove afterwards. */
function score(reproduceV3: boolean) {
  mkdirSync(resolve(ROOT, "e2e/.scratch"), { recursive: true });
  const tmp = mkdtempSync(resolve(ROOT, "e2e/.scratch/score-"));
  try {
    const put = (from: string, to = from) => {
      mkdirSync(dirname(join(tmp, to)), { recursive: true });
      copyFileSync(resolve(ROOT, from), join(tmp, to));
    };
    for (const f of ["e2e/src/eval.ts", "e2e/package.json", "eval/rubric.ts", "eval/package.json", "deployments/risk.json"]) put(f);
    if (reproduceV3) {
      put("eval/v3/answer-key.json");
      put("eval/results.json"); // run v3's "previous run" column reads run v2's results
    } else {
      put("eval/v4/answer-key.json", "eval/v3/answer-key.json");
      put("eval/v3/results.json", "eval/results.json"); // the "previous run" column then reads run v3's (empty: no trader repeats)
    }
    const tsx = resolve(ROOT, "e2e/node_modules/tsx/dist/cli.mjs");
    const md = execFileSync(process.execPath, [tsx, join(tmp, "e2e/src/eval.ts"), "score", "v3"], { cwd: join(tmp, "e2e"), maxBuffer: 64 << 20 }).toString();
    const out = JSON.parse(readFileSync(join(tmp, "eval/v3/results.json"), "utf8")) as Record<string, unknown>;
    const blob = git("hash-object", join(tmp, "e2e/src/eval.ts"));
    if (blob !== git("rev-parse", "5aed53b:e2e/src/eval.ts")) throw new Error("the scorer copy is not run v3's eval.ts");
    if (reproduceV3) {
      const strip = (o: Record<string, unknown>) => JSON.stringify({ ...o, scoredAt: undefined });
      const committed = readJson<Record<string, unknown>>("eval/v3/results.json");
      const same = strip(out) === strip(committed);
      console.log(md.split("\n")[0]);
      console.log(`  reproduces eval/v3/results.json (scoredAt aside): ${same}`);
      if (!same) process.exitCode = 1;
      return;
    }
    const { run: _ignored, ...rest } = out;
    write(RESULTS, {
      run: "v4",
      scorer: { file: "e2e/src/eval.ts", gitBlob: blob, sameAsCommit: "5aed53b (run v3's pre-registration)", invoked: "tsx e2e/src/eval.ts score v3, in a scratch copy of the tree whose eval/v3/answer-key.json is eval/v4/answer-key.json" },
      ...rest,
    });
    console.log(md);
    console.log(`  wrote ${RESULTS}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "select") {
  if (existsSync(KEY)) throw new Error(`${KEY} exists: the key is written once`);
  await select();
} else if (cmd === "replay") await replay(args[0]);
else if (cmd === "anchor") await anchor(args[0]);
else if (cmd === "score") score(args[0] === "--reproduce-v3");
else throw new Error("steps: select | replay <ISO time> | anchor <commit> | score [--reproduce-v3]");

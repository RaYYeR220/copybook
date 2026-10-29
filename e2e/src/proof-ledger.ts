// The proof ledger: re-reads every transaction Copybook's docs cite from the chain and writes docs/PROOF.md.
//
//   npm run proof          (in e2e/; read-only: it sends nothing and needs no key)
//
// Sources: e2e/proof/sources.json (the runs' transactions, by section, with what was recorded for each), every
// transaction in deployments/*.json and eval/*/anchor.json, the landing's proof (app/content/proof.ts), and every
// explorer link in the docs. Exit code 0 when everything verifies, 1 when anything fails, 2 when some transactions could
// not be read because the RPC kept failing (those are reported as unverified, never as verified or failed).
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeEventLog,
  decodeFunctionData,
  getContractAddress,
  keccak256,
  parseAbi,
  slice,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiFunction,
  type Hex,
} from "viem";
import { hubAbi } from "../../packages/sdk/src/abi/hub.ts";
import { themesAbi } from "../../packages/sdk/src/abi/themes.ts";
import { gateAbi } from "../../packages/sdk/src/abi/gate.ts";
import type { ProofInput } from "./proof-render.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = <T = any>(rel: string): T => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8")) as T;

// ---------------------------------------------------------------- chains and contracts

export type ChainName = "hideki" | "shannon";

const hidekiDeployment = readJson("deployments/hideki.json");
const riskDeployment = readJson("deployments/risk.json");
const shannonExplorer = new URL(riskDeployment.shannon.explorer as string).origin;

export const CHAINS: Record<ChainName, { id: number; name: string; rpc: string; explorerTx: string; explorerAddress: string }> = {
  hideki: {
    id: 50383,
    name: "Hideki",
    rpc: process.env.HIDEKI_RPC ?? "https://api.hideki2.infra.testnet.somnia.network",
    explorerTx: "https://explorer.testnet.somnia.network/tokyo/tx/",
    explorerAddress: "https://explorer.testnet.somnia.network/tokyo/address/",
  },
  shannon: {
    id: 50312,
    name: "Shannon",
    rpc: process.env.SHANNON_RPC ?? "https://dream-rpc.somnia.network",
    explorerTx: `${shannonExplorer}/tx/`,
    explorerAddress: `${shannonExplorer}/address/`,
  },
};

export const HUB: string = hidekiDeployment.hub;
/** The deterministic CREATE2 deployer forge uses for libraries. */
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const reviewerAbi = parseAbi([
  "event ReviewReceived(address indexed trader, uint64 nonce)",
  "event SummaryRequested(address indexed trader, uint64 nonce, uint256 indexed requestId, uint256 deposit)",
  "event SummaryReceived(address indexed trader, uint64 nonce, uint256 indexed requestId, bytes32 summaryHash, string summary)",
  "event VerdictRequested(address indexed trader, uint64 nonce, uint256 indexed requestId, uint256 deposit)",
  "event VerdictTallied(address indexed trader, uint64 nonce, uint256 indexed requestId, uint8 tier, uint8 ok, uint8 caution, uint8 blocked, uint8 responded)",
  "event ReviewFailed(address indexed trader, uint64 nonce, uint256 indexed requestId, bytes32 summaryHash, uint8 reason)",
  "event Unfunded(address indexed trader, uint64 nonce, uint256 needed, uint256 available)",
  "event VerdictSent(address indexed trader, uint64 nonce, uint8 tier, bytes32 messageId)",
  "event ReplyFailed(address indexed trader, uint64 nonce, uint8 tier)",
  "event BaseUrlSet(string baseUrl)",
  "event SystemPromptSet(string systemPrompt)",
  "event SummarySelectorSet(string summarySelector)",
  "event GateSet(address gate)",
  "event AgentsSet(uint256 jsonAgentId, uint256 llmAgentId)",
  "event Withdrawn(address indexed to, uint256 amount)",
  "function setGate(address gate)",
  "function setBaseUrl(string baseUrl)",
  "function setSystemPrompt(string systemPrompt)",
  "function setSummarySelector(string summarySelector)",
  "function setAgents(uint256 jsonAgentId, uint256 llmAgentId)",
  "function withdraw(address to, uint256 amount)",
]);
/** dreamDEX's operator registry, a perps pool's order entry, the reactive relay's entry point, Hyperlane's mailbox. */
const venueAbi = parseAbi([
  "function setOperatorApprovalGlobal(address operator, bytes4[] selectors, bool approved)",
  "function setOperatorApprovalForPool(address pool, address operator, bytes4[] selectors, bool approved)",
  "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)",
  "function onEvent(address emitter, bytes32[] topics, bytes data)",
  "function process(bytes metadata, bytes message)",
]);

/** Contracts whose events the ledger decodes, by address. */
const EMITTERS = new Map<string, Abi>([
  [HUB.toLowerCase(), hubAbi as Abi],
  [String(hidekiDeployment.themes).toLowerCase(), themesAbi as Abi],
  [String(riskDeployment.hideki.gate).toLowerCase(), gateAbi as Abi],
  [String(riskDeployment.shannon.reviewer).toLowerCase(), reviewerAbi as Abi],
  ...((riskDeployment.previousReviewers ?? []) as { reviewer: string }[]).map(
    (p) => [p.reviewer.toLowerCase(), reviewerAbi as Abi] as [string, Abi],
  ),
]);

const FUNCTIONS = new Map<string, AbiFunction>();
for (const abi of [hubAbi, themesAbi, gateAbi, reviewerAbi, venueAbi] as Abi[])
  for (const item of abi) if (item.type === "function") FUNCTIONS.set(toFunctionSelector(item), item);

export const REASON = ["None", "Paused", "MarketNotAllowed", "TotalCap", "EquityFloor", "TankEmpty", "RiskGate", "BandUnfilled", "VenueRejected", "LegFailed", "BelowMinimum", "AtCap"] as const;
export const TIER = ["None", "Ok", "Caution", "Block"] as const;
const KIND = ["Trader", "Theme"] as const;
const FAILURE = ["Unfunded", "AgentUnavailable", "CommitteeFailed", "NoSummary", "NoMajority"] as const;
/** Enum arguments, written by name. */
const ENUMS: Record<string, Record<string, readonly string[]>> = {
  Refused: { reason: REASON },
  Followed: { kind: KIND },
  follow: { kind: KIND },
  VerdictReceived: { tier: TIER },
  VerdictTallied: { tier: TIER },
  VerdictSent: { tier: TIER },
  ReplyFailed: { tier: TIER },
  BlockHeld: { newTier: TIER },
  ReviewFailed: { reason: FAILURE },
};

/** Venue errors a refusal can carry, by selector. */
export const VENUE_ERRORS: Record<string, string> = Object.fromEntries(
  ["FillOrKillNotFillable()"].map((sig) => [keccak256(toHex(sig)).slice(0, 10), sig]),
);

// ---------------------------------------------------------------- verification

export interface RpcClient {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** A minimal JSON-RPC client: an error or a non-200 answer throws, a `null` result is returned as null. */
export function httpRpc(url: string, timeoutMs = 30_000): RpcClient {
  let id = 0;
  return {
    async request({ method, params }) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${method}`);
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
      return body.result ?? null;
    },
  };
}

export interface EventExpect {
  name: string;
  /** Each listed argument must equal the decoded one (addresses and hex compared case-insensitively). */
  args?: Record<string, string>;
}
export interface Expect {
  /** Defaults to "success". */
  status?: "success" | "reverted";
  block?: number;
  /** Position of the transaction in its block. */
  index?: number;
  from?: string;
  /** null: a contract creation. */
  to?: string | null;
  /** A function name (resolved through the known ABIs) or a 4-byte selector. */
  method?: string;
  args?: Record<string, unknown>;
  input?: string;
  value?: string;
  gasUsed?: number;
  contractAddress?: string;
  events?: EventExpect[];
  /** Event names that must not be emitted by the decoded contracts. */
  noEvents?: string[];
}
export interface TxSpec {
  hash: Hex;
  chain: ChainName;
  label: string;
  expect?: Expect;
}
export interface DecodedEvent {
  name: string;
  address: string;
  logIndex: number;
  args: Record<string, string>;
}
export interface Facts {
  chain: ChainName;
  hash: Hex;
  status: "success" | "reverted";
  block: number;
  index: number;
  from: string;
  to: string | null;
  input: Hex;
  selector: string;
  method?: string;
  args?: Record<string, string>;
  value: bigint;
  gasUsed: number;
  gasPrice: bigint;
  contractAddress: string | null;
  /** Events emitted by Copybook's contracts (hub, thesis registry, risk gate, reviewers), decoded. */
  events: DecodedEvent[];
}
export type Outcome = "verified" | "failed" | "unverified";
export interface Verification {
  ok: boolean;
  outcome: Outcome;
  status?: "success" | "reverted";
  block?: number;
  index?: number;
  reason?: string;
  facts?: Facts;
}
export interface VerifyOptions {
  /** Tries per RPC call before the row is reported unverified. */
  attempts?: number;
  /** First retry delay; it doubles each time. */
  delayMs?: number;
  /** Extra reads when the node answers that a transaction does not exist. */
  notFoundRetries?: number;
  /** Shares one read per transaction between rows. */
  cache?: Map<string, Promise<Fetched>>;
}
export type Fetched = { kind: "found"; facts: Facts } | { kind: "missing" } | { kind: "rpc"; error: string };

class RpcUnavailable extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

async function call<T>(client: RpcClient, method: string, params: unknown[], o: Required<Pick<VerifyOptions, "attempts" | "delayMs">>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < o.attempts; attempt++) {
    if (attempt > 0) await sleep(o.delayMs * 2 ** (attempt - 1));
    try {
      return (await client.request({ method, params })) as T;
    } catch (e) {
      last = e;
    }
  }
  throw new RpcUnavailable(`${method} failed ${o.attempts} times: ${errText(last)}`);
}

/** Bigints and booleans as strings, enums by name, tuples and arrays as JSON. */
function norm(v: unknown): string {
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
}
function named(owner: string, inputs: readonly { name?: string }[], values: readonly unknown[] | Record<string, unknown>) {
  const out: Record<string, string> = {};
  inputs.forEach((input, i) => {
    const key = input.name || String(i);
    const raw = Array.isArray(values) ? values[i] : (values as Record<string, unknown>)[key];
    const names = ENUMS[owner]?.[key];
    out[key] = names && (typeof raw === "number" || typeof raw === "bigint") ? (names[Number(raw)] ?? norm(raw)) : norm(raw);
  });
  return out;
}

function decodeEvents(logs: { address: string; topics: Hex[]; data: Hex; logIndex: string }[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const log of logs) {
    const abi = EMITTERS.get(log.address.toLowerCase());
    if (!abi || log.topics.length === 0) continue;
    try {
      const d = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }) as {
        eventName: string;
        args?: Record<string, unknown>;
      };
      const item = abi.find((x) => x.type === "event" && x.name === d.eventName);
      const inputs = item && item.type === "event" ? item.inputs : [];
      out.push({ name: d.eventName, address: log.address, logIndex: Number(log.logIndex), args: named(d.eventName, inputs, d.args ?? {}) });
    } catch {
      // an event of another contract at the same address, or none we know
    }
  }
  return out;
}

type RawTx = { blockNumber: Hex | null; transactionIndex: Hex | null; from: string; to: string | null; input: Hex; value: Hex };
type RawReceipt = {
  status: Hex;
  blockNumber: Hex;
  transactionIndex: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  contractAddress: string | null;
  logs: { address: string; topics: Hex[]; data: Hex; logIndex: string }[];
};

export async function fetchFacts(client: RpcClient, chain: ChainName, hash: Hex, opts: VerifyOptions = {}): Promise<Fetched> {
  const o = { attempts: opts.attempts ?? 5, delayMs: opts.delayMs ?? 1500, notFoundRetries: opts.notFoundRetries ?? 2 };
  try {
    let tx: RawTx | null = null;
    let receipt: RawReceipt | null = null;
    for (let i = 0; i <= o.notFoundRetries; i++) {
      if (i > 0) await sleep(o.delayMs);
      tx ??= await call<RawTx | null>(client, "eth_getTransactionByHash", [hash], o);
      if (tx) receipt = await call<RawReceipt | null>(client, "eth_getTransactionReceipt", [hash], o);
      if (tx && receipt) break;
    }
    if (!tx || !receipt) return { kind: "missing" };
    const selector = tx.input.length >= 10 ? tx.input.slice(0, 10) : tx.input;
    const fn = FUNCTIONS.get(selector);
    let args: Record<string, string> | undefined;
    if (fn) {
      try {
        const d = decodeFunctionData({ abi: [fn], data: tx.input });
        args = named(fn.name, fn.inputs, (d.args ?? []) as readonly unknown[]);
      } catch {
        args = undefined;
      }
    }
    const facts: Facts = {
      chain,
      hash,
      status: receipt.status === "0x1" ? "success" : "reverted",
      block: Number(receipt.blockNumber),
      index: Number(receipt.transactionIndex),
      from: tx.from,
      to: tx.to,
      input: tx.input,
      selector,
      method: fn?.name,
      args,
      value: BigInt(tx.value),
      gasUsed: Number(receipt.gasUsed),
      gasPrice: BigInt(receipt.effectiveGasPrice ?? "0x0"),
      contractAddress: receipt.contractAddress,
      events: decodeEvents(receipt.logs),
    };
    return { kind: "found", facts };
  } catch (e) {
    if (e instanceof RpcUnavailable) return { kind: "rpc", error: e.message };
    throw e;
  }
}

const isHex = (s: string) => /^0x[0-9a-fA-F]*$/.test(s);
const same = (a: string, b: string) => (isHex(a) && isHex(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Every way the chain differs from what was recorded; empty when it matches. */
export function checkFacts(f: Facts, e: Expect = {}): string[] {
  const bad: string[] = [];
  const status = e.status ?? "success";
  if (f.status !== status) bad.push(f.status === "reverted" ? "reverted" : "succeeded, expected to revert");
  if (e.block !== undefined && f.block !== e.block) bad.push(`block ${f.block}, expected ${e.block}`);
  if (e.index !== undefined && f.index !== e.index) bad.push(`position ${f.index}, expected ${e.index}`);
  if (e.from !== undefined && !same(f.from, e.from)) bad.push(`sent by ${f.from}, expected ${e.from}`);
  if (e.to === null && f.to !== null) bad.push(`to ${f.to}, expected a contract creation`);
  if (e.to && (!f.to || !same(f.to, e.to))) bad.push(`to ${f.to ?? "a contract creation"}, expected ${e.to}`);
  if (e.method !== undefined) {
    const actual = f.method ?? f.selector;
    const okMethod = e.method.startsWith("0x") ? same(f.selector, e.method) : f.method === e.method;
    if (!okMethod) bad.push(`calls ${actual}, expected ${e.method}`);
  }
  for (const [k, v] of Object.entries(e.args ?? {})) {
    if (!f.args) bad.push(`could not decode the call to check ${k}`);
    else if (!same(f.args[k] ?? "", norm(v))) bad.push(`${k}=${f.args[k]}, expected ${norm(v)}`);
  }
  if (e.input !== undefined && !same(f.input, e.input)) bad.push(`input differs from the recorded ${e.input.slice(0, 18)}…`);
  if (e.value !== undefined && f.value !== BigInt(e.value)) bad.push(`value ${f.value}, expected ${e.value}`);
  if (e.gasUsed !== undefined && f.gasUsed !== e.gasUsed) bad.push(`gas ${f.gasUsed}, expected ${e.gasUsed}`);
  if (e.contractAddress !== undefined && !same(f.contractAddress ?? "", e.contractAddress))
    bad.push(`created ${f.contractAddress ?? "nothing"}, expected ${e.contractAddress}`);
  const left = [...f.events];
  for (const ev of e.events ?? []) {
    const i = left.findIndex((x) => x.name === ev.name && Object.entries(ev.args ?? {}).every(([k, v]) => same(x.args[k] ?? "", v)));
    if (i < 0) {
      const args = Object.entries(ev.args ?? {}).map(([k, v]) => `${k}=${v}`);
      bad.push(`no ${ev.name}${args.length ? ` with ${args.join(", ")}` : ""}`);
    } else left.splice(i, 1);
  }
  for (const name of e.noEvents ?? []) if (f.events.some((x) => x.name === name)) bad.push(`emits ${name}`);
  return bad;
}

/** An answer key counts as pre-registered only when its anchor landed before every review request of its run. */
export function checkPreRegistration(anchorBlock: number, requestBlocks: number[]): string | undefined {
  const early = requestBlocks.filter((b) => b <= anchorBlock);
  if (!requestBlocks.length) return "no review requests to compare with";
  return early.length ? `${early.length} review request(s) at or before the anchor's block ${anchorBlock} (first at ${Math.min(...early)})` : undefined;
}

/** A same-block copy: in the move's block, after it, sent by the hub (the Reactivity subscription's owner). */
export function checkPair(move: Facts, copy: Facts, hub: string): string[] {
  const bad: string[] = [];
  if (copy.block !== move.block) bad.push(`copy in block ${copy.block}, move in block ${move.block}`);
  else if (copy.index <= move.index) bad.push(`copy at position ${copy.index} is not after the move at ${move.index}`);
  if (!same(copy.from, hub)) bad.push(`copy sent by ${copy.from}, not the hub ${hub}`);
  return bad;
}

export async function verifyTx(client: RpcClient, spec: TxSpec, opts: VerifyOptions = {}): Promise<Verification> {
  const key = `${spec.chain}:${spec.hash.toLowerCase()}`;
  let pending = opts.cache?.get(key);
  if (!pending) {
    pending = fetchFacts(client, spec.chain, spec.hash, opts);
    opts.cache?.set(key, pending);
  }
  const got = await pending;
  if (got.kind === "rpc") return { ok: false, outcome: "unverified", reason: `RPC: ${got.error}` };
  if (got.kind === "missing") return { ok: false, outcome: "failed", reason: `not found on ${spec.chain} (chain ${CHAINS[spec.chain].id})` };
  const f = got.facts;
  const bad = checkFacts(f, spec.expect);
  return {
    ok: bad.length === 0,
    outcome: bad.length === 0 ? "verified" : "failed",
    status: f.status,
    block: f.block,
    index: f.index,
    reason: bad.length ? bad.join("; ") : undefined,
    facts: f,
  };
}

// ---------------------------------------------------------------- the ledger's rows

export type Section =
  | "contracts"
  | "same-block"
  | "refusals"
  | "theses"
  | "lifecycle"
  | "guard"
  | "anchors"
  | "reviews"
  | "mcp"
  | "landing"
  | "other";

export interface LedgerRow extends TxSpec {
  id: string;
  section: Section;
  run?: string;
  pair?: string;
  role?: "move" | "copy";
  /** A step that sets up the rows around it. */
  context?: boolean;
  /** Groups rows inside a section (the AI guard's "gate" and "block" tables). */
  subsection?: string;
  /** Other sections that show this row (or its pair) too. */
  alsoIn?: Section[];
  /** Where this transaction is cited. */
  source?: string;
  review?: number;
  /** For an answer-key anchor: the reviews of its run, which must all be requested after it. */
  runNonces?: number[];
}
export interface CheckedRow extends LedgerRow {
  result: Verification;
  /** What the ledger found beyond the row's own checks. */
  note?: string;
}

export interface SourceContract {
  id: string;
  name: string;
  chain: ChainName;
  address: string;
  deployTx?: Hex;
  /** "<file> <dotted.key>" holding the same address. */
  deployment?: string;
  /** The row whose GroupOpened event names this relay. */
  openedIn?: string;
  source?: string;
  readBack?: boolean;
  expect?: Expect;
}
export interface Sources {
  about: string;
  runs: Record<string, string>;
  markets: Record<string, { symbol: string; decimals: number }>;
  contracts: SourceContract[];
  gas: { label: string; row: string; gasUsed: number; tank?: string }[];
  guard: { exampleNonce: number };
  rows: LedgerRow[];
}

type Review = {
  trader: string;
  nonce: number;
  requestTx: Hex;
  deliveryToShannon: Hex;
  deliveryToHideki: Hex;
  shannonEvents: { event: string; tx: Hex; args: Record<string, unknown> }[];
  gateEvents: { event: string; args: Record<string, unknown> }[];
};

const ZERO = "0x0000000000000000000000000000000000000000";
const recordedArgs = (event: string, args: Record<string, unknown>, keep: string[]) => {
  const out: Record<string, string> = {};
  for (const k of keep) {
    if (args[k] === undefined) continue;
    const names = ENUMS[event]?.[k];
    out[k] = names && typeof args[k] === "number" ? names[args[k] as number] : norm(args[k]);
  }
  return out;
};

/** The five transactions of each review in deployments/risk.json, with the events recorded for them. */
export function reviewRows(reviews: Review[], gate: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const r of reviews) {
    const base = { section: "reviews" as const, run: "risk", review: r.nonce };
    rows.push({
      ...base,
      id: `review-${r.nonce}-request`,
      chain: "hideki",
      hash: r.requestTx,
      label: `review ${r.nonce}: requested on Hideki`,
      expect: { to: gate, method: "requestReview", args: { trader: r.trader }, events: [{ name: "ReviewRequested", args: { trader: r.trader, nonce: String(r.nonce) } }] },
    });
    const byTx = new Map<string, Review["shannonEvents"]>();
    for (const e of r.shannonEvents) byTx.set(e.tx.toLowerCase(), [...(byTx.get(e.tx.toLowerCase()) ?? []), e]);
    for (const [tx, evs] of byTx) {
      const first = evs[0].event;
      const step = first === "ReviewReceived" ? "toShannon" : first === "SummaryReceived" ? "summary" : first === "VerdictTallied" ? "verdict" : first;
      const label =
        step === "toShannon" ? "delivered to the reviewer on Shannon" : step === "summary" ? "the data committee's answer" : step === "verdict" ? "the verdict committee's answer" : first;
      rows.push({
        ...base,
        id: `review-${r.nonce}-${step}`,
        chain: "shannon",
        hash: tx as Hex,
        label: `review ${r.nonce}: ${label}`,
        expect: {
          events: evs.map((e) => ({
            name: e.event,
            args: recordedArgs(e.event, e.args, ["trader", "nonce", "requestId", "summaryHash", "tier", "ok", "caution", "blocked", "responded"]),
          })),
        },
      });
    }
    rows.push({
      ...base,
      id: `review-${r.nonce}-toHideki`,
      chain: "hideki",
      hash: r.deliveryToHideki,
      label: `review ${r.nonce}: verdict delivered to the gate on Hideki`,
      expect: { events: r.gateEvents.map((e) => ({ name: e.event, args: recordedArgs(e.event, e.args, ["trader", "tier", "newTier", "nonce"]) })) },
    });
  }
  return rows;
}

/** The landing's proof (app/content/proof.ts): each object's block and the tx(hash, index) pairs inside it. */
export function landingRows(source: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const chunk of source.split(/\nexport const /).slice(1)) {
    const name = chunk.slice(0, chunk.search(/[\s=:]/));
    const block = /\bblock:\s*(\d+)/.exec(chunk);
    for (const m of chunk.matchAll(/(\w+):\s*tx\("(0x[0-9a-fA-F]{64})",\s*(\d+)\)/g))
      rows.push({
        id: `landing-${name}-${m[1]}`,
        section: "landing",
        chain: "hideki",
        hash: m[2] as Hex,
        label: `${name}.${m[1]}`,
        source: "app/content/proof.ts",
        expect: { index: Number(m[3]), ...(block ? { block: Number(block[1]) } : {}) },
      });
    const verdict = /verdictTx:\s*"(0x[0-9a-fA-F]{64})"/.exec(chunk);
    if (verdict) {
      const trader = /trader:\s*"(0x[0-9a-fA-F]{40})"/.exec(chunk)?.[1];
      const tier = /verdict:\s*"(\w+)"/.exec(chunk)?.[1];
      const votes = /votes:\s*(\d+)/.exec(chunk)?.[1];
      const answered = /answered:\s*(\d+)/.exec(chunk)?.[1];
      const tierName = tier ? tier[0] + tier.slice(1).toLowerCase() : undefined;
      const field = tierName === "Ok" ? "ok" : tierName === "Caution" ? "caution" : "blocked";
      const args: Record<string, string> = {};
      if (trader) args.trader = trader;
      if (tierName) args.tier = tierName;
      if (votes) args[field] = votes;
      if (answered) args.responded = answered;
      rows.push({ id: `landing-${name}-verdictTx`, section: "landing", chain: "shannon", hash: verdict[1] as Hex, label: `${name}.verdictTx`, source: "app/content/proof.ts", expect: { events: [{ name: "VerdictTallied", args }] } });
    }
    const delivery = /deliveryTx:\s*"(0x[0-9a-fA-F]{64})"/.exec(chunk);
    if (delivery) {
      const trader = /trader:\s*"(0x[0-9a-fA-F]{40})"/.exec(chunk)?.[1];
      rows.push({ id: `landing-${name}-deliveryTx`, section: "landing", chain: "hideki", hash: delivery[1] as Hex, label: `${name}.deliveryTx`, source: "app/content/proof.ts", expect: { events: [{ name: "VerdictReceived", args: trader ? { trader } : {} }] } });
    }
  }
  return rows;
}

/** Explorer transaction links in a document: the chain comes from the explorer the link points at. */
export function linkedTxs(text: string): { chain: ChainName; hash: Hex }[] {
  const out: { chain: ChainName; hash: Hex }[] = [];
  for (const chain of Object.keys(CHAINS) as ChainName[]) {
    const prefix = CHAINS[chain].explorerTx.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    for (const m of text.matchAll(new RegExp(`${prefix}(0x[0-9a-fA-F]{64})`, "g"))) out.push({ chain, hash: m[1] as Hex });
  }
  return out;
}

/** Public documents whose transaction links the ledger checks (docs/PROOF.md is the output, not a source). */
function citingFiles(): string[] {
  const files: string[] = [];
  const add = (rel: string) => existsSync(resolve(ROOT, rel)) && files.push(rel);
  const walk = (rel: string, ext: RegExp) => {
    const dir = resolve(ROOT, rel);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = `${rel}/${name}`;
      if (statSync(resolve(ROOT, p)).isDirectory()) walk(p, ext);
      else if (ext.test(name) && p !== "docs/PROOF.md") files.push(p);
    }
  };
  for (const f of ["README.md", "JUDGES.md", "e2e/README.md", "packages/sdk/README.md", "packages/mcp/README.md", "packages/stats/README.md"]) add(f);
  walk("docs", /\.md$/);
  walk("eval", /\.(md|json)$/);
  walk("deployments", /\.json$/);
  return files;
}

export function buildRows(sources: Sources): LedgerRow[] {
  const rows: LedgerRow[] = [...sources.rows];
  for (const c of sources.contracts)
    if (c.deployTx)
      rows.push({ id: `deploy-${c.id}`, section: "contracts", chain: c.chain, hash: c.deployTx, label: `deploy ${c.name}`, run: "deploy", expect: c.expect });
  for (const [key, t] of Object.entries(hidekiDeployment.txs as Record<string, { hash: Hex; block: number; gasUsed: number }>))
    rows.push({ id: `hideki-json-${key}`, section: "other", chain: "hideki", hash: t.hash, label: `deployments/hideki.json: ${key}`, source: "deployments/hideki.json", expect: { block: t.block, gasUsed: t.gasUsed } });
  (riskDeployment.txs as { chain: ChainName; step: string; label: string; hash: Hex; block: number; gasUsed: number; status: string; from: string; to: string; contractAddress?: string }[]).forEach((t, i) =>
    rows.push({
      id: `risk-json-${i}`,
      section: "other",
      chain: t.chain,
      hash: t.hash,
      label: t.label,
      source: "deployments/risk.json",
      expect: {
        block: t.block,
        gasUsed: t.gasUsed,
        status: t.status === "success" ? "success" : "reverted",
        from: t.from,
        to: t.to === ZERO ? null : t.to,
        ...(t.contractAddress ? { contractAddress: t.contractAddress } : {}),
      },
    }),
  );
  rows.push(...reviewRows(riskDeployment.reviews as Review[], riskDeployment.hideki.gate));
  for (const rel of ["eval/anchor.json", "eval/v3/anchor.json"]) {
    if (!existsSync(resolve(ROOT, rel))) continue;
    const a = readJson<{ run: string; commit: string; data: Hex; tx: Hex; block: number; from: string; status: string; gasUsed: number }>(rel);
    const results = rel.replace(/anchor\.json$/, "results.json");
    const runNonces = existsSync(resolve(ROOT, results)) ? readJson<{ rows: { nonce?: number }[] }>(results).rows.flatMap((r) => (r.nonce ? [r.nonce] : [])) : [];
    rows.push({
      runNonces,
      id: `anchor-${a.run}`,
      section: "anchors",
      run: "risk",
      chain: "hideki",
      hash: a.tx,
      label: `run ${a.run}: the answer key's commit (${a.commit.slice(0, 7)}) and the key file's keccak256, written on chain`,
      source: rel,
      expect: { block: a.block, from: a.from, to: a.from, input: a.data, gasUsed: a.gasUsed, status: a.status === "success" ? "success" : "reverted" },
    });
  }
  const landing = resolve(ROOT, "app/content/proof.ts");
  if (existsSync(landing)) rows.push(...landingRows(readFileSync(landing, "utf8")));
  const known = new Set(rows.map((r) => `${r.chain}:${r.hash.toLowerCase()}`));
  for (const rel of citingFiles())
    for (const { chain, hash } of linkedTxs(readFileSync(resolve(ROOT, rel), "utf8"))) {
      const key = `${chain}:${hash.toLowerCase()}`;
      if (known.has(key)) continue;
      known.add(key);
      rows.push({ id: `cited-${chain}-${hash.slice(2, 10)}`, section: "other", chain, hash, label: `linked from ${rel}`, source: rel, expect: {} });
    }
  return rows;
}

// ---------------------------------------------------------------- the claims map

/** GitHub's heading anchor: lower case, punctuation dropped, each space a hyphen; repeats get -1, -2, … */
export function headingAnchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  const prose = md.replace(/^```[\s\S]*?^```/gm, "");
  for (const m of prose.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of md.matchAll(/<a id="([^"]+)"><\/a>/g)) out.add(m[1]);
  return out;
}

/** The titles of a TypeScript test file's it(…), test(…) and describe(…) calls, unescaped. */
function testTitles(text: string): string[] {
  return [...text.matchAll(/(?:it|test|describe)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2].replace(/\\(.)/g, "$1"));
}

/**
 * Every link from docs/CLAIMS.md into PROOF.md or the scorecard must land on an anchor, every `file::test` it cites
 * must name a test in that file, and every repo path it names must exist. `read` returns a repo file or undefined.
 */
export function checkClaims(claims: string, read: (rel: string) => string | undefined): string[] {
  const bad: string[] = [];
  const anchorsOf = new Map<string, Set<string>>();
  const anchors = (rel: string) => {
    if (!anchorsOf.has(rel)) {
      const text = read(rel);
      anchorsOf.set(rel, text === undefined ? new Set() : headingAnchors(text));
    }
    return anchorsOf.get(rel)!;
  };
  for (const m of claims.matchAll(/\]\(([^)#\s:]+)\)/g)) {
    const rel = m[1].startsWith("../") ? m[1].slice(3) : `docs/${m[1]}`;
    if (read(rel) === undefined) bad.push(`links to ${m[1]}, which does not exist`);
  }
  for (const m of claims.matchAll(/\]\(([^)#\s:]+)#([^)\s]+)\)/g)) {
    const rel = m[1].startsWith("../") ? m[1].slice(3) : `docs/${m[1]}`;
    if (read(rel) === undefined) bad.push(`links to ${m[1]}, which does not exist`);
    else if (!anchors(rel).has(m[2])) bad.push(`links to ${m[1]}#${m[2]}, which has no such anchor`);
  }
  let file: string | undefined;
  for (const m of claims.matchAll(/`([^`]+)`/g)) {
    const token = m[1];
    const ref = /^((?:app|packages|contracts|eval|e2e|deployments|docs)\/[\w./-]+\.[a-z]+)?(?:::(.+))?$/.exec(token);
    if (!ref || (!ref[1] && !ref[2])) continue;
    if (ref[1]) file = ref[1];
    const text = file ? read(file) : undefined;
    if (ref[1] && text === undefined) {
      bad.push(`names ${ref[1]}, which does not exist`);
      continue;
    }
    if (!ref[2]) continue;
    if (!file || text === undefined) {
      bad.push(`cites ::${ref[2]} with no file before it`);
      continue;
    }
    const name = ref[2];
    const found = file.endsWith(".sol") ? text.includes(`function ${name}(`) : testTitles(text).includes(name);
    if (!found) bad.push(`cites ${file}::${name}, which is not a test there`);
  }
  return bad;
}

// ---------------------------------------------------------------- the run

export interface PairResult {
  id: string;
  section: Section;
  move: CheckedRow;
  copy: CheckedRow;
  outcome: Outcome;
  reasons: string[];
}
export interface ContractResult extends SourceContract {
  outcome: Outcome;
  reasons: string[];
  code?: boolean;
  deploy?: CheckedRow;
  readBack?: boolean;
  readBackNote?: string;
}
export interface ReviewResult {
  nonce: number;
  trader: string;
  rows: CheckedRow[];
  outcome: Outcome;
  committee?: Record<string, string>;
  gate?: DecodedEvent;
}
export interface GasResult {
  label: string;
  row?: CheckedRow;
  recorded: number;
  outcome: Outcome;
  reason?: string;
  /** Every TankCharged in the transaction, for a handler run that serves several followers. */
  tankCharges?: { follower: string; amount: string }[];
}

const worst = (outcomes: Outcome[]): Outcome =>
  outcomes.includes("failed") ? "failed" : outcomes.includes("unverified") ? "unverified" : "verified";

/** At most `n` reads in flight per chain. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function lookup(path: string): unknown {
  const [file, key] = path.split(" ");
  let v: unknown = readJson(file);
  for (const k of key.split(".")) v = (v as Record<string, unknown>)?.[k];
  return v;
}

async function readBack(address: string): Promise<{ verified?: boolean; note: string }> {
  try {
    const res = await fetch(`${shannonExplorer}/api/v2/smart-contracts/${address}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { note: `explorer answered ${res.status}` };
    const body = (await res.json()) as { is_verified?: boolean; is_fully_verified?: boolean; compiler_version?: string };
    const verified = Boolean(body.is_fully_verified ?? body.is_verified);
    return { verified, note: verified ? `read back from the explorer: verified${body.compiler_version ? `, ${body.compiler_version}` : ""}` : "the explorer says it is not verified" };
  } catch (e) {
    return { note: `explorer read-back unavailable (${errText(e)})` };
  }
}

async function main() {
  const sources = readJson<Sources>("e2e/proof/sources.json");
  const clients: Record<ChainName, RpcClient> = { hideki: httpRpc(CHAINS.hideki.rpc), shannon: httpRpc(CHAINS.shannon.rpc) };
  const o = { attempts: 5, delayMs: 1500 };
  const heads = {} as Record<ChainName, number>;
  for (const chain of Object.keys(CHAINS) as ChainName[]) {
    const id = Number(await call<Hex>(clients[chain], "eth_chainId", [], o));
    if (id !== CHAINS[chain].id) throw new Error(`${CHAINS[chain].rpc} is chain ${id}, not ${chain} (${CHAINS[chain].id})`);
    heads[chain] = Number(await call<Hex>(clients[chain], "eth_blockNumber", [], o));
  }
  const generatedAt = new Date().toISOString();
  console.log(`proof ledger at Hideki block ${heads.hideki}, Shannon block ${heads.shannon} (${generatedAt})`);

  const rows = buildRows(sources);
  const cache = new Map<string, Promise<Fetched>>();
  const limit = { hideki: limiter(6), shannon: limiter(6) };
  const opts: VerifyOptions = { cache };
  const checked: CheckedRow[] = await Promise.all(
    rows.map(async (row) => ({ ...row, result: await limit[row.chain](() => verifyTx(clients[row.chain], row, opts)) })),
  );
  // a transaction missing from the chain named: say so when it is on the other one
  for (const row of checked)
    if (row.result.outcome === "failed" && row.result.reason?.startsWith("not found")) {
      const other: ChainName = row.chain === "hideki" ? "shannon" : "hideki";
      const there = await fetchFacts(clients[other], other, row.hash, { attempts: 3, notFoundRetries: 0 });
      if (there.kind === "found") row.result.reason += `; it is on ${other} (chain ${CHAINS[other].id}): wrong network`;
    }
  const byId = new Map(checked.map((r) => [r.id, r]));

  // pre-registration: each answer key's anchor lands before every review request of its run
  for (const anchorRow of checked.filter((r) => r.section === "anchors" && r.runNonces?.length)) {
    const requests = anchorRow.runNonces!.map((n) => byId.get(`review-${n}-request`));
    const blocks = requests.map((r) => r?.result.facts?.block);
    const at = anchorRow.result.facts?.block;
    if (at === undefined || blocks.some((b) => b === undefined)) continue; // the rows themselves report why
    const first = Math.min(...(blocks as number[]));
    const late = checkPreRegistration(at, blocks as number[]);
    if (late) {
      anchorRow.result = { ...anchorRow.result, ok: false, outcome: "failed", reason: late };
    } else {
      anchorRow.note = `before all ${blocks.length} review requests of the run (reviews ${Math.min(...anchorRow.runNonces!)}–${Math.max(...anchorRow.runNonces!)}, the first at block ${first.toLocaleString("en-US")})`;
    }
  }

  const pairs: PairResult[] = [];
  for (const id of [...new Set(checked.filter((r) => r.pair).map((r) => r.pair!))]) {
    const move = checked.find((r) => r.pair === id && r.role === "move");
    const copy = checked.find((r) => r.pair === id && r.role === "copy");
    if (!move || !copy) throw new Error(`pair ${id} needs a move and a copy`);
    const reasons = move.result.facts && copy.result.facts ? checkPair(move.result.facts, copy.result.facts, HUB) : [];
    const outcome = reasons.length ? "failed" : worst([move.result.outcome, copy.result.outcome]);
    pairs.push({ id, section: move.section, move, copy, outcome, reasons });
  }

  const contracts: ContractResult[] = [];
  for (const c of sources.contracts) {
    const reasons: string[] = [];
    const outcomes: Outcome[] = [];
    if (c.deployment) {
      const v = lookup(c.deployment);
      if (typeof v !== "string" || !same(v, c.address)) reasons.push(`${c.deployment} holds ${String(v)}, not ${c.address}`);
    }
    let code: boolean | undefined;
    try {
      code = (await call<Hex>(clients[c.chain], "eth_getCode", [c.address, "latest"], o)) !== "0x";
      if (!code) reasons.push("no code at the address");
    } catch (e) {
      outcomes.push("unverified");
      reasons.push(`RPC: ${errText(e)}`);
    }
    const deploy = c.deployTx ? byId.get(`deploy-${c.id}`) : undefined;
    if (deploy) {
      outcomes.push(deploy.result.outcome);
      const f = deploy.result.facts;
      if (f) {
        let created = f.contractAddress;
        if (!created && f.to && same(f.to, CREATE2_DEPLOYER))
          created = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: slice(f.input, 0, 32), bytecode: slice(f.input, 32) });
        if (!created || !same(created, c.address)) reasons.push(`the deploy transaction created ${created ?? "nothing"}`);
      }
    }
    if (c.openedIn) {
      const opener = byId.get(c.openedIn);
      outcomes.push(opener?.result.outcome ?? "failed");
      if (opener?.result.facts && !opener.result.facts.events.some((e) => e.name === "GroupOpened" && same(e.args.relay ?? "", c.address)))
        reasons.push(`${c.openedIn} has no GroupOpened naming this relay`);
    }
    let rb: { verified?: boolean; note: string } | undefined;
    if (c.readBack) {
      rb = await readBack(c.address);
      if (rb.verified === false) reasons.push(rb.note);
    }
    const hard = reasons.filter((r) => !r.startsWith("RPC:"));
    contracts.push({ ...c, outcome: hard.length ? "failed" : worst(outcomes), reasons, code, deploy, readBack: rb?.verified, readBackNote: rb?.note });
  }

  const reviews: ReviewResult[] = [];
  for (const r of riskDeployment.reviews as Review[]) {
    const rs = checked.filter((x) => x.section === "reviews" && x.review === r.nonce);
    const tally = rs.find((x) => x.id.endsWith("-verdict"))?.result.facts?.events.find((e) => e.name === "VerdictTallied");
    const gate = rs.find((x) => x.id.endsWith("-toHideki"))?.result.facts?.events.find((e) => e.name === "VerdictReceived" || e.name === "BlockHeld");
    reviews.push({ nonce: r.nonce, trader: r.trader, rows: rs, outcome: worst(rs.map((x) => x.result.outcome)), committee: tally?.args, gate });
  }

  const gas: GasResult[] = sources.gas.map((g) => {
    const row = byId.get(g.row);
    if (!row) return { label: g.label, recorded: g.gasUsed, outcome: "failed" as const, reason: `no row ${g.row}` };
    const f = row.result.facts;
    const reason = !f ? row.result.reason : f.gasUsed !== g.gasUsed ? `gas ${f.gasUsed}, recorded ${g.gasUsed}` : undefined;
    const charges = f?.events.filter((e) => e.name === "TankCharged").map((e) => ({ follower: e.args.follower, amount: e.args.amount }));
    const tankReason = g.tank && f && !charges?.some((c) => same(c.follower, g.tank!)) ? `no TankCharged for ${g.tank}` : undefined;
    const why = reason ?? tankReason;
    return { label: g.label, row, recorded: g.gasUsed, outcome: why ? (f ? "failed" : row.result.outcome) : "verified", reason: why, tankCharges: g.tank ? charges : undefined };
  });

  const wallets: Record<string, string> = {};
  for (const w of hidekiDeployment.demoWallets as { address: string; role: string }[]) wallets[w.address.toLowerCase()] = w.role;
  const input: ProofInput = {
    generatedAt,
    heads,
    rows: checked,
    pairs,
    contracts,
    reviews,
    gas,
    context: { runs: sources.runs, markets: sources.markets, wallets, hub: HUB, exampleNonce: sources.guard.exampleNonce },
  };
  const { renderProof } = await import("./proof-render.ts");
  const out = resolve(ROOT, "docs/PROOF.md");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderProof(input));

  const txOutcome = new Map<string, Outcome>();
  for (const r of checked) {
    const key = `${r.chain}:${r.hash.toLowerCase()}`;
    txOutcome.set(key, worst([txOutcome.get(key) ?? "verified", r.result.outcome]));
  }
  const all = [...txOutcome.values(), ...pairs.map((p) => p.outcome), ...contracts.map((c) => c.outcome), ...gas.map((g) => g.outcome)];
  const count = (o: Outcome) => [...txOutcome.values()].filter((x) => x === o).length;
  console.log(`${txOutcome.size} transactions (${checked.length} rows): ${count("verified")} verified, ${count("failed")} failed, ${count("unverified")} unverified`);
  console.log(`${pairs.length} same-block pairs, ${contracts.length} contracts, ${gas.length} gas rows`);
  for (const r of checked) if (r.result.outcome !== "verified") console.log(`  ${r.result.outcome.toUpperCase()} ${r.id} ${r.chain} ${r.hash}: ${r.result.reason}`);
  for (const p of pairs) if (p.reasons.length) console.log(`  FAILED pair ${p.id}: ${p.reasons.join("; ")}`);
  for (const c of contracts) if (c.outcome !== "verified") console.log(`  ${c.outcome.toUpperCase()} contract ${c.id}: ${c.reasons.join("; ")}`);
  for (const g of gas) if (g.outcome !== "verified") console.log(`  ${g.outcome.toUpperCase()} gas ${g.label}: ${g.reason}`);
  console.log(`wrote ${relative(process.cwd(), out)}`);
  const claimsPath = resolve(ROOT, "docs/CLAIMS.md");
  const claimProblems = existsSync(claimsPath)
    ? checkClaims(readFileSync(claimsPath, "utf8"), (rel) => (existsSync(resolve(ROOT, rel)) ? readFileSync(resolve(ROOT, rel), "utf8") : undefined))
    : [];
  for (const p of claimProblems) console.log(`  FAILED docs/CLAIMS.md ${p}`);
  if (existsSync(claimsPath)) console.log(`docs/CLAIMS.md: ${claimProblems.length ? `${claimProblems.length} broken references` : "every link and test it cites exists"}`);
  if (claimProblems.length) all.push("failed");
  process.exitCode = all.includes("failed") ? 1 : all.includes("unverified") ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

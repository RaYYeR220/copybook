// Live wiring and review runs of the risk module: RiskReviewer on Shannon (50312), RiskGate on Hideki (50383), and
// the live hub's gate. Deploy both contracts first with contracts/script/DeployRisk.s.sol (see README).
// COPYBOOK_ENV=<env file> tsx src/risk.ts <step> [args]
//   bridge <stt>        bridges STT from Hideki to Shannon for the hub owner and waits for the delivery
//   record              writes the two DeployRisk broadcasts into deployments/risk.json
//   wire                reviewer.setGate(gate) on Shannon, then the hub's setRiskGate(gate) on Hideki (each only if unset)
//   fund <stt>          sends STT from the hub owner to the reviewer for agent deposits
//   check               both sides' settings; allowIncrease answers true without a verdict; the gate call's gas
//   trade               the leader opens and closes 0.0005 BTC; the follower's copies pass the gate
//   base-url <url>      reviewer.setBaseUrl(url)
//   prompt              reviewer.setSystemPrompt(the published rubric in eval/rubric.ts)
//   review [trader ...] the hub owner pays for reviews (default: the steady and liquidated fixture traders and the
//                       leader) and each is followed across both chains to the verdict
//   guard               the follower's guard against the leader's verdict
// Every transaction goes to deployments/risk.json with its explorer link.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { BridgeToken, ChainId, createBridgeTransfer, sendBridgeStep } from "@somnia-chain/markets-sdk/chains";
import {
  account,
  chain as hideki,
  markets,
  pub,
  shannon,
  shannonPub,
  shannonWallet,
  wallet,
  EXPLORER_TX,
  SHANNON_EXPLORER_TX,
  type Role,
} from "./env.ts";
import { HUB, ROOT, artifact, decodeHub, errMsg, fmtEvent, hubAbi, market, reaction, size, sleep, type HubEvent } from "./lib.ts";
import { SYSTEM_PROMPT } from "../../eval/rubric.ts";

const HIDEKI_MAILBOX = getAddress("0xD7C2E95c62De3c0ad95b2C1cf08E4B85DF6b332D");
const SHANNON_MAILBOX = getAddress("0xF805734aAC42cf238eAef9E905e3A04F2Ab554f9");
const RISK_FILE = resolve(ROOT, "deployments/risk.json");
const OWNER_HIDEKI_FLOOR = parseEther("40");

/** Review targets: the steady and the liquidated trader from packages/stats' fixtures, and the e2e leader. */
const STEADY = getAddress("0xfc2fb08cccf87bfc472cded8e7ebef588fcf7fd2");
const LIQUIDATED = getAddress("0xa14d4561f2697859ab6c2d5eb62e1172a6cc3d14");

const OWNER = account("HUB_OWNER").address;
const LEADER = account("LEADER").address;
const FOLLOWER = account("FOLLOWER").address;

const gateAbi = artifact("RiskGate.sol", "RiskGate");
const reviewerAbi = artifact("RiskReviewer.sol", "RiskReviewer");
const mailboxAbi = parseAbi([
  "event DispatchId(bytes32 indexed messageId)",
  "event ProcessId(bytes32 indexed messageId)",
  "function delivered(bytes32 messageId) view returns (bool)",
]);
const TIERS = ["None", "Ok", "Caution", "Block"] as const;
const FAILURES = ["Unfunded", "AgentUnavailable", "CommitteeFailed", "NoSummary", "NoMajority"] as const;
const REASON_RISK_GATE = 6;

// ---------------------------------------------------------------- chains

type Side = "hideki" | "shannon";
const sides = {
  hideki: { pub, chain: hideki, wallet: (r: Role) => wallet(r), explorer: EXPLORER_TX, mailbox: HIDEKI_MAILBOX },
  shannon: { pub: shannonPub, chain: shannon, wallet: (r: Role) => shannonWallet(r), explorer: SHANNON_EXPLORER_TX, mailbox: SHANNON_MAILBOX },
} as const;
const other = (s: Side): Side => (s === "hideki" ? "shannon" : "hideki");

// ---------------------------------------------------------------- record

type TxEntry = {
  chain: Side;
  step: string;
  label: string;
  hash: Hex;
  block: number;
  gasUsed: number;
  status: string;
  from: string;
  to: string | null;
  url: string;
};
type Rec = {
  shannon: Record<string, unknown>;
  hideki: Record<string, unknown>;
  txs: TxEntry[];
  checks: Record<string, string[]>;
  measurements: Record<string, unknown>;
  reviews: Record<string, unknown>[];
};

const rec: Rec = existsSync(RISK_FILE)
  ? (JSON.parse(readFileSync(RISK_FILE, "utf8")) as Rec)
  : { shannon: {}, hideki: {}, txs: [], checks: {}, measurements: {}, reviews: [] };
const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
function save() {
  writeFileSync(RISK_FILE, JSON.stringify(rec, big, 2) + "\n");
}

let step = "";
let failed = false;
function check(ok: boolean, what: string) {
  const line = `${ok ? "ok" : "FAILED"}: ${what}`;
  (rec.checks[step] ??= []).push(line);
  console.log(`  ${line}`);
  if (!ok) failed = true;
  return ok;
}
function note(key: string, value: unknown) {
  console.log(`  ${key}: ${JSON.stringify(value, big)}`);
}

function track(side: Side, label: string, r: TransactionReceipt): TxEntry {
  const e: TxEntry = {
    chain: side,
    step,
    label,
    hash: r.transactionHash,
    block: Number(r.blockNumber),
    gasUsed: Number(r.gasUsed),
    status: r.status,
    from: getAddress(r.from),
    to: r.to ? getAddress(r.to) : null,
    url: sides[side].explorer + r.transactionHash,
  };
  rec.txs = rec.txs.filter((t) => t.hash !== e.hash);
  rec.txs.push(e);
  save();
  console.log(`  [${side}] ${label}: ${e.hash} block ${e.block} gas ${e.gasUsed} ${e.status}`);
  return e;
}

const reviewerAddr = () => getAddress(rec.shannon.reviewer as string);
const gateAddr = () => getAddress(rec.hideki.gate as string);

// ---------------------------------------------------------------- transactions

async function waitReceipt(side: Side, hash: Hex) {
  return sides[side].pub.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 500, retryCount: 20 });
}

type Write = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

/** Estimates on the node (Somnia gas), sends with headroom, waits, records. Reverts throw. */
async function sendOn(side: Side, role: Role, label: string, w: Write) {
  const { pub: client, chain } = sides[side];
  const signer = sides[side].wallet(role);
  const est = await client.estimateContractGas({ ...w, account: signer.account } as never);
  const hash = await signer.writeContract({ ...w, gas: (est * 3n) / 2n, chain, account: signer.account } as never);
  const r = await waitReceipt(side, hash);
  track(side, label, r);
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

async function sendValueOn(side: Side, role: Role, label: string, to: Address, value: bigint) {
  const { pub: client, chain } = sides[side];
  const signer = sides[side].wallet(role) as ReturnType<typeof wallet>;
  const est = await client.estimateGas({ account: signer.account, to, value });
  const hash = await signer.sendTransaction({ to, value, gas: (est * 3n) / 2n, chain, account: signer.account } as never);
  const r = await waitReceipt(side, hash);
  track(side, label, r);
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

const readGate = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address: gateAddr(), abi: gateAbi, functionName, args } as never) as Promise<T>;
const readReviewer = <T>(functionName: string, args: readonly unknown[] = []) =>
  shannonPub.readContract({ address: reviewerAddr(), abi: reviewerAbi, functionName, args } as never) as Promise<T>;
const readHub = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address: HUB, abi: hubAbi, functionName, args } as never) as Promise<T>;

// ---------------------------------------------------------------- logs and Hyperlane

/** Polls `address`'s logs from `fromBlock` in 1000-block windows (the nodes' limit) until `match` finds one. */
async function findLogs<T>(
  side: Side,
  address: Address,
  fromBlock: bigint,
  match: (logs: { data: Hex; topics: Hex[]; transactionHash: Hex; blockNumber: bigint; logIndex: number }[]) => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const client = sides[side].pub as PublicClient;
  const deadline = Date.now() + timeoutMs;
  let from = fromBlock;
  while (Date.now() < deadline) {
    try {
      const head = await client.getBlockNumber();
      while (from <= head) {
        const to = from + 999n < head ? from + 999n : head;
        const logs = (await client.getLogs({ address, fromBlock: from, toBlock: to })) as never as Parameters<typeof match>[0];
        const hit = match(logs);
        if (hit !== undefined) return hit;
        from = to + 1n;
      }
    } catch (e) {
      console.log(`  (log poll retry: ${errMsg(e)})`);
    }
    await sleep(2_000);
  }
  return undefined;
}

function decode(abi: Abi, log: { data: Hex; topics: Hex[] }) {
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    };
  } catch {
    return undefined;
  }
}

function dispatchedIds(r: TransactionReceipt, side: Side) {
  return r.logs
    .filter((l) => getAddress(l.address) === sides[side].mailbox)
    .map((l) => decode(mailboxAbi, l as never))
    .filter((d) => d?.eventName === "DispatchId")
    .map((d) => d!.args.messageId as Hex);
}

/** Waits for the destination Mailbox to process `messageId`; returns the delivery transaction's receipt. */
async function delivery(dest: Side, messageId: Hex, fromBlock: bigint, label: string, timeoutMs = 300_000) {
  const t0 = Date.now();
  const hash = await findLogs(
    dest,
    sides[dest].mailbox,
    fromBlock,
    (logs) => {
      for (const l of logs) {
        const d = decode(mailboxAbi, l);
        if (d?.eventName === "ProcessId" && d.args.messageId === messageId) return l.transactionHash;
      }
      return undefined;
    },
    timeoutMs,
  );
  if (!hash) {
    check(false, `${label}: message ${messageId} processed on ${dest} within ${timeoutMs / 1000}s`);
    return undefined;
  }
  const r = await sides[dest].pub.getTransactionReceipt({ hash });
  track(dest, label, r);
  const seconds = Math.round((Date.now() - t0) / 1000);
  check(r.status === "success", `${label}: delivered on ${dest} (found after ~${seconds}s of polling)`);
  return r;
}

// ---------------------------------------------------------------- steps

async function bridge(amountStt: string) {
  const amount = parseEther(amountStt);
  const signer = account("HUB_OWNER");
  const before = await shannonPub.getBalance({ address: OWNER });
  const hidekiBefore = await pub.getBalance({ address: OWNER });
  check(hidekiBefore - amount >= OWNER_HIDEKI_FLOOR + parseEther("5"), `owner keeps >= 45 STT on Hideki after the bridge (has ${formatEther(hidekiBefore)})`);
  const plan = createBridgeTransfer({ token: BridgeToken.STT, from: ChainId.hidekiTestnet, to: ChainId.somniaShannon, amount, recipient: OWNER });
  note("bridge plan", { to: plan.bridgeStep.to, value: plan.bridgeStep.value, approve: !!plan.approveStep });
  const destFrom = await shannonPub.getBlockNumber();
  const r = await sendBridgeStep(pub, plan.bridgeStep, { account: signer });
  track("hideki", `bridge ${amountStt} STT to Shannon (transferRemote)`, r);
  const [messageId] = dispatchedIds(r, "hideki");
  note("messageId", messageId);
  const d = messageId ? await delivery("shannon", messageId, destFrom, `bridge delivery on Shannon (${amountStt} STT)`) : undefined;
  const after = await shannonPub.getBalance({ address: OWNER });
  check(after - before === amount, `owner's Shannon balance rose by ${amountStt} (${formatEther(before)} -> ${formatEther(after)})`);
  rec.measurements.bridge = { amount: amountStt, messageId, hidekiTx: r.transactionHash, shannonTx: d?.transactionHash };
}

type Broadcast = {
  transactions: { hash: Hex; contractName: string | null; contractAddress: Address; transactionType: string; function: string | null; arguments: string[] | null }[];
  receipts: { blockNumber: string; gasUsed: string; status: string; transactionHash: Hex }[];
};
function broadcast(chainId: number): Broadcast {
  const path = resolve(ROOT, `contracts/broadcast/DeployRisk.s.sol/${chainId}/run-latest.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}: run script/DeployRisk.s.sol on chain ${chainId}`);
  return JSON.parse(readFileSync(path, "utf8")) as Broadcast;
}

async function recordDeploy() {
  const s = broadcast(50312);
  const reviewerTx = s.transactions.find((t) => t.contractName === "RiskReviewer" && t.transactionType === "CREATE");
  if (!reviewerTx) throw new Error("RiskReviewer not in the Shannon broadcast");
  const h = broadcast(50383);
  const gateTx = h.transactions.find((t) => t.contractName === "RiskGate" && t.transactionType === "CREATE");
  if (!gateTx) throw new Error("RiskGate not in the Hideki broadcast");
  rec.shannon.reviewer = getAddress(reviewerTx.contractAddress);
  rec.hideki.gate = getAddress(gateTx.contractAddress);
  rec.hideki.hub = HUB;
  const [, , , , standIn, baseUrl] = reviewerTx.arguments ?? [];
  rec.shannon.constructorGate = standIn;
  rec.shannon.constructorBaseUrl = baseUrl;
  for (const [side, b] of [["shannon", s], ["hideki", h]] as const) {
    for (const t of b.transactions) {
      const r = await sides[side].pub.getTransactionReceipt({ hash: t.hash });
      const label = t.transactionType === "CREATE" ? `deploy ${t.contractName}` : `${t.contractName}.${t.function ?? "call"}`;
      track(side, label, r);
      check(r.status === "success", `${label} succeeded`);
    }
  }
  await settings();
}

/** Both sides' configuration, read back from chain into the record. */
async function settings() {
  const reviewer = reviewerAddr();
  const gate = gateAddr();
  const [quoteSummary, quoteVerdict] = await readReviewer<readonly [bigint, bigint]>("quote");
  Object.assign(rec.shannon, {
    chainId: 50312,
    reviewer,
    owner: await readReviewer("owner"),
    gate: await readReviewer("gate"),
    mailbox: await readReviewer("MAILBOX"),
    gateDomain: await readReviewer("GATE_DOMAIN"),
    agentPlatform: await readReviewer("PLATFORM"),
    jsonAgentId: (await readReviewer<bigint>("jsonAgentId")).toString(),
    llmAgentId: (await readReviewer<bigint>("llmAgentId")).toString(),
    committee: {
      size: Number(await readReviewer<bigint>("COMMITTEE_SIZE")),
      threshold: Number(await readReviewer<bigint>("COMMITTEE_THRESHOLD")),
      timeoutSeconds: Number(await readReviewer<bigint>("REQUEST_TIMEOUT")),
    },
    depositsPerReview: { summary: formatEther(quoteSummary), verdict: formatEther(quoteVerdict), total: formatEther(quoteSummary + quoteVerdict) },
    baseUrl: await readReviewer("baseUrl"),
    systemPrompt: await readReviewer("systemPrompt"),
    balance: formatEther(await shannonPub.getBalance({ address: reviewer })),
    explorer: `https://shannon-explorer.somnia.network/address/${reviewer}`,
  });
  Object.assign(rec.hideki, {
    chainId: 50383,
    gate,
    owner: await readGate("owner"),
    reviewer: await readGate("reviewer"),
    mailbox: await readGate("MAILBOX"),
    reviewerDomain: await readGate("REVIEWER_DOMAIN"),
    reviewFee: formatEther(await readGate<bigint>("reviewFee")),
    verdictTtlSeconds: Number(await readGate<bigint>("VERDICT_TTL")),
    blockHoldSeconds: Number(await readGate<bigint>("BLOCK_HOLD")),
    reviewCooldownSeconds: Number(await readGate<bigint>("REVIEW_COOLDOWN")),
    pendingTimeoutSeconds: Number(await readGate<bigint>("PENDING_TIMEOUT")),
    hub: HUB,
    hubRiskGate: await readHub("riskGate"),
    riskGateGas: Number((await readHub<readonly bigint[]>("gasParams"))[6]),
    explorer: `https://explorer.testnet.somnia.network/tokyo/address/${gate}`,
  });
  save();
}

async function wire() {
  const reviewer = reviewerAddr();
  const gate = gateAddr();
  if (getAddress(await readReviewer<Address>("gate")) !== gate) {
    await sendOn("shannon", "HUB_OWNER", "reviewer.setGate(gate)", { address: reviewer, abi: reviewerAbi, functionName: "setGate", args: [gate] });
  }
  if (getAddress(await readGate<Address>("reviewer")) !== reviewer) {
    await sendOn("hideki", "HUB_OWNER", "gate.setReviewer(reviewer)", { address: gate, abi: gateAbi, functionName: "setReviewer", args: [reviewer] });
  }
  const current = await readHub<Address>("riskGate");
  if (getAddress(current) !== gate) {
    note("hub riskGate before", current);
    const r = await sendOn("hideki", "HUB_OWNER", "hub.setRiskGate(gate)", { address: HUB, abi: hubAbi, functionName: "setRiskGate", args: [gate] });
    check(decodeHub(r.logs).some((e) => e.eventName === "RiskGateSet"), "RiskGateSet emitted");
  }
  check(getAddress(await readReviewer<Address>("gate")) === gate, `reviewer.gate() = ${gate}`);
  check(getAddress(await readGate<Address>("reviewer")) === reviewer, `gate.reviewer() = ${reviewer}`);
  check(getAddress(await readHub<Address>("riskGate")) === gate, `hub.riskGate() = ${gate}`);
  const g = await readHub<readonly bigint[]>("gasParams");
  check(g[6] === 2_000_000n, `hub riskGateGas stays 2,000,000 (is ${g[6]})`);
  await settings();
}

async function fund(amountStt: string) {
  const reviewer = reviewerAddr();
  const before = await shannonPub.getBalance({ address: reviewer });
  await sendValueOn("shannon", "HUB_OWNER", `fund reviewer ${amountStt} STT`, reviewer, parseEther(amountStt));
  const after = await shannonPub.getBalance({ address: reviewer });
  check(after - before === parseEther(amountStt), `reviewer balance ${formatEther(before)} -> ${formatEther(after)}`);
  const [a, b] = await readReviewer<readonly [bigint, bigint]>("quote");
  note("reviews covered", Number(after / (a + b)));
  await settings();
}

const sourceIdOf = (trader: Address) => keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [0, BigInt(trader)]));

async function checks() {
  await settings();
  const gate = gateAddr();
  check(getAddress(rec.shannon.gate as string) === gate, "reviewer points at the gate");
  check(getAddress(rec.hideki.reviewer as string) === reviewerAddr(), "gate points at the reviewer");
  check(getAddress(rec.hideki.hubRiskGate as string) === gate, "hub consults the gate");
  check(Number(rec.hideki.reviewerDomain) === 50312 && Number(rec.shannon.gateDomain) === 50383, "domains 50312 <-> 50383");
  check(getAddress(rec.hideki.mailbox as string) === HIDEKI_MAILBOX && getAddress(rec.shannon.mailbox as string) === SHANNON_MAILBOX, "each side uses its own Mailbox");
  check(rec.shannon.jsonAgentId === "13174292974160097713" && rec.shannon.llmAgentId === "12847293847561029384", "JSON-API and LLM agent ids");
  check(parseEther(rec.shannon.balance as string) >= parseEther("10"), `reviewer holds >= 10 STT (${rec.shannon.balance})`);
  const ownerHideki = await pub.getBalance({ address: OWNER });
  check(ownerHideki >= OWNER_HIDEKI_FLOOR, `owner keeps >= 40 STT on Hideki (${formatEther(ownerHideki)})`);
  note("owner on Shannon", formatEther(await shannonPub.getBalance({ address: OWNER })));

  // no verdict anywhere yet: every increase is allowed
  const randomTrader = getAddress(keccak256(`0x${Date.now().toString(16).padStart(16, "0")}`).slice(0, 42));
  const randomFollower = getAddress(keccak256(randomTrader).slice(0, 42));
  for (const [what, trader, follower] of [
    ["random trader / random follower", randomTrader, randomFollower],
    ["leader / follower", LEADER, FOLLOWER],
  ] as const) {
    const sid = sourceIdOf(trader);
    const hubSid = await readHub<Hex>("sourceIdOf", [0, BigInt(trader)]);
    check(sid === hubSid && sid === (await readGate<Hex>("sourceIdOf", [trader])), `${what}: gate and hub agree on the source id`);
    const allowed = await readGate<boolean>("allowIncrease", [sid, follower]);
    check(allowed, `${what}: allowIncrease = true with no verdict`);
    // the hub's call: a staticcall from the hub with its riskGateGas budget
    const data = encodeFunctionData({ abi: gateAbi, functionName: "allowIncrease", args: [sid, follower] });
    const est = await pub.estimateGas({ account: HUB, to: gate, data });
    note(`${what}: eth_estimateGas of allowIncrease from the hub`, est);
    const estimates = (rec.measurements.allowIncreaseEstimate ??= {}) as Record<string, string>;
    estimates[what] = est.toString();
  }
  check((await readGate<boolean>("guardOf", [FOLLOWER])) === true, "the follower is guarded by default");
  const v = await readGate<{ tier: number }>("verdictOf", [LEADER]);
  note("leader verdict", { tier: TIERS[Number(v.tier)] });
  save();
}

// ---------------------------------------------------------------- copies through the gate

type CallFrame = { type: string; from: string; to?: string; input: string; gas?: string; gasUsed?: string; output?: string; error?: string; calls?: CallFrame[] };

async function trace(side: Side, hash: Hex): Promise<CallFrame | undefined> {
  try {
    return (await sides[side].pub.request({ method: "debug_traceTransaction" as never, params: [hash, { tracer: "callTracer" }] as never })) as CallFrame;
  } catch (e) {
    note("trace unavailable", errMsg(e));
    return undefined;
  }
}

function frames(f: CallFrame | undefined, pred: (c: CallFrame) => boolean, out: CallFrame[] = []) {
  if (!f) return out;
  if (pred(f)) out.push(f);
  for (const c of f.calls ?? []) frames(c, pred, out);
  return out;
}

/** The hub's staticcalls to the gate inside a handler run: gas offered, gas used, answer. */
async function gateCalls(hash: Hex) {
  const gate = gateAddr().toLowerCase();
  const t = await trace("hideki", hash);
  return frames(t, (c) => c.to?.toLowerCase() === gate).map((c) => ({
    type: c.type,
    from: c.from,
    gasOffered: c.gas ? Number(BigInt(c.gas)) : undefined,
    gasUsed: c.gasUsed ? Number(BigInt(c.gasUsed)) : undefined,
    output: c.output,
    error: c.error,
  }));
}

let btcPool: Address | undefined;
async function btc() {
  if (btcPool) return btcPool;
  const perps = (await markets().client.listPerpMarkets()) as { baseSymbol: string; poolAddress: Address }[];
  return (btcPool = getAddress(perps.find((p) => p.baseSymbol === "BTC")!.poolAddress));
}

/** The leader's own IOC 1% through mark. */
async function leaderTrade(label: string, isBid: boolean, qty: bigint) {
  const pool = await btc();
  const m = await market(pool);
  const raw = isBid ? (m.mark * 10_100n) / 10_000n : (m.mark * 9_900n) / 10_000n;
  const price = isBid ? ((raw + m.tick - 1n) / m.tick) * m.tick : (raw / m.tick) * m.tick;
  const r = (await markets("LEADER").trader.placePerpOrder({ pool, isBid, price, quantity: qty, orderType: 2, gas: 20_000_000n })) as {
    hash: Hex;
    receipt?: TransactionReceipt;
  };
  const rc = r.receipt ?? (await pub.waitForTransactionReceipt({ hash: r.hash }));
  track("hideki", label, rc);
  if (rc.status !== "success") throw new Error(`${label} reverted`);
  return rc;
}

/** The hub's handler run for the follower after `trigger`, with its events and the gate calls inside it. */
async function followerRun(label: string, trigger: TransactionReceipt, want: (evs: HubEvent[]) => boolean) {
  const rx = await reaction(trigger, FOLLOWER, want, 120_000);
  if (!check(!!rx, `${label}: the hub reacted for the follower`)) return undefined;
  track("hideki", `${label} (hub handler)`, rx!.receipt);
  const logs = rx!.events.map(fmtEvent);
  for (const l of logs) console.log(`    ${l}`);
  const delta = Number(rx!.receipt.blockNumber - trigger.blockNumber);
  check(delta === 0, `${label}: handler in the trigger's block (delta ${delta})`);
  const calls = await gateCalls(rx!.tx.hash);
  note(`${label}: gate calls`, calls);
  return { ...rx!, logs, calls, delta };
}

const copiedTo = (to: bigint) => (evs: HubEvent[]) => evs.some((e) => e.eventName === "Copied" && e.args.toSize === to);
const riskRefusal = (evs: HubEvent[]) => evs.some((e) => e.eventName === "Refused" && Number(e.args.reason) === REASON_RISK_GATE);

async function trade() {
  const pool = await btc();
  check((await size(FOLLOWER, pool)) === 0n && (await size(LEADER, pool)) === 0n, "leader and follower flat on BTC");
  const open = await leaderTrade("leader buys 0.0005 BTC (gated increase)", true, 50_000n);
  const o = await followerRun("open through the gate", open, (evs) => copiedTo(50_000n)(evs) || evs.some((e) => e.eventName === "Refused"));
  if (o) {
    check(!riskRefusal(o.events), "no Refused(RiskGate)");
    check(copiedTo(50_000n)(o.events), "Copied 0 -> 50000");
    check(o.calls.length === 1 && o.calls[0].type === "STATICCALL", "the hub asked the gate once, by staticcall");
  }
  check((await size(FOLLOWER, pool)) === 50_000n, "follower long 0.0005 BTC");
  const close = await leaderTrade("leader sells 0.0005 BTC (exit)", false, 50_000n);
  const c = await followerRun("close (exit, never gated)", close, copiedTo(0n));
  if (c) check(c.calls.length === 0, "the exit did not ask the gate");
  check((await size(FOLLOWER, pool)) === 0n, "follower flat");
  rec.measurements.gatedCopy = {
    open: o && { handler: o.tx.hash, handlerGas: Number(o.receipt.gasUsed), gateCalls: o.calls, logs: o.logs },
    close: c && { handler: c.tx.hash, handlerGas: Number(c.receipt.gasUsed), gateCalls: c.calls, logs: c.logs },
    withoutGate: "the same trades on this hub before the gate was set: open 1.89-2.10M, close 1.79-1.87M handler gas",
  };
  save();
}

// ---------------------------------------------------------------- reviews

/** reviewer.setSystemPrompt with the published rubric (eval/rubric.ts), only when it differs. */
async function setPrompt() {
  const before = await readReviewer<string>("systemPrompt");
  if (before === SYSTEM_PROMPT) {
    note("system prompt", "already the rubric");
  } else {
    rec.shannon.previousSystemPrompt = before;
    await sendOn("shannon", "HUB_OWNER", "reviewer.setSystemPrompt(rubric)", { address: reviewerAddr(), abi: reviewerAbi, functionName: "setSystemPrompt", args: [SYSTEM_PROMPT] });
  }
  check((await readReviewer<string>("systemPrompt")) === SYSTEM_PROMPT, "the reviewer's system prompt is the published rubric");
  await settings();
}

async function setBaseUrl(url: string) {
  if (!url.endsWith("/")) throw new Error("the base URL must end in /: the trader address is appended");
  await sendOn("shannon", "HUB_OWNER", `reviewer.setBaseUrl(${url})`, { address: reviewerAddr(), abi: reviewerAbi, functionName: "setBaseUrl", args: [url] });
  check((await readReviewer<string>("baseUrl")) === url, `baseUrl = ${url}`);
  await settings();
}

/** Validator answers carried by the platform's callback into the reviewer, read from the callback's trace. */
async function committee(hash: Hex) {
  const reviewer = reviewerAddr().toLowerCase();
  const t = await trace("shannon", hash);
  const out: Record<string, unknown>[] = [];
  for (const f of frames(t, (c) => c.to?.toLowerCase() === reviewer)) {
    try {
      const d = decodeFunctionData({ abi: reviewerAbi, data: f.input as Hex });
      if (d.functionName !== "handleSummary" && d.functionName !== "handleVerdict") continue;
      const [requestId, responses, status] = d.args as unknown as [bigint, { validator: Address; result: Hex; status: number; receipt: bigint; executionCost: bigint }[], number];
      out.push({
        callback: d.functionName,
        requestId: requestId.toString(),
        status,
        responses: responses.map((r) => ({
          validator: r.validator,
          status: r.status,
          receipt: r.receipt.toString(),
          executionCost: r.executionCost.toString(),
          result: text(r.result),
        })),
      });
    } catch {
      /* not a callback */
    }
  }
  return out;
}
/** An agent result as text when it is an ABI string, else the raw bytes. */
function text(result: Hex): string {
  try {
    return (decodeAbiParameters([{ type: "string" }], result) as readonly [string])[0];
  } catch {
    return result;
  }
}

async function review(traders: Address[]) {
  const fee = await readGate<bigint>("reviewFee");
  for (const trader of traders) {
    console.log(`\n  -- review of ${trader}`);
    const entry: Record<string, unknown> = { trader, at: new Date().toISOString(), fee: formatEther(fee) };
    rec.reviews.push(entry);
    const shannonFrom = await shannonPub.getBlockNumber();
    const r = await sendOn("hideki", "HUB_OWNER", `requestReview(${trader})`, { address: gateAddr(), abi: gateAbi, functionName: "requestReview", args: [trader], value: fee });
    const requested = r.logs.map((l) => decode(gateAbi, l as never)).find((d) => d?.eventName === "ReviewRequested");
    const nonce = requested?.args.nonce as bigint;
    const [toShannon] = dispatchedIds(r, "hideki");
    Object.assign(entry, { nonce: Number(nonce), requestTx: r.transactionHash, messageToShannon: toShannon });
    save();
    const inbound = toShannon ? await delivery("shannon", toShannon, shannonFrom, `review ${Number(nonce)} delivered to the reviewer`) : undefined;
    if (!inbound) continue;
    entry.deliveryToShannon = inbound.transactionHash;

    // follow the reviewer's events for this review until it replies (two committee stages, up to 300 s each)
    const mine = (d: { args: Record<string, unknown> } | undefined) =>
      !!d && typeof d.args.trader === "string" && getAddress(d.args.trader) === trader && d.args.nonce === nonce;
    const seen = new Set<string>();
    const stages: Record<string, unknown>[] = [];
    let sent: { tier: number; messageId: Hex; tx: Hex; block: bigint } | undefined;
    let replyFailed = false;
    await findLogs(
      "shannon",
      reviewerAddr(),
      inbound.blockNumber,
      (logs) => {
        for (const l of logs) {
          const key = `${l.transactionHash}:${l.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const d = decode(reviewerAbi, l);
          if (!mine(d)) continue;
          const ev = { event: d!.eventName, tx: l.transactionHash, block: Number(l.blockNumber), args: d!.args };
          stages.push(ev);
          console.log(`    ${d!.eventName} ${JSON.stringify(d!.args, big)} (${l.transactionHash})`);
          if (d!.eventName === "VerdictSent") {
            sent = { tier: Number(d!.args.tier), messageId: d!.args.messageId as Hex, tx: l.transactionHash, block: l.blockNumber };
            return true;
          }
          if (d!.eventName === "ReplyFailed") {
            replyFailed = true;
            return true;
          }
        }
        return undefined;
      },
      15 * 60_000,
    );
    entry.shannonEvents = stages;
    // the committee callbacks (validator transactions into the platform) with each validator's answer and receipt
    const callbackTxs = [...new Set(stages.filter((x) => ["SummaryReceived", "VerdictTallied"].includes(x.event as string) || (x.event === "ReviewFailed" && x.tx !== inbound.transactionHash)).map((x) => x.tx as Hex))];
    const callbacks: Record<string, unknown>[] = [];
    for (const h of callbackTxs) {
      const rc = await shannonPub.getTransactionReceipt({ hash: h });
      track("shannon", `review ${Number(nonce)} committee callback`, rc);
      callbacks.push({ tx: h, submittedBy: rc.from, committee: await committee(h) });
    }
    entry.callbacks = callbacks;
    for (const x of stages) {
      const hash = x.tx as Hex;
      if (hash === inbound.transactionHash || callbackTxs.includes(hash) || rec.txs.some((t) => t.hash === hash)) continue;
      track("shannon", `review ${Number(nonce)} ${x.event}`, await shannonPub.getTransactionReceipt({ hash }));
    }
    save();
    if (!check(!!sent && !replyFailed, `review ${Number(nonce)}: the reviewer replied (tier ${sent ? TIERS[sent.tier] : "-"})`)) continue;
    const hidekiFrom = (await pub.getBlockNumber()) - 900n;
    const back = await delivery("hideki", sent!.messageId, hidekiFrom, `review ${Number(nonce)} verdict delivered to the gate`);
    if (!back) continue;
    const gateEvents = back.logs.map((l) => decode(gateAbi, l as never)).filter((d) => !!d) as { eventName: string; args: Record<string, unknown> }[];
    entry.deliveryToHideki = back.transactionHash;
    entry.gateEvents = gateEvents.map((g) => ({ event: g.eventName, args: g.args }));
    for (const g of gateEvents) console.log(`    gate ${g.eventName} ${JSON.stringify(g.args, big)}`);
    const v = await readGate<{ tier: number; reviewedAt: bigint; shannonRequestId: bigint; summaryHash: Hex }>("verdictOf", [trader]);
    entry.verdict = { tier: TIERS[Number(v.tier)], reviewedAt: Number(v.reviewedAt), shannonRequestId: v.shannonRequestId.toString(), summaryHash: v.summaryHash };
    const failure = stages.find((x) => x.event === "ReviewFailed");
    if (failure) entry.failure = FAILURES[Number((failure.args as Record<string, unknown>).reason)];
    const summary = stages.find((x) => x.event === "SummaryReceived");
    if (summary) entry.summary = (summary.args as Record<string, unknown>).summary;
    check(gateEvents.some((g) => ["VerdictReceived", "ReviewFailed", "BlockHeld"].includes(g.eventName)), `review ${Number(nonce)}: the gate settled it (${gateEvents.map((g) => g.eventName).join(", ")})`);
    save();
  }
}

/** With a live Block on the leader: an increase is refused for the guarded follower and copied once it opts out,
 * and the exit copies either way. Without one: only the guard switch itself is shown. */
async function guard() {
  const v = await readGate<{ tier: number; reviewedAt: bigint }>("verdictOf", [LEADER]);
  const blocked = Number(v.tier) === 3;
  note("leader verdict", { tier: TIERS[Number(v.tier)], reviewedAt: Number(v.reviewedAt) });
  rec.measurements.guard = { leaderTier: TIERS[Number(v.tier)], liveBlock: blocked };
  const pool = await btc();
  if (!blocked) {
    // the leader has no Block, so no copy can be refused; the guard switch is shown against any reviewed trader
    // that does hold a live Block (the follower does not copy that trader: these are the gate's answers only)
    const blockedTrader = (rec.reviews as { trader?: string; verdict?: { tier?: string } }[])
      .filter((r) => r.verdict?.tier === "Block" && r.trader)
      .map((r) => getAddress(r.trader!))
      .find((t) => t !== LEADER);
    const ask = async (what: string) => {
      const answers: Record<string, boolean> = { leader: await readGate<boolean>("allowIncrease", [sourceIdOf(LEADER), FOLLOWER]) };
      if (blockedTrader) answers[blockedTrader] = await readGate<boolean>("allowIncrease", [sourceIdOf(blockedTrader), FOLLOWER]);
      note(`allowIncrease for the follower, ${what}`, answers);
      return answers;
    };
    const on1 = await ask("guard on");
    await sendOn("hideki", "FOLLOWER", "follower opts out of the guard", { address: gateAddr(), abi: gateAbi, functionName: "setGuard", args: [false] });
    check((await readGate<boolean>("guardOf", [FOLLOWER])) === false, "guardOf(follower) = false");
    const off = await ask("guard off");
    await sendOn("hideki", "FOLLOWER", "follower opts back in", { address: gateAddr(), abi: gateAbi, functionName: "setGuard", args: [true] });
    check((await readGate<boolean>("guardOf", [FOLLOWER])) === true, "guardOf(follower) = true");
    const on2 = await ask("guard back on");
    check(on1.leader && off.leader && on2.leader, "no live Block on the leader: the follower's increases stay allowed");
    if (blockedTrader) {
      check(!on1[blockedTrader] && off[blockedTrader] && !on2[blockedTrader], `${blockedTrader} holds a live Block: refused while guarded, allowed after opting out, refused again after opting in`);
    }
    rec.measurements.guard = { ...(rec.measurements.guard as object), blockedTrader, guardOn: on1, guardOff: off, guardBackOn: on2 };
    save();
    return;
  }
  check((await size(FOLLOWER, pool)) === 0n && (await size(LEADER, pool)) === 0n, "leader and follower flat on BTC");
  // unguarded: the increase copies
  await sendOn("hideki", "FOLLOWER", "follower opts out of the guard", { address: gateAddr(), abi: gateAbi, functionName: "setGuard", args: [false] });
  const t1 = await leaderTrade("leader buys 0.0005 BTC (follower unguarded)", true, 50_000n);
  const r1 = await followerRun("unguarded increase", t1, (evs) => copiedTo(50_000n)(evs) || evs.some((e) => e.eventName === "Refused"));
  check(!!r1 && copiedTo(50_000n)(r1.events), "unguarded follower copies the increase");
  // guarded: the next increase is refused, the exit still copies
  await sendOn("hideki", "FOLLOWER", "follower turns the guard on", { address: gateAddr(), abi: gateAbi, functionName: "setGuard", args: [true] });
  const t2 = await leaderTrade("leader adds 0.0003 BTC (follower guarded)", true, 30_000n);
  const r2 = await followerRun("guarded increase", t2, (evs) => evs.some((e) => e.eventName === "Refused" || e.eventName === "Copied"));
  check(!!r2 && riskRefusal(r2.events), "Refused(RiskGate) for the guarded follower");
  check((await size(FOLLOWER, pool)) === 50_000n, "follower still holds 50000");
  const t3 = await leaderTrade("leader sells 0.0008 BTC (exit)", false, 80_000n);
  const r3 = await followerRun("exit while blocked", t3, copiedTo(0n));
  check(!!r3 && r3.calls.length === 0, "the exit copied without asking the gate");
  check((await size(FOLLOWER, pool)) === 0n, "follower flat");
  rec.measurements.guard = { ...(rec.measurements.guard as object), unguarded: r1?.logs, guarded: r2?.logs, exit: r3?.logs };
  save();
}

// ---------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2);
// a review run is recorded per trader list, so separate runs keep their own checks
step = cmd === "review" && args.length ? `review ${args.join(" ")}` : (cmd ?? "");
rec.checks[step] = [];
console.log(`=== ${step}`);
try {
  switch (cmd) {
    case "bridge":
      await bridge(args[0] ?? "15");
      break;
    case "record":
      await recordDeploy();
      break;
    case "wire":
      await wire();
      break;
    case "fund":
      await fund(args[0] ?? "12");
      break;
    case "check":
      await checks();
      break;
    case "trade":
      await trade();
      break;
    case "base-url":
      await setBaseUrl(args[0]);
      break;
    case "prompt":
      await setPrompt();
      break;
    case "review":
      await review(args.length ? args.map((a) => getAddress(a)) : [STEADY, LIQUIDATED, LEADER]);
      break;
    case "guard":
      await guard();
      break;
    default:
      throw new Error("steps: bridge <stt> | record | wire | fund <stt> | check | trade | base-url <url> | prompt | review [trader ...] | guard");
  }
} catch (e) {
  failed = true;
  check(false, `error: ${errMsg(e)}`);
}
save();
console.log(`=== ${step}: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);

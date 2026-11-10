// How the demo leader's followers have been copied since the demo-leader bot started: every move the leader made, the
// hub's handler runs in its block, and what each run did for each follower. Read from the chain only (Hideki's public
// RPC, no key), and written to e2e/proof/uptime.json, which `npm run proof` renders into docs/PROOF.md.
//
//   npm run uptime                       from the bot's first trade to the chain head
//   npm run uptime -- <fromBlock> [toBlock]
//
// A move is a transaction that emitted dreamDEX's PositionUpdated for the leader. Each such event makes Somnia's
// validators call the leader's group relay, so the hub sends one handler transaction per event. A handler run is a
// transaction the hub sent to one of the leader's group relays in the move's block, after the move. A copy is a
// `Copied` with the leader's source id; it is a handler copy when the hub sent it, and in the leader's block when that
// block holds a leader move before it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, hexToBigInt, hexToNumber, numberToHex, zeroAddress, type Address, type Hex } from "viem";
import { decodeCopybookLog, hubAbi, sourceIdOf, type CopybookEvent } from "../../packages/sdk/src/index.ts";
import { loadDeployments } from "../../packages/sdk/src/node.ts";
import { MARGIN_BANK, pub } from "./env.ts";
import type { UptimeSummary } from "./proof-ledger.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const UPTIME_FILE = resolve(ROOT, "e2e/proof/uptime.json");
const deployments = loadDeployments(resolve(ROOT, "deployments"));
const HUB = getAddress(deployments.hub);
const LEADER = getAddress(deployments.demoWallets.find((w) => w.role === "demo leader")!.address);
const SOURCE = sourceIdOf("Trader", LEADER).toLowerCase();
/** The demo-leader bot's first trade: 0.00026 BTC opened at 2026-10-29 17:17:28 UTC. */
export const BOT_START_BLOCK = 36_410_390n;
const POSITION_UPDATED = "0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de";
const pad32 = (a: Address): Hex => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const SPAN = 1000n; // the node's getLogs limit
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RpcLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; transactionIndex: Hex; logIndex: Hex };

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await pub.request({ method, params } as never)) as T;
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** Runs `jobs` with at most `n` in flight; `onDone` after each. */
async function pool<T>(jobs: (() => Promise<T>)[], n: number, onDone?: (done: number) => void): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
        onDone?.(++done);
      }
    }),
  );
  return out;
}

const toRaw = (l: RpcLog) => ({
  address: l.address,
  topics: l.topics,
  data: l.data,
  blockNumber: hexToBigInt(l.blockNumber),
  transactionHash: l.transactionHash,
  transactionIndex: hexToNumber(l.transactionIndex),
  logIndex: hexToNumber(l.logIndex),
});

export type Uptime = UptimeSummary;

export async function uptime(from: bigint, to: bigint, log = (s: string) => console.log(s)): Promise<Uptime> {
  const chunks: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += SPAN) chunks.push([a, a + SPAN - 1n > to ? to : a + SPAN - 1n]);
  log(`blocks ${from}–${to}: ${chunks.length} windows of ${SPAN}, two reads each`);
  let last = Date.now();
  const progress = (done: number) => {
    if (Date.now() - last > 15_000) {
      last = Date.now();
      log(`  ${done} of ${chunks.length * 2} reads`);
    }
  };
  const jobs: (() => Promise<RpcLog[]>)[] = [];
  for (const [a, b] of chunks) {
    const range = { fromBlock: numberToHex(a), toBlock: numberToHex(b) };
    jobs.push(() => rpc<RpcLog[]>("eth_getLogs", [{ address: MARGIN_BANK, topics: [POSITION_UPDATED, pad32(LEADER)], ...range }]));
    jobs.push(() => rpc<RpcLog[]>("eth_getLogs", [{ address: HUB, ...range }]));
  }
  const results = await pool(jobs, 24, progress);
  const bankLogs = results.filter((_, i) => i % 2 === 0).flat();
  const hubLogs = results.filter((_, i) => i % 2 === 1).flat();

  // the leader's moves, by transaction
  const moves = new Map<Hex, { hash: Hex; block: number; index: number; updates: number }>();
  for (const l of bankLogs) {
    const m = moves.get(l.transactionHash);
    if (m) m.updates += 1;
    else moves.set(l.transactionHash, { hash: l.transactionHash, block: hexToNumber(l.blockNumber), index: hexToNumber(l.transactionIndex), updates: 1 });
  }
  const movesByBlock = new Map<number, { hash: Hex; index: number }[]>();
  for (const m of moves.values()) movesByBlock.set(m.block, [...(movesByBlock.get(m.block) ?? []), m]);

  // the hub's events about the leader's source, by transaction
  const events = hubLogs.map((l) => decodeCopybookLog(toRaw(l), deployments)).filter((e): e is CopybookEvent => !!e);
  const aboutLeader = (e: CopybookEvent) => "sourceId" in e && String(e.sourceId).toLowerCase() === SOURCE;
  const byTx = new Map<Hex, CopybookEvent[]>();
  for (const e of events) byTx.set(e.log.transactionHash as Hex, [...(byTx.get(e.log.transactionHash as Hex) ?? []), e]);

  // handler runs: the hub's own transactions to the leader's relays in each move's block, after the move
  const relays = new Set<string>();
  for (let g = 0; ; g++) {
    const r = await pub.readContract({ address: HUB, abi: hubAbi, functionName: "relayOf", args: [SOURCE as Hex, g] });
    if (getAddress(r) === zeroAddress) break;
    relays.add(getAddress(r));
  }
  log(`${moves.size} moves in ${movesByBlock.size} blocks; reading those blocks for the hub's runs on ${[...relays].join(", ")}`);
  const runs = new Map<Hex, { block: number; index: number }>();
  await pool(
    [...movesByBlock.entries()].map(([block, ms]) => async () => {
      const b = await rpc<{ transactions: { hash: Hex; from: Address; to: Address | null; transactionIndex: Hex }[] }>("eth_getBlockByNumber", [numberToHex(block), true]);
      const first = Math.min(...ms.map((m) => m.index));
      for (const tx of b.transactions)
        if (getAddress(tx.from) === HUB && tx.to && relays.has(getAddress(tx.to)) && hexToNumber(tx.transactionIndex) > first)
          runs.set(tx.hash, { block, index: hexToNumber(tx.transactionIndex) });
    }),
    24,
  );

  // senders of every transaction with a Copied for the leader's source: the hub (a handler run) or a caller
  const copyTxs = [...byTx.entries()].filter(([, evs]) => evs.some((e) => e.name === "Copied" && aboutLeader(e))).map(([h]) => h);
  const senders = new Map<Hex, Address>();
  await pool(
    copyTxs.filter((h) => !runs.has(h)).map((h) => async () => {
      const tx = await rpc<{ from: Address }>("eth_getTransactionByHash", [h]);
      senders.set(h, getAddress(tx.from));
    }),
    24,
  );
  for (const h of runs.keys()) senders.set(h, HUB);

  const u: Uptime = {
    about:
      "The demo leader's followers since the demo-leader bot's first trade, read from Hideki by `npm run uptime` (in e2e/). A move is a transaction that emitted dreamDEX's PositionUpdated for the leader; a handler run is a transaction the hub sent in a move's block, after the move; a handler copy is a Copied for the leader's source in a transaction the hub sent.",
    leader: LEADER,
    sourceId: SOURCE,
    fromBlock: Number(from),
    asOfBlock: Number(to),
    fromTime: "",
    asOfTime: "",
    moves: { transactions: moves.size, positionUpdates: bankLogs.length },
    handlerRuns: { total: runs.size, withCopy: 0, refusedOnly: 0, nothing: 0 },
    handlerCopies: { total: 0, inLeadersBlock: 0, notInLeadersBlock: 0, byFollower: {} },
    directCopies: 0,
    refusals: {},
    deferred: 0,
    groupDeferred: 0,
    tankCharged: {},
    samples: [],
  };
  for (const [hash] of runs) {
    const evs = (byTx.get(hash) ?? []).filter((e) => aboutLeader(e) || e.name === "TankCharged");
    if (evs.some((e) => e.name === "Copied")) u.handlerRuns.withCopy += 1;
    else if (evs.some((e) => e.name === "Refused")) u.handlerRuns.refusedOnly += 1;
    else u.handlerRuns.nothing += 1;
  }
  const charged: Record<string, bigint> = {};
  const handlerCopies: { hash: Hex; block: number; index: number; follower: Address }[] = [];
  for (const [hash, evs] of byTx) {
    const byHub = senders.get(hash) === HUB || runs.has(hash);
    for (const e of evs) {
      if (e.name === "Copied" && aboutLeader(e)) {
        if (!byHub) {
          u.directCopies += 1;
          continue;
        }
        const block = Number(e.log.blockNumber);
        const index = e.log.transactionIndex ?? -1;
        const inBlock = (movesByBlock.get(block) ?? []).some((m) => m.index < index);
        u.handlerCopies.total += 1;
        if (inBlock) u.handlerCopies.inLeadersBlock += 1;
        else u.handlerCopies.notInLeadersBlock += 1;
        u.handlerCopies.byFollower[e.follower] = (u.handlerCopies.byFollower[e.follower] ?? 0) + 1;
        handlerCopies.push({ hash, block, index, follower: e.follower });
      }
      if (e.name === "Refused" && aboutLeader(e)) u.refusals[e.reason] = (u.refusals[e.reason] ?? 0) + 1;
      if (e.name === "Deferred" && aboutLeader(e)) u.deferred += 1;
      if (e.name === "GroupDeferred" && aboutLeader(e)) u.groupDeferred += 1;
      if (e.name === "TankCharged" && runs.has(hash)) charged[e.follower] = (charged[e.follower] ?? 0n) + e.amount;
    }
  }
  for (const [f, v] of Object.entries(charged)) u.tankCharged[f] = v.toString();
  handlerCopies.sort((x, y) => x.block - y.block || x.index - y.index);
  const sample = (label: string, c?: (typeof handlerCopies)[number]) => {
    if (!c) return;
    const move = (movesByBlock.get(c.block) ?? []).filter((m) => m.index < c.index).sort((x, y) => y.index - x.index)[0];
    if (move) u.samples.push({ label, move: { hash: move.hash, block: c.block, index: move.index }, copy: c });
  };
  sample("the first handler copy after the bot started", handlerCopies[0]);
  sample("the last handler copy before the as-of block", handlerCopies[handlerCopies.length - 1]);
  const time = async (b: bigint) => new Date(Number((await pub.getBlock({ blockNumber: b })).timestamp) * 1000).toISOString();
  u.fromTime = await time(from);
  u.asOfTime = await time(to);
  return u;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [a, b] = process.argv.slice(2);
  const from = a ? BigInt(a) : BOT_START_BLOCK;
  const to = b ? BigInt(b) : await pub.getBlockNumber();
  const u = await uptime(from, to);
  mkdirSync(dirname(UPTIME_FILE), { recursive: true });
  writeFileSync(UPTIME_FILE, JSON.stringify(u, null, 2) + "\n");
  const c = u.handlerCopies;
  console.log(`\nas of Hideki block ${u.asOfBlock.toLocaleString("en-US")} (${u.asOfTime}), since block ${u.fromBlock.toLocaleString("en-US")} (${u.fromTime}):`);
  console.log(`  leader moves: ${u.moves.transactions} transactions, ${u.moves.positionUpdates} PositionUpdated events`);
  console.log(`  handler runs in the moves' blocks: ${u.handlerRuns.total} (${u.handlerRuns.withCopy} with a copy, ${u.handlerRuns.refusedOnly} refusals only, ${u.handlerRuns.nothing} copied and refused nothing)`);
  console.log(`  handler copies: ${c.total}, ${c.inLeadersBlock} in the leader's block, ${c.notInLeadersBlock} not; by follower ${JSON.stringify(c.byFollower)}`);
  console.log(`  copies sent directly (catchUp, follow, unfollow): ${u.directCopies}`);
  console.log(`  refusals by reason: ${JSON.stringify(u.refusals)}; Deferred ${u.deferred}, GroupDeferred ${u.groupDeferred}`);
  console.log(`  wrote ${UPTIME_FILE}`);
}

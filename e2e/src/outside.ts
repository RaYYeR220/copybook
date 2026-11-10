// Copying a trader Copybook does not control: one of our demo followers (UI_FOLLOWER) follows a dreamDEX trader who
// signed nothing and does not know, and the hub's handler copies (or refuses, with its reason) each of the trader's
// moves in the move's block.
//
//   npm run outside -- stats <trader>                    the trader's position changes over the last 24 h (indexer, no key)
//   COPYBOOK_ENV=<keys> npm run outside -- fund <stt> <usdso>
//                                                        the hub owner sends the follower STT and spot USDso
//   COPYBOOK_ENV=<keys> npm run outside -- follow <trader> <pool> <usdso>
//                                                        the follower's margin deposit, guard on, operator approval, a
//                                                        review of the trader paid at the gate's fee, then the follow
//   COPYBOOK_ENV=<keys> npm run outside -- tank <stt>     the follower adds STT to its gas tank
//   npm run outside -- pairs <follower> <trader> <fromBlock> [toBlock]
//                                                        every move of the trader since fromBlock, with the hub's handler
//                                                        run in its block and what it did for the follower (no key)
//
// COPYBOOK_ENV needs HUB_OWNER_PK for `fund` and UI_FOLLOWER_PK for `follow` and `tank`; it may name both files
// (see src/env.ts). Every transaction is printed with its block and position and kept in out/outside.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther, getAddress, parseAbi, parseEther, type Address, type Hex, type TransactionReceipt } from "viem";
import { createCopybook, type CopybookEvent, type Policy } from "../../packages/sdk/src/index.ts";
import { loadDeployments } from "../../packages/sdk/src/node.ts";
import { account, INDEXER_URL, MARGIN_BANK, pub, USDSO, wallet, EXPLORER_TX } from "./env.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(ROOT, "e2e/out/outside.json");
const deployments = loadDeployments(resolve(ROOT, "deployments"));
const HUB = getAddress(deployments.hub);
/** dreamDEX's margin bank: `PositionUpdated(account, pool, ...)` is the event the hub's subscription follows. */
const POSITION_UPDATED = "0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de" as const;
const pad32 = (a: Address): Hex => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/**
 * A small copy of a trader we do not control: 1.5% of the trader's size, at most 10 USDso of notional per position
 * (a little above one minimum order in BTC or ETH at today's marks) and 15 in all, increases priced inside 0.5% of
 * the mark, and the follow stops when the account's equity falls under 3 USDso.
 */
const POLICY: Policy = {
  scaleBps: 150,
  allocation: 0n,
  maxNotional: parseEther("10"),
  maxTotalNotional: parseEther("15"),
  bandBps: 50,
  equityFloor: parseEther("3"),
};
const TANK = parseEther("2");

type Rec = { txs: Record<string, unknown>[]; pairs?: unknown };
const rec: Rec = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Rec) : { txs: [] };
function save() {
  mkdirSync(resolve(ROOT, "e2e/out"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(rec, big, 2) + "\n");
}
function track(label: string, r: TransactionReceipt, events: CopybookEvent[] = []) {
  const e = {
    label,
    hash: r.transactionHash,
    block: Number(r.blockNumber),
    index: r.transactionIndex,
    gasUsed: Number(r.gasUsed),
    status: r.status,
    from: getAddress(r.from),
    to: r.to ? getAddress(r.to) : null,
    events: events.map(({ log: _log, ...x }) => x),
    url: EXPLORER_TX + r.transactionHash,
  };
  rec.txs.push(e);
  save();
  console.log(`  ${label}: ${e.hash} block ${e.block} #${e.index} gas ${e.gasUsed} ${e.status}`);
  for (const x of e.events) console.log(`    ${JSON.stringify(x, big)}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
  return e;
}

const follower = () => account("UI_FOLLOWER").address;
const client = (signer?: "UI_FOLLOWER") =>
  createCopybook({ publicClient: pub as never, walletClient: signer ? (wallet(signer) as never) : undefined, deployments });

// ---------------------------------------------------------------- stats (read-only)

async function stats(trader: Address) {
  const since = Math.floor(Date.now() / 1000) - 86_400;
  const rows: { pool: string; kind: string; timestamp: string; txHash: string; sizeBefore: string; sizeAfter: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($a:String!,$since:numeric!,$o:Int!){PerpPositionChange(where:{account:{_eq:$a},timestamp:{_gte:$since}},order_by:[{timestamp:desc},{id:desc}],limit:1000,offset:$o){pool kind timestamp txHash sizeBefore sizeAfter}}`,
        variables: { a: trader.toLowerCase(), since: String(since), o: offset },
      }),
    });
    const page = ((await res.json()) as { data: { PerpPositionChange: typeof rows } }).data.PerpPositionChange;
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const byPool: Record<string, number> = {};
  for (const r of rows) byPool[r.pool] = (byPool[r.pool] ?? 0) + 1;
  const crossings = rows.filter((r) => r.sizeBefore === "0" || r.sizeAfter === "0" || r.sizeBefore.startsWith("-") !== r.sizeAfter.startsWith("-")).length;
  console.log(
    JSON.stringify(
      {
        trader,
        window: "last 24 h",
        positionChanges: rows.length,
        perHour: +(rows.length / 24).toFixed(2),
        transactions: new Set(rows.map((r) => r.txHash)).size,
        hoursWithAChange: new Set(rows.map((r) => Math.floor(Number(r.timestamp) / 3600))).size,
        opensClosesAndFlips: crossings,
        byPool,
        ours: deployments.demoWallets.some((w) => getAddress(w.address) === getAddress(trader)),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------- fund (hub owner)

async function fund(stt: string, usdso: string) {
  const owner = wallet("HUB_OWNER");
  const to = follower();
  console.log(`owner ${owner.account.address} → follower ${to}: ${stt} STT, ${usdso} USDso`);
  console.log(`  owner before: ${formatEther(await pub.getBalance({ address: owner.account.address }))} STT`);
  if (Number(stt) > 0) {
    const h = await owner.sendTransaction({ to, value: parseEther(stt), gas: 1_000_000n });
    track(`owner → follower ${stt} STT`, await pub.waitForTransactionReceipt({ hash: h }));
  }
  if (Number(usdso) > 0) {
    const est = await pub.estimateContractGas({ address: USDSO, abi: erc20, functionName: "transfer", args: [to, parseEther(usdso)], account: owner.account });
    const h = await owner.writeContract({ address: USDSO, abi: erc20, functionName: "transfer", args: [to, parseEther(usdso)], gas: (est * 3n) / 2n });
    track(`owner → follower ${usdso} USDso`, await pub.waitForTransactionReceipt({ hash: h }));
  }
  console.log(`  owner after: ${formatEther(await pub.getBalance({ address: owner.account.address }))} STT`);
}

// ---------------------------------------------------------------- follow (the follower)

async function follow(trader: Address, pool: Address, usdso: string) {
  const cb = client("UI_FOLLOWER");
  const me = follower();
  if (await cb.followOf(me)) throw new Error(`${me} already follows a source`);
  const margin = parseEther(usdso);
  const equity = await cb.accountEquity(me);
  if (equity < margin) {
    const { allowance } = await cb.marginFunding(me);
    if (allowance < margin) track("approve the margin bank", (await (await cb.approveMargin(margin)).wait()).receipt);
    const r = await (await cb.depositMargin(margin)).wait();
    track(`deposit ${usdso} USDso into the perps account`, r.receipt);
  }
  if (!(await cb.guardOf(me))) {
    const r = await (await cb.setGuard(true)).wait();
    track("guard on", r.receipt, r.events);
  }
  if (!(await cb.isOperatorApproved(me))) {
    const r = await (await cb.approveOperator(true)).wait();
    track("operator approval (placeOrderFor, global)", r.receipt);
  }
  const fee = await cb.reviewFee();
  const review = await (await cb.requestReview(trader, fee)).wait();
  track(`a review of ${trader}, paid at the gate's fee (${formatEther(fee)} STT)`, review.receipt, review.events);

  const check = await cb.preflightFollow({ account: me, kind: "Trader", source: trader, policy: POLICY, joinPools: [pool], tank: TANK, guardOn: true, walletChainId: deployments.chainId });
  for (const r of check.reasons) console.log(`  preflight ${r.severity} ${r.code}: ${r.message}`);
  if (!check.ok) throw new Error("the preflight refuses this follow");
  const r = await (await cb.follow({ target: { kind: "Trader", trader, joinPools: [pool] }, policy: POLICY, tank: TANK })).wait();
  track(`follow ${trader} on ${pool} (scale ${POLICY.scaleBps} bps, cap 10 / 15 USDso, band ${POLICY.bandBps} bps, floor 3 USDso, tank ${formatEther(TANK)} STT)`, r.receipt, r.events);
  console.log(`  margin bank ${MARGIN_BANK}; equity now ${formatEther(await cb.accountEquity(me))} USDso; tank ${formatEther(await cb.tankOf(me))} STT`);
}

async function tank(stt: string) {
  const cb = client("UI_FOLLOWER");
  const r = await (await cb.fundTank(parseEther(stt))).wait();
  track(`fundTank ${stt} STT`, r.receipt, r.events);
  console.log(`  tank now ${formatEther(await cb.tankOf(follower()))} STT`);
}

// ---------------------------------------------------------------- pairs (read-only)

type Move = { hash: Hex; block: number; index: number; from: Address; logs: number };
type Run = { hash: Hex; index: number; events: Record<string, unknown>[] };

/** The trader's moves (each transaction that emitted PositionUpdated for it) in [from, to], 1000 blocks per read. */
async function moves(trader: Address, from: bigint, to: bigint): Promise<Move[]> {
  const byTx = new Map<Hex, Move>();
  for (let a = from; a <= to; a += 1000n) {
    const b = a + 999n > to ? to : a + 999n;
    const logs = await pub.request({
      method: "eth_getLogs",
      params: [{ address: MARGIN_BANK, topics: [POSITION_UPDATED, pad32(trader)], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
    } as never) as { transactionHash: Hex; blockNumber: Hex; transactionIndex: Hex }[];
    for (const l of logs) {
      const m = byTx.get(l.transactionHash);
      if (m) m.logs += 1;
      else byTx.set(l.transactionHash, { hash: l.transactionHash, block: Number(l.blockNumber), index: Number(l.transactionIndex), from: "0x" as Address, logs: 1 });
    }
  }
  const out = [...byTx.values()].sort((x, y) => x.block - y.block || x.index - y.index);
  for (const m of out) m.from = getAddress((await pub.getTransaction({ hash: m.hash })).from);
  return out;
}

/** The hub's transactions in a block after position `after`, with the Copybook events each emitted for `who`. */
async function handlerRuns(block: number, after: number, who: Address): Promise<Run[]> {
  const cb = client();
  const blk = await pub.getBlock({ blockNumber: BigInt(block), includeTransactions: true });
  const runs: Run[] = [];
  for (const tx of blk.transactions) {
    if (typeof tx === "string" || getAddress(tx.from) !== HUB || (tx.transactionIndex ?? -1) <= after) continue;
    const r = await pub.getTransactionReceipt({ hash: tx.hash });
    const evs = cb.decodeLogs(r.logs as never).filter((e) => "follower" in e && getAddress(e.follower) === getAddress(who));
    runs.push({ hash: tx.hash, index: tx.transactionIndex ?? -1, events: evs.map(({ log: _log, ...x }) => x as Record<string, unknown>) });
  }
  return runs;
}

async function pairs(who: Address, trader: Address, fromBlock: bigint, toBlock?: bigint) {
  const to = toBlock ?? (await pub.getBlockNumber());
  const ms = await moves(trader, fromBlock, to);
  const seen = new Set<Hex>();
  const out: Record<string, unknown>[] = [];
  for (const m of ms) {
    const runs = (await handlerRuns(m.block, m.index, who)).filter((r) => !seen.has(r.hash));
    for (const r of runs) seen.add(r.hash);
    const acted = runs.filter((r) => r.events.some((e) => e.name === "Copied" || e.name === "Refused"));
    const what = acted.flatMap((r) => r.events.filter((e) => e.name !== "TankCharged").map((e) => (e.name === "Copied" ? `Copied ${e.fromSize} → ${e.toSize}` : `${e.name} ${e.reason ?? ""}`.trim())));
    const row = {
      move: m.hash,
      moveFrom: m.from,
      block: m.block,
      moveIndex: m.index,
      positionUpdates: m.logs,
      handlerRuns: runs.map((r) => ({ hash: r.hash, index: r.index, events: r.events.map((e) => e.name) })),
      result: acted.length ? what.join("; ") : runs.length ? "handler ran, nothing to copy or refuse" : "no handler run for this follower",
    };
    out.push(row);
    console.log(`${m.block} #${m.index} ${m.hash} (from ${m.from === getAddress(trader) ? "the trader" : m.from}, ${m.logs} update${m.logs > 1 ? "s" : ""}) → ${runs.map((r) => `#${r.index} ${r.hash}`).join(", ") || "-"}: ${row.result}`);
  }
  rec.pairs = { follower: who, trader, fromBlock: Number(fromBlock), toBlock: Number(to), at: new Date().toISOString(), moves: out };
  save();
  const copied = out.filter((r) => String(r.result).includes("Copied")).length;
  const refused = out.filter((r) => String(r.result).includes("Refused")).length;
  console.log(`\n${out.length} moves in blocks ${fromBlock}–${to}: ${copied} with a copy, ${refused} with a refusal, ${out.length - copied - refused} with neither`);
  const tankLeft = await client().tankOf(who);
  console.log(`tank ${formatEther(tankLeft)} STT`);
}

// ---------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2);
const usage = "steps: stats <trader> | fund <stt> <usdso> | follow <trader> <pool> <usdso> | tank <stt> | pairs <follower> <trader> <fromBlock> [toBlock]";
try {
  switch (cmd) {
    case "stats":
      await stats(getAddress(args[0]));
      break;
    case "fund":
      await fund(args[0], args[1] ?? "0");
      break;
    case "follow":
      await follow(getAddress(args[0]), getAddress(args[1]), args[2] ?? "10");
      break;
    case "tank":
      await tank(args[0]);
      break;
    case "pairs":
      await pairs(getAddress(args[0]), getAddress(args[1]), BigInt(args[2]), args[3] ? BigInt(args[3]) : undefined);
      break;
    default:
      throw new Error(usage);
  }
} catch (e) {
  console.error(`error: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`);
  process.exitCode = 1;
}

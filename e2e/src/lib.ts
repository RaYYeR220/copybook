import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { pub, wallet, chain, EXPLORER_TX, MARGIN_BANK, REACTIVITY, type Role } from "./env.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function artifact(file: string, name: string): Abi {
  const path = resolve(ROOT, `contracts/out/${file}/${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}: run forge build in contracts/`);
  return JSON.parse(readFileSync(path, "utf8")).abi as Abi;
}

export const hubAbi = artifact("CopybookHub.sol", "CopybookHub");
export const themesAbi = artifact("ThemeRegistry.sol", "ThemeRegistry");
export const precompileAbi = artifact("ISomniaReactivityPrecompile.sol", "ISomniaReactivityPrecompile");
const engineAbi = artifact("CopyEngine.sol", "CopyEngine");
/** Hub plus engine errors, for decoding reverts. */
export const hubErrorsAbi = [...hubAbi, ...engineAbi.filter((x) => x.type === "error")] as Abi;

export const deployment = JSON.parse(readFileSync(resolve(ROOT, "deployments/hideki.json"), "utf8")) as {
  chainId: number;
  hub: Address;
  engine: Address;
  themes: Address;
};
export const HUB = getAddress(deployment.hub);
export const THEMES = getAddress(deployment.themes);

export const poolAbi = parseAbi([
  "function getMarkPrice() view returns (uint256)",
  "function getOneBase() view returns (uint256)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool, uint128)",
]);
export const bankAbi = parseAbi([
  "function getPosition(address account, address pool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
]);
export const registryAbi = parseAbi([
  "function setOperatorApprovalGlobal(address operator, bytes4[] selectors, bool approved)",
  "function setOperatorApprovalForPool(address pool, address operator, bytes4[] selectors, bool approved)",
  "function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)",
  "function isApprovedForPool(address pool, address owner, address operator, bytes4 selector) view returns (bool)",
]);

// ---------------------------------------------------------------- proof

export type TxRec = {
  label: string;
  hash: Hex;
  block: number;
  txIndex: number;
  gasUsed: number;
  status: string;
  from: string;
  url: string;
};
export type Scenario = {
  name: string;
  result: "PASS" | "FAIL";
  txs: TxRec[];
  checks: string[];
  data: Record<string, unknown>;
  at: string;
};
export type SameBlock = {
  scenario?: string;
  label: string;
  trigger: Hex;
  triggerBlock: number;
  triggerIndex: number;
  handler?: Hex;
  handlerBlock?: number;
  handlerIndex?: number;
  delta?: number;
  handlerFrom?: string;
  handlerGas?: number;
  memberGas?: number;
  logs?: string[];
};

const PROOF = resolve(ROOT, "e2e/out/proof.json");
type Proof = {
  chainId: number;
  hub: Address;
  engine: Address;
  themes: Address;
  scenarios: Record<string, Scenario>;
  attempts?: Scenario[];
  sameBlock: SameBlock[];
  measurements: Record<string, unknown>;
};
export const proof: Proof = existsSync(PROOF)
  ? JSON.parse(readFileSync(PROOF, "utf8"))
  : { ...deployment, scenarios: {}, sameBlock: [], measurements: {} };

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export function saveProof() {
  mkdirSync(dirname(PROOF), { recursive: true });
  writeFileSync(PROOF, JSON.stringify(proof, big, 2) + "\n");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errMsg = (e: unknown) =>
  e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message).slice(0, 600) : String(e);

export class Abort extends Error {}

export async function scenario(name: string, fn: (s: Scenario) => Promise<void>) {
  const s: Scenario = { name, result: "PASS", txs: [], checks: [], data: {}, at: new Date().toISOString() };
  console.log(`\n=== ${name}`);
  // a rerun keeps the earlier attempt and replaces its same-block samples
  const prev = proof.scenarios[name];
  if (prev) proof.attempts = [...(proof.attempts ?? []), prev];
  proof.sameBlock = proof.sameBlock.filter((e) => e.scenario !== name);
  try {
    await fn(s);
  } catch (e) {
    s.result = "FAIL";
    s.checks.push(`error: ${errMsg(e)}`);
    console.log(`  error: ${errMsg(e)}`);
    if (e instanceof Abort) {
      proof.scenarios[name] = s;
      saveProof();
      throw e;
    }
  }
  proof.scenarios[name] = s;
  saveProof();
  console.log(`=== ${name}: ${s.result}`);
}

export function check(s: Scenario, ok: boolean, what: string) {
  const line = `${ok ? "ok" : "FAILED"}: ${what}`;
  s.checks.push(line);
  console.log(`  ${line}`);
  if (!ok) s.result = "FAIL";
  return ok;
}

export function note(s: Scenario, key: string, value: unknown) {
  s.data[key] = value;
  console.log(`  ${key}: ${JSON.stringify(value, big)}`);
}

export function record(s: Scenario, label: string, r: TransactionReceipt): TxRec {
  const rec: TxRec = {
    label,
    hash: r.transactionHash,
    block: Number(r.blockNumber),
    txIndex: r.transactionIndex,
    gasUsed: Number(r.gasUsed),
    status: r.status,
    from: r.from,
    url: EXPLORER_TX + r.transactionHash,
  };
  s.txs.push(rec);
  console.log(`  tx ${label}: ${rec.hash} block ${rec.block} gas ${rec.gasUsed} ${rec.status}`);
  return rec;
}

export async function receipt(hash: Hex) {
  return pub.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 500, retryCount: 20 });
}

type Write = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint; gas?: bigint };

/** Estimates on the node (Somnia gas), sends with headroom, waits, records. Reverts throw. */
export async function send(s: Scenario, role: Role, label: string, w: Write) {
  const client = wallet(role);
  const abi = [...w.abi, ...hubErrorsAbi.filter((x) => x.type === "error")] as Abi;
  let gas = w.gas;
  if (gas === undefined) {
    const est = await pub.estimateContractGas({ ...w, abi, account: client.account } as never);
    gas = (est * 3n) / 2n;
    if (gas > 300_000_000n) gas = 300_000_000n;
  }
  const hash = await client.writeContract({ ...w, abi, gas, chain, account: client.account } as never);
  const r = await receipt(hash);
  record(s, label, r);
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

export async function sendValue(s: Scenario, role: Role, label: string, to: Address, value: bigint) {
  const client = wallet(role);
  const hash = await client.sendTransaction({ to, value, chain, account: client.account, gas: 1_000_000n });
  const r = await receipt(hash);
  record(s, label, r);
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

// ---------------------------------------------------------------- reads

export async function size(account: Address, pool: Address): Promise<bigint> {
  const p = await pub.readContract({ address: MARGIN_BANK, abi: bankAbi, functionName: "getPosition", args: [account, pool] });
  return p.size;
}

export async function equity(account: Address): Promise<bigint> {
  const h = await pub.readContract({ address: MARGIN_BANK, abi: bankAbi, functionName: "getAccountHealth", args: [account] });
  return h[0];
}

export async function market(pool: Address) {
  const [mark, ob, oneBase] = await Promise.all([
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getMarkPrice" }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters" }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getOneBase" }),
  ]);
  return { mark, tick: ob.tickSize, lot: ob.lotSize, minQty: ob.minQuantity, oneBase };
}

export type HubEvent = { eventName: string; args: Record<string, unknown>; log: { blockNumber: bigint; transactionHash: Hex; transactionIndex: number; logIndex: number } };

export function decodeHub(logs: readonly { address: Address; data: Hex; topics: readonly Hex[]; blockNumber: bigint | null; transactionHash: Hex | null; transactionIndex: number | null; logIndex: number | null }[]): HubEvent[] {
  const out: HubEvent[] = [];
  for (const l of logs) {
    if (getAddress(l.address) !== HUB) continue;
    try {
      const d = decodeEventLog({ abi: hubAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
      out.push({
        eventName: d.eventName,
        args: d.args,
        log: { blockNumber: l.blockNumber!, transactionHash: l.transactionHash!, transactionIndex: l.transactionIndex!, logIndex: l.logIndex! },
      });
    } catch {
      /* not a hub event */
    }
  }
  return out;
}

export function fmtEvent(e: HubEvent) {
  return `${e.eventName}(${Object.entries(e.args)
    .map(([k, v]) => `${k}=${typeof v === "bigint" ? v.toString() : String(v)}`)
    .join(", ")})`;
}

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Waits for the hub's reaction to `trigger` for `follower`: the first hub transaction other than the trigger whose
 * logs name the follower (and satisfy `want`, when given). Returns its events, block and transaction.
 */
export async function reaction(
  trigger: TransactionReceipt,
  follower: Address,
  want?: (evs: HubEvent[]) => boolean,
  timeoutMs = 90_000,
) {
  const from = trigger.blockNumber;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const head = await pub.getBlockNumber();
      const logs = await pub.getLogs({ address: HUB, fromBlock: from, toBlock: head });
      const evs = decodeHub(logs).filter((e) => e.log.transactionHash !== trigger.transactionHash && same(e.args.follower, follower));
      const byTx = new Map<Hex, HubEvent[]>();
      for (const e of evs) byTx.set(e.log.transactionHash, [...(byTx.get(e.log.transactionHash) ?? []), e]);
      for (const [hash, txEvs] of byTx) {
        if (want && !want(txEvs)) continue;
        const [tx, r] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
        return { events: txEvs, tx, receipt: r };
      }
    } catch (e) {
      console.log(`  (log poll retry: ${errMsg(e)})`);
    }
    await sleep(1_500);
  }
  return undefined;
}

/** Transactions the hub originated (handler runs) in blocks [from, from + span). */
export async function handlerTxs(from: bigint, span = 4) {
  const out: { hash: Hex; block: bigint; index: number; to: Address | null; gasUsed: bigint; status: string }[] = [];
  for (let b = from; b < from + BigInt(span); b++) {
    const blk = await pub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of blk.transactions) {
      if (typeof tx === "string" || getAddress(tx.from) !== HUB) continue;
      const r = await pub.getTransactionReceipt({ hash: tx.hash });
      out.push({ hash: tx.hash, block: b, index: tx.transactionIndex ?? -1, to: tx.to, gasUsed: r.gasUsed, status: r.status });
    }
  }
  return out;
}

/** The precompile's view of a subscription: the struct and owner, or the raw revert. */
export async function subscriptionInfo(id: bigint) {
  try {
    const { data } = await pub.call({
      to: REACTIVITY,
      data: encodeFunctionData({ abi: precompileAbi, functionName: "getSubscriptionInfo", args: [id] }),
    });
    const [sub, owner] = decodeFunctionResult({ abi: precompileAbi, functionName: "getSubscriptionInfo", data: data! }) as unknown as [
      Record<string, unknown>,
      Address,
    ];
    return { ok: true as const, owner, sub, bytes: (data!.length - 2) / 2 };
  } catch (e) {
    let c: unknown = e;
    while (c && typeof c === "object" && !("data" in c) && "cause" in c) c = (c as { cause: unknown }).cause;
    return { ok: false as const, revert: (c as { data?: Hex })?.data ?? "?", message: errMsg(e) };
  }
}

/** Precompile SubscriptionCreated/Removed logs in a receipt. */
export function precompileEvents(r: TransactionReceipt) {
  const out: { eventName: string; args: Record<string, unknown> }[] = [];
  for (const l of r.logs) {
    if (getAddress(l.address) !== getAddress(REACTIVITY)) continue;
    try {
      out.push(decodeEventLog({ abi: precompileAbi, data: l.data, topics: l.topics }) as never);
    } catch {
      out.push({ eventName: "unknown", args: { topics: l.topics, data: l.data } });
    }
  }
  return out;
}

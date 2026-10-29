// 02: state reads addressed by block hash fail on Hideki, so Foundry's `forge script` and `cast run` cannot run.
// Read-only. Run: node 02-rpc-block-hash-reads.ts
import { heading, rpc } from "./lib.ts";

const BANK = "0x478769E1177C0773c43A593DCCc4Ad15F15F1394"; // dreamDEX MarginBank on Hideki
const GET_CREDIT_GRANTER = "0x6a5c0a70"; // MarginBank.getCreditGranter()

const latest = await rpc("eth_getBlockByNumber", ["latest", false], { quiet: true });
const number: string = latest.result.number;
const hash: string = latest.result.hash;
console.log(`block ${BigInt(number)} = ${hash}`);

const forms: [string, unknown][] = [
  ["hex number", number],
  ["bare block hash", hash],
  ["EIP-1898 {blockHash}", { blockHash: hash, requireCanonical: false }],
  ["EIP-1898 {blockNumber}", { blockNumber: number }],
];

const methods: [string, (block: unknown) => unknown[]][] = [
  ["eth_getBalance", (b) => [BANK, b]],
  ["eth_getTransactionCount", (b) => [BANK, b]],
  ["eth_getCode", (b) => [BANK, b]],
  ["eth_getStorageAt", (b) => [BANK, "0x0", b]],
  ["eth_call", (b) => [{ to: BANK, data: GET_CREDIT_GRANTER }, b]],
];

const table: Record<string, Record<string, string>> = {};
for (const [method, params] of methods) {
  heading(method);
  table[method] = {};
  for (const [label, block] of forms) {
    console.log(`${label}:`);
    const r = await rpc(method, params(block));
    table[method][label] = r.error ? `error ${r.error.code}: ${r.error.message}` : "ok";
  }
}

heading("summary (same block, four ways of naming it)");
console.table(table);

heading("historical reads by number do work (code one block before / at a contract's deploy block)");
const HUB = "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154"; // deployed in block 35024249
for (const n of [35024248n, 35024249n]) {
  const r = await rpc("eth_getCode", [HUB, `0x${n.toString(16)}`], { quiet: true });
  console.log(`eth_getCode at ${n}: ${String(r.result).length > 2 ? `${(String(r.result).length - 2) / 2} bytes` : r.result}`);
}

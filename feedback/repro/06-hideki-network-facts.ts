// 06: checks the Hideki facts the SDK docs state (block time, explorer, Multicall3) against the live network.
// Read-only. Run: node 06-hideki-network-facts.ts
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { heading, rpc } from "./lib.ts";

heading("SDK chain definition");
console.log({ id: hidekiTestnet.id, blockTime: hidekiTestnet.blockTime, blockExplorers: hidekiTestnet.blockExplorers ?? null, multicall3: hidekiTestnet.contracts?.multicall3 });

heading(`block time from block timestamps (seconds), ${new Date().toISOString()}`);
const head = BigInt((await rpc("eth_blockNumber", [], { quiet: true })).result);
const ts = async (n: bigint) => BigInt((await rpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, false], { quiet: true })).result.timestamp);
const tHead = await ts(head);
for (const span of [1_000n, 100_000n, 864_000n, head - 1n]) {
  const seconds = tHead - (await ts(head - span));
  console.log(`${span} blocks before ${head}: ${seconds} s  ->  ${Number((seconds * 1_000_000n) / span) / 1000} ms per block`);
}

heading("block time by wall clock (20 s)");
const t0 = performance.now();
const b0 = BigInt((await rpc("eth_blockNumber", [], { quiet: true })).result);
await new Promise((r) => setTimeout(r, 20_000));
const b1 = BigInt((await rpc("eth_blockNumber", [], { quiet: true })).result);
const seconds = (performance.now() - t0) / 1000;
console.log(`${new Date().toISOString()}: ${b1 - b0} blocks in ${seconds.toFixed(2)} s -> ${((seconds * 1000) / Number(b1 - b0)).toFixed(1)} ms per block`);

heading("the Tokyo explorer serves this chain and reports the same cadence");
const stats = (await (await fetch("https://explorer.testnet.somnia.network/tokyo/api/v2/stats")).json()) as Record<string, unknown>;
console.log({ total_blocks: stats.total_blocks, average_block_time_ms: stats.average_block_time });

heading("Multicall3 at the canonical address");
const code = (await rpc("eth_getCode", ["0xcA11bde05977b3631167028862bE2a173976CA11", "latest"], { quiet: true })).result as string;
console.log(`code at 0xcA11bde05977b3631167028862bE2a173976CA11: ${(code.length - 2) / 2} bytes`);
const blockNumber = await rpc("eth_call", [{ to: "0xcA11bde05977b3631167028862bE2a173976CA11", data: "0x42cbb15c" }, "latest"], { quiet: true }); // getBlockNumber()
console.log(`Multicall3.getBlockNumber() -> ${BigInt(blockNumber.result)}`);

heading("the non-canonical address the Chains page names for Hideki");
console.log("eth_getCode(0x540B091b608f54E603c5dC19F6b2d955e1d2D131):");
await rpc("eth_getCode", ["0x540B091b608f54E603c5dC19F6b2d955e1d2D131", "latest"]);

// Records what the /copy page reads for a few real transactions on Hideki2, for test/copy.test.ts.
// Reads only. usage: node scripts/record-copy-fixtures.mjs   (writes test/fixtures/copies.json)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, decodeFunctionData, http, parseAbi } from "viem";

const RPC = "https://api.hideki2.infra.testnet.somnia.network";
const root = new URL("../../", import.meta.url);
const hideki = JSON.parse(readFileSync(new URL("deployments/hideki.json", root), "utf8"));
const client = createPublicClient({ transport: http(RPC, { retryCount: 3 }) });
const onEvent = parseAbi(["function onEvent(address emitter, bytes32[] eventTopics, bytes data)"]);

const TXS = {
  // the landing's same-block pair: the demo leader opens BTC (tx #0), the copy lands as tx #22
  traderCopy: "0xd012c9ad808025ba8ff880bde67e6972b661b3824e839754bb8681cc1b878cbc",
  // thesis #1 rebalanced 50/50 → 70/30 (tx #5); one copy transaction resized both legs (tx #6)
  thesisCopy: "0xd457cf3abe3c3ecf50aa76bb478143aaed88ea3460111a71b80c019692c1c114",
  // a follow of thesis #1 that opened both legs in the follow transaction itself
  followCopy: "0x9ba45cff499cf822453b385cba8a0b1286c1ec06a43a9abac360e23af19ecd3e",
  // the leader's own trade: no Copied in it
  leaderTrade: "0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d",
};

const big = (v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);
const safe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => big(x)));
const rawLog = (l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, transactionIndex: l.transactionIndex, logIndex: l.logIndex });

const out = { recordedAt: new Date().toISOString(), rpc: RPC, deployments: { hub: hideki.hub, themes: hideki.themes, marginBank: hideki.marginBank }, txs: {} };
for (const [name, hash] of Object.entries(TXS)) {
  const [r, t] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
  const block = await client.getBlock({ blockNumber: r.blockNumber });
  const entry = {
    hash,
    receipt: { blockNumber: r.blockNumber, transactionIndex: r.transactionIndex, status: r.status, logs: r.logs.map(rawLog) },
    tx: { from: t.from, to: t.to, input: t.input },
    blockTime: Number(block.timestamp),
    logs: [],
  };
  // a handler's transaction carries the event it answers: the page looks for that log in the same block
  if (t.to && t.input.startsWith("0x53edf33d")) {
    const { args } = decodeFunctionData({ abi: onEvent, data: t.input });
    const [emitter, topics] = args;
    const result = await client.getLogs({ address: emitter, fromBlock: r.blockNumber, toBlock: r.blockNumber, topics: [...topics] }).catch(() => client.request({ method: "eth_getLogs", params: [{ address: emitter, fromBlock: `0x${r.blockNumber.toString(16)}`, toBlock: `0x${r.blockNumber.toString(16)}`, topics }] }));
    entry.logs.push({ query: { block: r.blockNumber, address: emitter, topics }, result: result.map(rawLog) });
  }
  out.txs[name] = safe(entry);
  console.log(name, r.blockNumber, r.transactionIndex, entry.logs.length ? `${entry.logs[0].result.length} trigger log(s)` : "");
}
mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });
writeFileSync(new URL("../test/fixtures/copies.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");

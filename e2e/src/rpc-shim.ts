// Local JSON-RPC shim so `forge script` can run against Hideki. The node keeps no historical state: a state
// read pinned to a block number fails ("unable to load historical state"), and EIP-1898 block objects are
// rejected outright. It also answers eth_getStorageAt for an empty slot with "0x". The shim reads state at
// "latest" and pads empty storage words.
// Usage: tsx src/rpc-shim.ts [port]  ->  forge script ... --rpc-url http://127.0.0.1:<port>
import { createServer } from "node:http";

const RPC_URL = process.env.HIDEKI_RPC ?? "https://api.hideki2.infra.testnet.somnia.network";
const port = Number(process.argv[2] ?? 8547);

type Req = { id: unknown; method: string; params?: unknown[] };

/** Position of the block tag in each state read. */
const BLOCK_ARG: Record<string, number> = {
  eth_getBalance: 1,
  eth_getTransactionCount: 1,
  eth_getCode: 1,
  eth_getStorageAt: 2,
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getProof: 2,
};

function fixParams(req: Req): unknown[] {
  const params = [...(req.params ?? [])];
  const i = BLOCK_ARG[req.method];
  if (i !== undefined && params.length > i) params[i] = "latest";
  return params;
}

function fixResult(req: Req | undefined, res: { result?: unknown }) {
  if (req?.method === "eth_getStorageAt" && res.result === "0x") res.result = `0x${"0".repeat(64)}`;
  return res;
}

async function forward(body: Req | Req[]) {
  const reqs = Array.isArray(body) ? body : [body];
  const fixed = reqs.map((r) => ({ ...r, params: fixParams(r) }));
  const resp = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Array.isArray(body) ? fixed : fixed[0]),
  });
  const json = (await resp.json()) as { id?: unknown; result?: unknown } | { id?: unknown; result?: unknown }[];
  if (!Array.isArray(json)) return fixResult(reqs[0], json);
  const byId = new Map(reqs.map((r) => [JSON.stringify(r.id), r]));
  return json.map((j) => fixResult(byId.get(JSON.stringify(j.id)), j));
}

createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    try {
      const out = await forward(JSON.parse(data));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: String(e) } }));
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`rpc shim on http://127.0.0.1:${port} -> ${RPC_URL}`));

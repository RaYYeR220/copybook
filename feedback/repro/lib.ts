// Shared helpers for the reproductions. Public endpoints only; nothing here needs a key.

export const RPC = process.env.HIDEKI_RPC ?? "https://api.hideki2.infra.testnet.somnia.network";
export const INDEXER = process.env.HIDEKI_INDEXER ?? "https://hideki-dev.smk.somnia.host/v1/graphql";

export type RpcResponse = {
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One JSON-RPC call; prints the exact request and response. */
export async function rpc(method: string, params: unknown[], opts: { url?: string; quiet?: boolean } = {}): Promise<RpcResponse> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(opts.url ?? RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
  const text = await res.text();
  if (!opts.quiet) console.log(`  -> ${clip(body)}\n  <- ${clip(text)}`);
  return JSON.parse(text) as RpcResponse;
}

/** One GraphQL query against the Hideki indexer; returns the parsed body and the wall time. */
export async function gql(query: string): Promise<{ body: any; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  return { body, ms: Math.round(performance.now() - t0) };
}

export function heading(text: string) {
  console.log(`\n## ${text}`);
}

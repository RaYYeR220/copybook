import { afterEach, describe, expect, it } from "vitest";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { WebSocketServer, type WebSocket } from "ws";
import { somniaWatchTransport } from "../src/watch.ts";

/** A local node that speaks just enough JSON-RPC for somnia_watch: subscribe, unsubscribe, and a socket we can cut. */
function node(opts: { answerUnsubscribe?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const sockets: WebSocket[] = [];
  const calls: string[] = [];
  let n = 0;
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] };
      calls.push(`${sockets.indexOf(ws)}:${msg.method}`);
      if (msg.method === "eth_subscribe") ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: `0x${(++n).toString(16)}` }));
      if (msg.method === "eth_unsubscribe" && opts.answerUnsubscribe !== false) ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
    });
  });
  const port = () => (wss.address() as { port: number }).port;
  return { wss, sockets, calls, url: () => `ws://127.0.0.1:${port()}`, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await wait(10);
  return ok();
};
const publicClient = createPublicClient({ transport: http("http://127.0.0.1:1") }) as PublicClient;
const ADDR = ["0x00000000000000000000000000000000000000aa" as Address];

let server: ReturnType<typeof node> | undefined;
afterEach(async () => {
  for (const s of server?.sockets ?? []) s.terminate();
  await server?.close();
  server = undefined;
});

describe("somniaWatchTransport (real sockets)", () => {
  it("after the socket dies, the next subscription gets a new socket and is answered", async () => {
    server = node();
    const t = somniaWatchTransport(publicClient, server.url());
    let closed = 0;
    await t.subscribe({ addresses: ADDR, onTick: () => {}, onClose: () => void closed++ });
    expect(server.sockets).toHaveLength(1);

    server.sockets[0]!.terminate(); // the node drops the connection
    expect(await until(() => closed === 1)).toBe(true);

    const second = await t.subscribe({ addresses: ADDR, onTick: () => {}, onClose: () => {} });
    expect(server.sockets).toHaveLength(2); // a fresh client, not the dead one
    expect(server.calls).toContain("1:eth_subscribe");
    await second.close();
  });

  it("two subscriptions never share a socket", async () => {
    server = node();
    const t = somniaWatchTransport(publicClient, server.url());
    const a = await t.subscribe({ addresses: ADDR, onTick: () => {}, onClose: () => {} });
    const b = await t.subscribe({ addresses: ADDR, onTick: () => {}, onClose: () => {} });
    expect(server.sockets).toHaveLength(2);
    // closing one leaves the other's socket open
    await a.close();
    expect(await until(() => server!.sockets[0]!.readyState !== 1)).toBe(true);
    expect(server.sockets[1]!.readyState).toBe(1);
    await b.close();
  });

  it("closing does not wait on a node that never confirms the unsubscribe", async () => {
    server = node({ answerUnsubscribe: false });
    const t = somniaWatchTransport(publicClient, server.url());
    const sub = await t.subscribe({ addresses: ADDR, onTick: () => {}, onClose: () => {} });
    const t0 = Date.now();
    await sub.close();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(4_000);
    expect(await until(() => server!.sockets[0]!.readyState !== 1)).toBe(true);
  });
});

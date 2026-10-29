// The proof ledger's checks, against transactions recorded from Hideki (test/fixtures/hideki-txs.json holds the raw
// RPC answers). COPYBOOK_LIVE=1 adds the same checks against the live RPC.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAINS,
  checkAnchoredKey,
  checkPair,
  checkClaims,
  checkPreRegistration,
  headingAnchors,
  httpRpc,
  runLedger,
  verifyTx,
  type Expect,
  type Sources,
  type RpcClient,
  type Verification,
} from "../src/proof-ledger.ts";
import { renderProof, type ProofInput } from "../src/proof-render.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/hideki-txs.json", import.meta.url), "utf8")) as {
  txs: Record<string, unknown>;
  receipts: Record<string, unknown>;
};

const HUB = "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154";
const LEADER = "0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d";
const FOLLOWER = "0xDe52dd7f81F67D2124ae0fBd8567f405cFAEeaAB";
const BTC = "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0";
const RELAY = "0xEFf35D485c4559D9f44e5138B38Cd93052f2E7BF";
/** The leader's trade and the hub's copy, both in block 35,977,607 (positions 4 and 7). */
const MOVE = "0x020ad2ecfc395d95691ec72ab275e61a7a8d50ead2978b249773eba2d98a17c6" as const;
const COPY = "0x9b950e40fe79338890174ef0e9d4ed7cc2bf5733e6d1df04b049f74b916e9e3c" as const;
/** Someone else's transaction that reverted on Hideki (block 36,202,007). */
const REVERTED = "0x70c8cc6135858aa478a953435999b875dcdada2a07e102ded84fbf7062b455bd" as const;
const MISSING = `0x${"ab".repeat(32)}` as const;
/** The hub's handler refusing the follower's 1000PEPE increase: no fill inside its 5 bps band (block 35,025,975). */
const REFUSAL = "0xc97ecbd7710b42ac60f5321333cd95a6a3fb369c38c9ebe8986751840bdcffcb" as const;

const moveExpect: Expect = { block: 35977607, index: 4, from: LEADER, to: BTC, method: "placeOrder", gasUsed: 1770144 };
const copyExpect: Expect = {
  block: 35977607,
  index: 7,
  from: HUB,
  to: RELAY,
  method: "onEvent",
  gasUsed: 2304508,
  events: [
    { name: "Copied", args: { follower: FOLLOWER, pool: BTC, fromSize: "15000", toSize: "28000" } },
    { name: "TankCharged", args: { follower: FOLLOWER } },
  ],
};

/** Answers from the fixture; `failures` makes the first N calls throw like a flaky node. */
function fixtureRpc(failures = 0): RpcClient & { calls: number } {
  const rpc = {
    calls: 0,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      rpc.calls++;
      if (rpc.calls <= failures) throw new Error("RPC Request failed");
      const hash = String((params ?? [])[0]).toLowerCase();
      if (method === "eth_chainId") return "0xc4cf"; // 50383
      if (method === "eth_blockNumber") return "0x2280000";
      if (method === "eth_getTransactionByHash") return fx.txs[hash] ?? null;
      if (method === "eth_getTransactionReceipt") return fx.receipts[hash] ?? null;
      throw new Error(`unexpected ${method}`);
    },
  };
  return rpc;
}
const fast = { attempts: 3, delayMs: 0, notFoundRetries: 1 };
const spec = (hash: `0x${string}`, expect?: Expect) => ({ hash, chain: "hideki" as const, label: "t", expect });

describe("verifyTx", () => {
  it("verifies the same-block pair recorded in the app run: the leader's trade and the hub's copy", async () => {
    const move = await verifyTx(fixtureRpc(), spec(MOVE, moveExpect), fast);
    const copy = await verifyTx(fixtureRpc(), spec(COPY, copyExpect), fast);
    assert.equal(move.ok, true, move.reason);
    assert.equal(copy.ok, true, copy.reason);
    assert.deepEqual([move.outcome, move.status, move.block, move.index], ["verified", "success", 35977607, 4]);
    assert.deepEqual([copy.block, copy.index], [35977607, 7]);
    assert.deepEqual(checkPair(move.facts!, copy.facts!, HUB), []);
  });

  it("decodes what the copy did from the hub's events", async () => {
    const copy = await verifyTx(fixtureRpc(), spec(COPY), fast);
    const copied = copy.facts!.events.find((e) => e.name === "Copied")!;
    assert.equal(copied.args.fromSize, "15000");
    assert.equal(copied.args.toSize, "28000");
    assert.equal(copied.address.toLowerCase(), HUB.toLowerCase());
    assert.equal(copy.facts!.method, "onEvent");
  });

  it("fails a wrong block with a reason that names both blocks", async () => {
    const r = await verifyTx(fixtureRpc(), spec(MOVE, { ...moveExpect, block: 35977608 }), fast);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "failed");
    assert.match(r.reason!, /block 35977607, expected 35977608/);
  });

  it("fails a wrong position, sender, target, function or gas", async () => {
    for (const [patch, pattern] of [
      [{ index: 5 }, /position 4, expected 5/],
      [{ from: HUB }, /sent by 0xa1d0/i],
      [{ to: RELAY }, /to 0x4181/i],
      [{ method: "follow" }, /calls placeOrder, expected follow/],
      [{ gasUsed: 1 }, /gas 1770144, expected 1/],
    ] as const) {
      const r = await verifyTx(fixtureRpc(), spec(MOVE, { ...moveExpect, ...patch }), fast);
      assert.equal(r.outcome, "failed", JSON.stringify(patch));
      assert.match(r.reason!, pattern);
    }
  });

  it("fails when an expected event is missing or a forbidden one is there", async () => {
    const wrong = await verifyTx(fixtureRpc(), spec(COPY, { events: [{ name: "Refused", args: { reason: "BandUnfilled" } }] }), fast);
    assert.equal(wrong.outcome, "failed");
    assert.match(wrong.reason!, /no Refused/);
    const size = await verifyTx(fixtureRpc(), spec(COPY, { events: [{ name: "Copied", args: { toSize: "1" } }] }), fast);
    assert.match(size.reason!, /no Copied with toSize=1/);
    const forbidden = await verifyTx(fixtureRpc(), spec(COPY, { noEvents: ["Copied"] }), fast);
    assert.match(forbidden.reason!, /emits Copied/);
  });

  it("reads a refusal's reason from the hub's Refused event, and fails a wrong one", async () => {
    const band = { name: "Refused", args: { pool: "0xfA9B9e50CC1745113d57893991aF200a74c86B6f", reason: "BandUnfilled", venueError: "0xc04ad919" } };
    const ok = await verifyTx(fixtureRpc(), spec(REFUSAL, { block: 35025975, index: 5, from: HUB, events: [band], noEvents: ["Copied"] }), fast);
    assert.equal(ok.outcome, "verified", ok.reason);
    const wrong = await verifyTx(fixtureRpc(), spec(REFUSAL, { events: [{ name: "Refused", args: { reason: "TotalCap" } }] }), fast);
    assert.equal(wrong.outcome, "failed");
    assert.match(wrong.reason!, /no Refused with reason=TotalCap/);
  });

  it("flags a reverted transaction", async () => {
    const r = await verifyTx(fixtureRpc(), spec(REVERTED), fast);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "failed");
    assert.equal(r.status, "reverted");
    assert.match(r.reason!, /reverted/);
    assert.equal(r.block, 36202007);
  });

  it("fails a hash the chain does not have", async () => {
    const r = await verifyTx(fixtureRpc(), spec(MISSING), fast);
    assert.equal(r.outcome, "failed");
    assert.match(r.reason!, /not found on hideki \(chain 50383\)/);
  });

  it("reports an RPC that keeps failing as unverified, never as failed", async () => {
    const rpc = fixtureRpc(Number.POSITIVE_INFINITY);
    const r: Verification = await verifyTx(rpc, spec(MOVE, moveExpect), fast);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unverified");
    assert.match(r.reason!, /RPC/);
    assert.equal(rpc.calls, 3); // every attempt was made
  });

  it("retries a transient RPC failure and then verifies", async () => {
    const r = await verifyTx(fixtureRpc(2), spec(MOVE, moveExpect), fast);
    assert.equal(r.outcome, "verified", r.reason);
  });
});

describe("checkPair", () => {
  it("passes only a copy sent by the hub after the move, in the move's block", async () => {
    const move = (await verifyTx(fixtureRpc(), spec(MOVE), fast)).facts!;
    const copy = (await verifyTx(fixtureRpc(), spec(COPY), fast)).facts!;
    assert.deepEqual(checkPair(move, copy, HUB), []);
    assert.match(checkPair(move, { ...copy, block: copy.block + 1 }, HUB).join(), /copy in block 35977608, move in block 35977607/);
    assert.match(checkPair(move, { ...copy, index: 3 }, HUB).join(), /copy at position 3 is not after the move at 4/);
    assert.match(checkPair(move, copy, LEADER).join(), /copy sent by 0xdf73/i);
  });
});

describe("checkPreRegistration", () => {
  it("passes an answer key anchored before every review of its run, and fails one anchored after any", () => {
    assert.equal(checkPreRegistration(100, [101, 150, 200]), undefined);
    assert.match(checkPreRegistration(100, [150, 100, 99])!, /2 review request\(s\) at or before the anchor's block 100 \(first at 99\)/);
    assert.match(checkPreRegistration(100, [])!, /no review requests/);
  });
});

describe("checkAnchoredKey", () => {
  const commit = "a7c42c247a038b65d502826df7dc703a4cdcaa9a";
  const key = new TextEncoder().encode('{"run":"v4"}\n');
  // a hash no key file has
  const hash = "0x" + "0".repeat(64);
  it("verifies an anchor whose input is the commit followed by the keccak256 of the key as committed", async () => {
    const { keccak256 } = await import("viem");
    const data = `0x${commit}${keccak256(key).slice(2)}`;
    const ok = checkAnchoredKey(data, commit, key);
    assert.equal(ok.outcome, "verified");
    assert.match(ok.note!, /as committed in a7c42c2 hashes to the anchored keccak256/);
    assert.equal(checkAnchoredKey(data.toUpperCase().replace("0X", "0x"), commit, key).outcome, "verified");
  });
  it("fails a different key, a different commit or a malformed commit", async () => {
    const { keccak256 } = await import("viem");
    const data = `0x${commit}${keccak256(key).slice(2)}`;
    assert.equal(checkAnchoredKey(data, commit, new TextEncoder().encode('{"run":"v5"}\n')).outcome, "failed");
    assert.equal(checkAnchoredKey(`0x${commit}${hash.slice(2)}`, commit, key).outcome, "failed");
    assert.equal(checkAnchoredKey(data, "5aed53bf2c556d82874cd537cd559f09d51b3d67", key).outcome, "failed");
    assert.match(checkAnchoredKey(data, "a7c42c2", key).reason!, /no full commit hash/);
  });
  it("reports unverified, not failed, when git cannot show the key", () => {
    const r = checkAnchoredKey(`0x${commit}${hash.slice(2)}`, commit, undefined, "spawn git ENOENT");
    assert.equal(r.outcome, "unverified");
    assert.match(r.reason!, /could not be read: spawn git ENOENT/);
  });
});

describe("checkClaims", () => {
  const files: Record<string, string> = {
    "docs/PROOF.md": [
      "# Proof ledger",
      "",
      "## Same-block copies",
      "",
      '| <a id="app-live"></a>x |',
      "",
      "```sh",
      "# not a heading",
      "```",
      "## Gas",
      "## Gas",
    ].join("\n"),
    "eval/SCORECARD.md": "## Run v3: the rubric, and only the keys it reads\n### Result\n",
    "contracts/test/HubFollow.t.sol": "function test_secondFollow_reverts() public {}",
    "app/test/tape.test.ts": 'it("a copy someone sent directly never claims the same block", () => {});',
  };
  const read = (rel: string) => files[rel];

  it("finds GitHub's heading anchors and explicit ones, outside code", () => {
    const a = headingAnchors(files["docs/PROOF.md"]);
    assert.ok(a.has("same-block-copies") && a.has("app-live") && a.has("gas") && a.has("gas-1"));
    assert.ok(!a.has("not-a-heading"));
    assert.ok(headingAnchors(files["eval/SCORECARD.md"]).has("run-v3-the-rubric-and-only-the-keys-it-reads"));
  });

  it("passes links and tests that exist, and names each one that does not", () => {
    const good = "[a](PROOF.md#app-live) [b](../eval/SCORECARD.md#result) `contracts/test/HubFollow.t.sol::test_secondFollow_reverts` `app/test/tape.test.ts::a copy someone sent directly never claims the same block`";
    assert.deepEqual(checkClaims(good, read), []);
    const bad = checkClaims(
      "[a](PROOF.md#nope) [b](MISSING.md) `contracts/test/HubFollow.t.sol::test_gone` `::test_secondFollow_reverts` `app/lib/gone.ts` `app/test/tape.test.ts::a copy someone sent`",
      read,
    );
    assert.deepEqual(bad, [
      "links to MISSING.md, which does not exist",
      "links to PROOF.md#nope, which has no such anchor",
      "cites contracts/test/HubFollow.t.sol::test_gone, which is not a test there",
      "names app/lib/gone.ts, which does not exist",
      "cites app/test/tape.test.ts::a copy someone sent, which is not a test there", // a test's title in full, not a piece of it
    ]);
  });
});

describe("runLedger (the CLI's exit code)", () => {
  const shannon: RpcClient = {
    async request({ method }) {
      if (method === "eth_chainId") return "0xc488"; // 50312
      if (method === "eth_blockNumber") return "0x1f6a0000";
      throw new Error(`unexpected ${method}`);
    },
  };
  const sources = (move: Expect): Sources => ({
    about: "",
    runs: {},
    markets: {},
    contracts: [],
    gas: [],
    guard: { exampleNonce: 0 },
    rows: [
      { id: "m", section: "same-block", pair: "p", role: "move", chain: "hideki", hash: MOVE, label: "move", expect: move },
      { id: "c", section: "same-block", pair: "p", role: "copy", chain: "hideki", hash: COPY, label: "copy", expect: copyExpect },
    ],
  });
  const run = async (hideki: RpcClient, move: Expect, writeAnyway = false) => {
    const out = join(mkdtempSync(join(tmpdir(), "proof-")), "PROOF.md");
    const lines: string[] = [];
    const code = await runLedger({
      clients: { hideki, shannon },
      sources: sources(move),
      sweep: false,
      claims: null,
      out,
      writeAnyway,
      retry: { attempts: 2, delayMs: 0, notFoundRetries: 0 },
      log: (l) => lines.push(l),
    });
    return { code, out, lines, written: existsSync(out) };
  };
  /** Answers the chain id and head, and fails every transaction read. */
  const txReadsFail: RpcClient = {
    async request({ method }) {
      if (method === "eth_chainId") return "0xc4cf";
      if (method === "eth_blockNumber") return "0x2280000";
      throw new Error("RPC Request failed");
    },
  };

  it("exits 0 and writes PROOF.md when every row verifies", async () => {
    const r = await run(fixtureRpc(), moveExpect);
    assert.equal(r.code, 0);
    assert.equal(r.written, true);
    assert.match(readFileSync(r.out, "utf8"), /2 transactions checked: 2 verified, 0 failed, 0 unverified/);
  });

  it("exits 1 on a failed row and leaves PROOF.md alone unless asked to write it anyway", async () => {
    const r = await run(fixtureRpc(), { ...moveExpect, block: 1 });
    assert.equal(r.code, 1);
    assert.equal(r.written, false);
    assert.ok(r.lines.some((l) => /not written \(exit 1\)/.test(l)));
    const anyway = await run(fixtureRpc(), { ...moveExpect, block: 1 }, true);
    assert.equal(anyway.code, 1);
    assert.match(readFileSync(anyway.out, "utf8"), /\*\*FAILED\*\*: block 35977607, expected 1/);
  });

  it("exits 2 when the RPC keeps failing on the transactions, and writes nothing", async () => {
    const r = await run(txReadsFail, moveExpect);
    assert.equal(r.code, 2);
    assert.equal(r.written, false);
  });

  it("exits 2, not 1, when the RPC does not answer the chain id or head before anything is checked", async () => {
    const down: RpcClient = { request: async () => Promise.reject(new Error("HTTP 503 from eth_chainId")) };
    const r = await run(down, moveExpect);
    assert.equal(r.code, 2);
    assert.equal(r.written, false);
    assert.ok(r.lines.some((l) => /^UNVERIFIED: Hideki's RPC/.test(l)));
  });

  it("exits 1 when the RPC is another chain", async () => {
    const wrong: RpcClient = { request: async ({ method }) => (method === "eth_chainId" ? "0x1" : "0x10") };
    const r = await run(wrong, moveExpect);
    assert.equal(r.code, 1);
    assert.ok(r.lines.some((l) => /is chain 1, not hideki \(50383\)/.test(l)));
  });
});

describe("httpRpc", () => {
  /** A local JSON-RPC endpoint that answers with `status` and `body`. */
  const serve = (status: number, body: string) =>
    new Promise<{ url: string; server: Server }>((ok) => {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(body);
        });
      }).listen(0, "127.0.0.1", () => {
        const addr = server.address();
        ok({ url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, server });
      });
    });

  it("throws on a non-200 answer and on a JSON-RPC error, and returns null for a null result", async () => {
    const down = await serve(503, "Service Unavailable");
    const rpcError = await serve(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } }));
    const empty = await serve(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
    try {
      await assert.rejects(httpRpc(down.url).request({ method: "eth_getTransactionByHash", params: [MOVE] }), /HTTP 503 from eth_getTransactionByHash/);
      await assert.rejects(httpRpc(rpcError.url).request({ method: "eth_blockNumber" }), /eth_blockNumber: -32000 header not found/);
      assert.equal(await httpRpc(empty.url).request({ method: "eth_getTransactionByHash", params: [MOVE] }), null);
      // through verifyTx: a node answering 503 leaves the row unverified; a node without the transaction fails it
      const flaky = await verifyTx(httpRpc(down.url), spec(MOVE), fast);
      assert.equal(flaky.outcome, "unverified");
      assert.match(flaky.reason!, /RPC: eth_getTransactionByHash failed 3 times: HTTP 503/);
      const missing = await verifyTx(httpRpc(empty.url), spec(MOVE), fast);
      assert.equal(missing.outcome, "failed");
    } finally {
      for (const x of [down, rpcError, empty]) x.server.close();
    }
  });
});

describe("renderProof", () => {
  it("states where and when it was generated, and marks failed and unverified rows", async () => {
    const ok = await verifyTx(fixtureRpc(), spec(MOVE, moveExpect), fast);
    const bad = await verifyTx(fixtureRpc(), spec(REVERTED), fast);
    const flaky = await verifyTx(fixtureRpc(Number.POSITIVE_INFINITY), spec(COPY), fast);
    const row = (id: string, hash: `0x${string}`, result: Verification) => ({
      id,
      section: "other" as const,
      chain: "hideki" as const,
      label: id,
      hash,
      result,
    });
    const input: ProofInput = {
      generatedAt: "2026-10-29T12:00:00.000Z",
      heads: { hideki: 36200000, shannon: 527000000 },
      rows: [row("good", MOVE, ok), row("bad", REVERTED, bad), row("flaky", COPY, flaky)],
      pairs: [],
      contracts: [],
      reviews: [],
      gas: [],
      context: { runs: {}, markets: {}, wallets: {}, hub: HUB },
    };
    const md = renderProof(input);
    assert.match(md, /^# Proof ledger/);
    assert.match(md, /Hideki block 36,200,000/);
    assert.match(md, /Shannon block 527,000,000/);
    assert.match(md, /2026-10-29 12:00 UTC/);
    assert.match(md, /3 transactions checked: 1 verified, 1 failed, 1 unverified/);
    assert.match(md, /\*\*FAILED\*\*: reverted/);
    assert.match(md, /unverified \(RPC\)/);
    assert.match(md, new RegExp(`${CHAINS.hideki.explorerTx}${MOVE}`));
  });
});

describe("live (COPYBOOK_LIVE=1)", { skip: process.env.COPYBOOK_LIVE !== "1" }, () => {
  it("verifies the same pair against Hideki's RPC", async () => {
    const rpc = httpRpc(CHAINS.hideki.rpc);
    const move = await verifyTx(rpc, spec(MOVE, moveExpect));
    const copy = await verifyTx(rpc, spec(COPY, copyExpect));
    assert.equal(move.outcome, "verified", move.reason);
    assert.equal(copy.outcome, "verified", copy.reason);
    assert.deepEqual(checkPair(move.facts!, copy.facts!, HUB), []);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Address, type Hex } from "viem";
import {
  ceiling,
  decide,
  delayMs,
  foreign,
  nextState,
  tick,
  type BotClient,
  type BotConfig,
  type BotMarket,
  type Fill,
  type Log,
  type RunRecord,
  type Snapshot,
  type Sym,
} from "../src/leader-bot.ts";

const BTC: BotMarket = { symbol: "BTC", pool: "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0", minQty: 13_000n, lot: 1_000n };
const ETH: BotMarket = { symbol: "ETH", pool: "0xD6Cb1DD58580B84D76068aC21594219ce03aeddf", minQty: 4_000_000_000_000_000n, lot: 100_000_000_000_000n };
const CFG: BotConfig = { minStt: parseEther("0.25"), minEquity: parseEther("5"), ethShare: 0.25 };
const NOW = Date.parse("2026-11-01T12:00:00Z");

const snap = (p: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  stt: parseEther("10"),
  equity: parseEther("25"),
  markets: [BTC, ETH],
  positions: { BTC: 0n, ETH: 0n },
  ...p,
});
/** A random source that hands out `xs` in order, then 0.9. */
const seq = (...xs: number[]) => () => (xs.length ? xs.shift()! : 0.9);

test("flat: opens a minimum-size BTC long", () => {
  const a = decide(snap(), CFG, seq(0.9, 0.1));
  assert.equal(a.kind, "open");
  assert.ok(a.kind === "open");
  assert.equal(a.symbol, "BTC");
  assert.equal(a.isBid, true);
  assert.equal(a.qty, BTC.minQty);
});

test("open size is the minimum or twice it, on the lot grid", () => {
  const a = decide(snap(), CFG, seq(0.9, 0.7));
  assert.ok(a.kind === "open");
  assert.equal(a.qty, 2n * BTC.minQty);
  assert.equal(a.qty % BTC.lot, 0n);
});

test("about one open in four goes to ETH", () => {
  const a = decide(snap(), CFG, seq(0.1, 0.1));
  assert.ok(a.kind === "open");
  assert.equal(a.symbol, "ETH");
  assert.equal(a.qty, ETH.minQty);
});

test("a long the bot opened is closed with a sell of its whole size", () => {
  const a = decide(snap({ positions: { BTC: 26_000n, ETH: 0n } }), CFG, seq());
  assert.ok(a.kind === "close");
  assert.equal(a.symbol, "BTC");
  assert.equal(a.isBid, false);
  assert.equal(a.qty, 26_000n);
});

test("a short is closed with a buy", () => {
  const a = decide(snap({ positions: { BTC: 0n, ETH: -ETH.minQty } }), CFG, seq());
  assert.ok(a.kind === "close");
  assert.equal(a.symbol, "ETH");
  assert.equal(a.isBid, true);
  assert.equal(a.qty, ETH.minQty);
});

test("with a position open it never opens or adds anywhere", () => {
  for (const r of [0.01, 0.3, 0.6, 0.99]) {
    const a = decide(snap({ positions: { BTC: 13_000n, ETH: 0n } }), CFG, seq(r, r));
    assert.equal(a.kind, "close");
  }
});

test("low gas skips every trade, a close included", () => {
  const low = parseEther("0.2");
  assert.deepEqual(
    [decide(snap({ stt: low }), CFG, seq()).kind, decide(snap({ stt: low, positions: { BTC: 13_000n } }), CFG, seq()).kind],
    ["skip", "skip"],
  );
  const a = decide(snap({ stt: low }), CFG, seq());
  assert.ok(a.kind === "skip");
  assert.equal(a.reason, "low-gas");
});

test("low equity skips an open but still closes", () => {
  const poor = parseEther("4");
  const a = decide(snap({ equity: poor }), CFG, seq());
  assert.ok(a.kind === "skip");
  assert.equal(a.reason, "low-equity");
  assert.equal(decide(snap({ equity: poor, positions: { BTC: 13_000n } }), CFG, seq()).kind, "close");
});

test("a position bigger than the bot opens is left alone; the bot trades the flat market", () => {
  const s = snap({ positions: { BTC: 500_000n, ETH: 0n } });
  assert.deepEqual(foreign(s).map((m) => m.symbol), ["BTC"]);
  const a = decide(s, CFG, seq(0.9, 0.1));
  assert.ok(a.kind === "open");
  assert.equal(a.symbol, "ETH");
  const both = snap({ positions: { BTC: 500_000n, ETH: -10n * ETH.minQty } });
  const b = decide(both, CFG, seq());
  assert.ok(b.kind === "skip");
  assert.equal(b.reason, "no-flat-market");
});

test("a residue under the venue minimum gets the minimum added on its side, within the ceiling", () => {
  const a = decide(snap({ positions: { BTC: 4_000n, ETH: 0n } }), CFG, seq());
  assert.ok(a.kind === "dust");
  assert.equal(a.isBid, true);
  assert.equal(a.qty, BTC.minQty);
  assert.ok(4_000n + a.qty <= ceiling(BTC));
  const s = decide(snap({ positions: { BTC: -4_000n, ETH: 0n } }), CFG, seq());
  assert.ok(s.kind === "dust");
  assert.equal(s.isBid, false);
});

test("after `until` it only closes", () => {
  const cfg = { ...CFG, until: NOW - 1 };
  const a = decide(snap(), cfg, seq());
  assert.ok(a.kind === "skip");
  assert.equal(a.reason, "ended");
  assert.equal(decide(snap({ positions: { BTC: 13_000n } }), cfg, seq()).kind, "close");
});

test("next tick: at once without a previous run, else the interval within the jitter", () => {
  const cfg = { intervalMin: 25, jitterMin: 4 };
  assert.equal(delayMs(undefined, NOW, cfg, seq()), 0);
  const last = new Date(NOW - 5 * 60_000).toISOString();
  assert.equal(delayMs(last, NOW, cfg, seq(0)), 16 * 60_000);
  assert.equal(delayMs(last, NOW, cfg, seq(1)), 24 * 60_000);
  assert.equal(delayMs(new Date(NOW - 60 * 60_000).toISOString(), NOW, cfg, seq(0.5)), 0);
});

// ---------------------------------------------------------------- tick with a fake chain

class FakeChain implements BotClient {
  positions: Record<Sym, bigint> = { BTC: 0n, ETH: 0n };
  stt = parseEther("1");
  equity = parseEther("25");
  trades: { pool: Address; isBid: boolean; qty: bigint }[] = [];
  block = 100n;
  failTrade = false;
  failReaction = false;
  async snapshot(): Promise<Snapshot> {
    return { now: NOW, stt: this.stt, equity: this.equity, markets: [BTC, ETH], positions: { ...this.positions } };
  }
  async trade(pool: Address, isBid: boolean, qty: bigint): Promise<Fill> {
    if (this.failTrade) throw new Error("ImmediateOrCancelNoFill()");
    this.trades.push({ pool, isBid, qty });
    const sym: Sym = pool === BTC.pool ? "BTC" : "ETH";
    this.positions[sym] += isBid ? qty : -qty;
    this.stt -= parseEther("0.01");
    this.block += 25n;
    return { hash: `0x${this.block.toString(16).padStart(64, "0")}` as Hex, block: this.block, gasUsed: 1_600_000n };
  }
  async reaction() {
    if (this.failReaction) throw new Error("rpc down");
    return { copied: 1, refused: [], handlers: [] };
  }
}

const logs: { level: string; msg: string }[] = [];
const log: Log = (level, msg) => logs.push({ level, msg });

test("ticks alternate open and close, one position at a time", async () => {
  const c = new FakeChain();
  const kinds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await tick(c, CFG, seq(0.9, 0.1), log);
    assert.equal(r.ok, true);
    kinds.push(r.action);
    const open = Object.values(c.positions).filter((p) => p !== 0n).length;
    assert.ok(open <= 1, "never more than one open position");
  }
  assert.deepEqual(kinds, ["open", "close", "open", "close", "open", "close"]);
  assert.deepEqual(c.positions, { BTC: 0n, ETH: 0n });
  assert.ok(c.trades.every((t, i) => t.isBid === (i % 2 === 0)));
});

test("a tick records the transaction, its block and the hub's copies", async () => {
  const c = new FakeChain();
  const r = await tick(c, CFG, seq(0.9, 0.1), log);
  assert.equal(r.action, "open");
  assert.equal(r.side, "buy");
  assert.equal(r.qty, "13000");
  assert.equal(r.block, "125");
  assert.match(r.tx!, /^0x[0-9a-f]{64}$/);
  assert.ok(r.explorer!.endsWith(r.tx!));
  assert.equal(r.hub?.copied, 1);
});

test("low balance: no transaction, an error-level log", async () => {
  const c = new FakeChain();
  c.stt = parseEther("0.1");
  logs.length = 0;
  const r = await tick(c, CFG, seq(), log);
  assert.equal(r.action, "skip");
  assert.equal(r.reason, "low-gas");
  assert.equal(c.trades.length, 0);
  assert.equal(r.tx, undefined);
  assert.ok(logs.some((l) => l.level === "error" && l.msg.includes("low-gas")));

  const poor = new FakeChain();
  poor.equity = parseEther("1");
  const p = await tick(poor, CFG, seq(), log);
  assert.equal(p.reason, "low-equity");
  assert.equal(poor.trades.length, 0);
});

test("a failed trade is recorded, not thrown; an unreadable reaction keeps the trade", async () => {
  const c = new FakeChain();
  c.failTrade = true;
  const r = await tick(c, CFG, seq(), log);
  assert.equal(r.ok, false);
  assert.equal(r.action, "open");
  assert.match(r.error!, /ImmediateOrCancelNoFill/);

  const d = new FakeChain();
  d.failReaction = true;
  const ok = await tick(d, CFG, seq(), log);
  assert.equal(ok.ok, true);
  assert.ok(ok.tx);
  assert.equal(ok.hub, undefined);
});

test("the state file keeps the last trade across skips", () => {
  const trade: RunRecord = { at: "2026-11-01T12:00:00Z", ok: true, action: "open", tx: "0xab", block: "1" };
  const skip: RunRecord = { at: "2026-11-01T12:25:00Z", ok: true, action: "skip", reason: "low-gas" };
  const s1 = nextState(undefined, trade);
  assert.equal(s1.lastTrade?.tx, "0xab");
  const s2 = nextState(s1, skip);
  assert.equal(s2.action, "skip");
  assert.equal(s2.lastTrade?.tx, "0xab");
  assert.ok(!("lastTrade" in s2.lastTrade!), "the last trade does not nest an older one");
});

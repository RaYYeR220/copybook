// The demo leader bot: keeps the demo leader trading on Hideki so anyone who follows it sees the copies land in the
// leader's own block. About every 25 minutes the leader either opens a minimum-size long (BTC, now and then ETH) or
// closes the position the tick before opened. Low gas or low margin skips the tick instead of trading.
//
//   COPYBOOK_ENV=<env file with LEADER_PK> npm run leader-bot             runs until stopped
//   COPYBOOK_ENV=<env file with LEADER_PK> npm run leader-bot -- --once   one tick now, then exits
//
// Every tick prints one JSON line to stdout and writes out/last-run.json (LEADER_BOT_STATE moves it).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeAbiParameters, formatEther, getAddress, keccak256, parseAbi, parseEther, type Address, type Hex } from "viem";
import { account, markets, pub, EXPLORER_TX } from "./env.ts";
import { equity, market, placeIoc, size } from "./venue.ts";

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- decision

export type Sym = "BTC" | "ETH";
export type BotMarket = { symbol: Sym; pool: Address; minQty: bigint; lot: bigint };
export type Snapshot = {
  /** ms since the epoch */
  now: number;
  /** the leader's native balance (gas) */
  stt: bigint;
  /** the leader's perps equity in the margin bank */
  equity: bigint;
  markets: BotMarket[];
  /** the leader's signed position per symbol */
  positions: Partial<Record<Sym, bigint>>;
};
export type BotConfig = {
  minStt: bigint;
  minEquity: bigint;
  /** share of opens that go to ETH instead of BTC */
  ethShare: number;
  /** after this time (ms) the bot only closes */
  until?: number;
};
export type Trade = { kind: "open" | "close" | "dust"; symbol: Sym; pool: Address; isBid: boolean; qty: bigint; why: string };
export type Skip = { kind: "skip"; reason: "low-gas" | "low-equity" | "ended" | "no-flat-market"; why: string };
export type Action = Trade | Skip;

const abs = (x: bigint) => (x < 0n ? -x : x);
const roundUp = (x: bigint, lot: bigint) => ((x + lot - 1n) / lot) * lot;
const pos = (s: Snapshot, m: BotMarket) => s.positions[m.symbol] ?? 0n;

/** The largest position the bot opens on a market. A bigger one was opened by someone else and is left alone. */
export const ceiling = (m: BotMarket) => roundUp(2n * m.minQty, m.lot);

/** Markets holding a position larger than the bot ever opens. */
export function foreign(s: Snapshot): BotMarket[] {
  return s.markets.filter((m) => abs(pos(s, m)) > ceiling(m));
}

/**
 * One tick's move. A position the bot could have opened is closed; with none open, a minimum-size long opens on a
 * flat market. The bot never adds to a position, with one exception: a residue below the venue minimum (an IOC that
 * filled in part) can't be closed on its own, so the minimum is added on its side and the next tick closes it all.
 */
export function decide(s: Snapshot, cfg: BotConfig, rand: () => number): Action {
  if (s.stt < cfg.minStt) {
    return { kind: "skip", reason: "low-gas", why: `leader holds ${formatEther(s.stt)} STT, under ${formatEther(cfg.minStt)}` };
  }
  const ours = s.markets.filter((m) => pos(s, m) !== 0n && abs(pos(s, m)) <= ceiling(m));
  const closable = ours.find((m) => abs(pos(s, m)) >= m.minQty);
  if (closable) {
    const p = pos(s, closable);
    return { kind: "close", symbol: closable.symbol, pool: closable.pool, isBid: p < 0n, qty: abs(p), why: `closes ${p} ${closable.symbol}` };
  }
  if (cfg.until !== undefined && s.now >= cfg.until) {
    return { kind: "skip", reason: "ended", why: `past ${new Date(cfg.until).toISOString()}: closes only` };
  }
  if (s.equity < cfg.minEquity) {
    return { kind: "skip", reason: "low-equity", why: `leader equity ${formatEther(s.equity)} USDso, under ${formatEther(cfg.minEquity)}` };
  }
  const dust = ours[0];
  if (dust) {
    const p = pos(s, dust);
    return {
      kind: "dust",
      symbol: dust.symbol,
      pool: dust.pool,
      isBid: p > 0n,
      qty: dust.minQty,
      why: `residue ${p} ${dust.symbol} is under the venue minimum ${dust.minQty}: adds the minimum so the next close takes it all`,
    };
  }
  const flat = s.markets.filter((m) => pos(s, m) === 0n);
  if (!flat.length) return { kind: "skip", reason: "no-flat-market", why: "every market holds a position the bot did not open" };
  const want: Sym = rand() < cfg.ethShare ? "ETH" : "BTC";
  const m = flat.find((x) => x.symbol === want) ?? flat[0];
  const qty = roundUp(rand() < 0.5 ? m.minQty : 2n * m.minQty, m.lot);
  return { kind: "open", symbol: m.symbol, pool: m.pool, isBid: true, qty, why: `opens a ${qty} ${m.symbol} long` };
}

/** Milliseconds until the next tick: the interval plus or minus the jitter after the last one, at once if none. */
export function delayMs(lastAt: string | undefined, now: number, cfg: { intervalMin: number; jitterMin: number }, rand: () => number) {
  if (!lastAt) return 0;
  const last = Date.parse(lastAt);
  if (Number.isNaN(last)) return 0;
  const minutes = cfg.intervalMin + (2 * rand() - 1) * cfg.jitterMin;
  return Math.max(0, Math.round(last + minutes * 60_000 - now));
}

// ---------------------------------------------------------------- one tick

export type Fill = { hash: Hex; block: bigint; gasUsed: bigint };
export type Reaction = { copied: number; refused: { follower: Address; reason: string }[]; handlers: Hex[] };
export interface BotClient {
  snapshot(): Promise<Snapshot>;
  trade(pool: Address, isBid: boolean, qty: bigint): Promise<Fill>;
  /** The hub's copies of the leader in `block`. */
  reaction(block: bigint): Promise<Reaction>;
}

export type RunRecord = {
  at: string;
  ok: boolean;
  action: Action["kind"] | "error";
  reason?: Skip["reason"];
  why?: string;
  symbol?: Sym;
  side?: "buy" | "sell";
  qty?: string;
  tx?: Hex;
  block?: string;
  gasUsed?: string;
  explorer?: string;
  hub?: Reaction;
  stt?: string;
  equity?: string;
  positions?: Partial<Record<Sym, string>>;
  error?: string;
};
export type Level = "info" | "warn" | "error";
export type Log = (level: Level, msg: string, data?: Record<string, unknown>) => void;

const errText = (e: unknown) =>
  (e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)).slice(0, 400);

export async function tick(c: BotClient, cfg: BotConfig, rand: () => number, log: Log): Promise<RunRecord> {
  const rec: RunRecord = { at: new Date().toISOString(), ok: false, action: "error" };
  let s: Snapshot;
  try {
    s = await c.snapshot();
  } catch (e) {
    rec.error = `snapshot: ${errText(e)}`;
    log("error", "snapshot failed", { error: rec.error });
    return rec;
  }
  rec.stt = formatEther(s.stt);
  rec.equity = formatEther(s.equity);
  rec.positions = Object.fromEntries(Object.entries(s.positions).map(([k, v]) => [k, v.toString()]));
  for (const m of foreign(s)) {
    log("warn", "position larger than the bot opens: left alone", { symbol: m.symbol, size: pos(s, m), ceiling: ceiling(m) });
  }
  const a = decide(s, cfg, rand);
  rec.action = a.kind;
  rec.why = a.why;
  if (a.kind === "skip") {
    rec.reason = a.reason;
    rec.ok = true;
    // low gas or margin needs a top-up by hand: say so loudly every tick until it gets one
    const loud = a.reason === "low-gas" || a.reason === "low-equity";
    log(loud ? "error" : "info", loud ? `SKIPPED, ${a.reason}: top the leader up` : "skipped", { reason: a.reason, why: a.why, stt: rec.stt, equity: rec.equity });
    return rec;
  }
  rec.symbol = a.symbol;
  rec.side = a.isBid ? "buy" : "sell";
  rec.qty = a.qty.toString();
  let fill: Fill;
  try {
    fill = await c.trade(a.pool, a.isBid, a.qty);
  } catch (e) {
    rec.error = `trade: ${errText(e)}`;
    log("error", `${a.kind} failed`, { symbol: a.symbol, side: rec.side, qty: a.qty, error: rec.error });
    return rec;
  }
  rec.ok = true;
  rec.tx = fill.hash;
  rec.block = fill.block.toString();
  rec.gasUsed = fill.gasUsed.toString();
  rec.explorer = EXPLORER_TX + fill.hash;
  try {
    rec.hub = await c.reaction(fill.block);
  } catch (e) {
    log("warn", "could not read the hub's reaction", { error: errText(e) });
  }
  log("info", a.kind, {
    symbol: a.symbol,
    side: rec.side,
    qty: a.qty,
    tx: fill.hash,
    block: fill.block,
    gasUsed: fill.gasUsed,
    copied: rec.hub?.copied,
    refused: rec.hub?.refused,
  });
  return rec;
}

export type BotState = RunRecord & { lastTrade?: RunRecord };

/** The state file after `rec`: the run itself, plus the last run that sent a transaction. */
export function nextState(prev: BotState | undefined, rec: RunRecord): BotState {
  const lastTrade: RunRecord | undefined = rec.tx
    ? { at: rec.at, ok: rec.ok, action: rec.action, symbol: rec.symbol, side: rec.side, qty: rec.qty, tx: rec.tx, block: rec.block, explorer: rec.explorer, hub: rec.hub }
    : prev?.lastTrade;
  return lastTrade ? { ...rec, lastTrade } : rec;
}

// ---------------------------------------------------------------- chain

const hubEvents = parseAbi([
  "event Copied(address indexed follower, bytes32 indexed sourceId, address indexed pool, int256 fromSize, int256 toSize, uint256 price, bool capped)",
  "event Refused(address indexed follower, bytes32 indexed sourceId, address indexed pool, uint8 reason, bytes venueError)",
]);
const REASONS = [
  "None",
  "Paused",
  "MarketNotAllowed",
  "TotalCap",
  "EquityFloor",
  "TankEmpty",
  "RiskGate",
  "BandUnfilled",
  "VenueRejected",
  "LegFailed",
  "BelowMinimum",
  "AtCap",
];

function liveClient(): BotClient {
  const leader = account("LEADER").address;
  const trader = markets("LEADER");
  const hub = getAddress((JSON.parse(readFileSync(resolve(E2E, "../deployments/hideki.json"), "utf8")) as { hub: Address }).hub);
  // the hub's sourceIdOf(Trader, leader)
  const sourceId = keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [0, BigInt(leader)]));
  let pools: { symbol: Sym; pool: Address }[] | undefined;

  return {
    async snapshot() {
      if (!pools) {
        const perps = (await markets().client.listPerpMarkets()) as { baseSymbol: string; poolAddress: Address }[];
        pools = (["BTC", "ETH"] as const).map((symbol) => {
          const p = perps.find((x) => x.baseSymbol === symbol);
          if (!p) throw new Error(`no ${symbol} perp market listed`);
          return { symbol, pool: getAddress(p.poolAddress) };
        });
      }
      const [stt, eq, rows] = await Promise.all([
        pub.getBalance({ address: leader }),
        equity(leader),
        Promise.all(
          pools.map(async ({ symbol, pool }) => {
            const [m, p] = await Promise.all([market(pool), size(leader, pool)]);
            return { m: { symbol, pool, minQty: m.minQty, lot: m.lot }, p };
          }),
        ),
      ]);
      return {
        now: Date.now(),
        stt,
        equity: eq,
        markets: rows.map((r) => r.m),
        positions: Object.fromEntries(rows.map((r) => [r.m.symbol, r.p])),
      };
    },
    async trade(pool, isBid, qty) {
      const expiry = BigInt(Date.now() + 120_000) * 1_000_000n;
      const r = await placeIoc(trader, pool, isBid, qty, expiry);
      if (r.status !== "success") throw new Error(`reverted: ${r.transactionHash}`);
      return { hash: r.transactionHash, block: r.blockNumber, gasUsed: r.gasUsed };
    },
    async reaction(block) {
      const logs = await pub.getLogs({ address: hub, events: hubEvents, fromBlock: block, toBlock: block });
      const mine = logs.filter((l) => l.args.sourceId === sourceId);
      return {
        copied: mine.filter((l) => l.eventName === "Copied").length,
        refused: mine.flatMap((l) =>
          l.eventName === "Refused" ? [{ follower: l.args.follower!, reason: REASONS[Number(l.args.reason)] ?? String(l.args.reason) }] : [],
        ),
        handlers: [...new Set(mine.map((l) => l.transactionHash!))],
      };
    },
  };
}

// ---------------------------------------------------------------- main

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const log: Log = (level, msg, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...data }, big));

function config() {
  const num = (name: string, dflt: number) => {
    const v = process.env[name];
    const n = v === undefined || v === "" ? dflt : Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} is not a number: ${v}`);
    return n;
  };
  const intervalMin = num("LEADER_BOT_INTERVAL_MIN", 25);
  const jitterMin = num("LEADER_BOT_JITTER_MIN", 4);
  if (intervalMin < 5 || jitterMin < 0 || jitterMin >= intervalMin) throw new Error("need LEADER_BOT_INTERVAL_MIN >= 5 and 0 <= jitter < interval");
  const until = process.env.LEADER_BOT_UNTIL ? Date.parse(process.env.LEADER_BOT_UNTIL) : undefined;
  if (until !== undefined && Number.isNaN(until)) throw new Error(`LEADER_BOT_UNTIL is not a date: ${process.env.LEADER_BOT_UNTIL}`);
  const bot: BotConfig = {
    minStt: parseEther(String(num("LEADER_BOT_MIN_STT", 0.25))),
    minEquity: parseEther(String(num("LEADER_BOT_MIN_EQUITY", 5))),
    ethShare: num("LEADER_BOT_ETH_SHARE", 0.25),
    until,
  };
  return { bot, intervalMin, jitterMin, state: resolve(process.env.LEADER_BOT_STATE ?? resolve(E2E, "out/last-run.json")) };
}

function readState(path: string): BotState | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BotState;
  } catch {
    return undefined;
  }
}

function writeState(path: string, state: BotState) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, big, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

async function main() {
  const once = process.argv.includes("--once");
  const cfg = config();
  const client = liveClient();
  log("info", "leader bot started", {
    leader: account("LEADER").address,
    intervalMin: cfg.intervalMin,
    jitterMin: cfg.jitterMin,
    minStt: formatEther(cfg.bot.minStt),
    minEquity: formatEther(cfg.bot.minEquity),
    ethShare: cfg.bot.ethShare,
    until: cfg.bot.until && new Date(cfg.bot.until).toISOString(),
    state: cfg.state,
  });
  let state = readState(cfg.state);
  for (;;) {
    const wait = once ? 0 : delayMs(state?.at, Date.now(), cfg, Math.random);
    if (wait > 0) {
      log("info", "next tick", { at: new Date(Date.now() + wait).toISOString() });
      await new Promise((r) => setTimeout(r, wait));
    }
    state = nextState(state, await tick(client, cfg.bot, Math.random, log));
    writeState(cfg.state, state);
    if (once) return state.ok;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // the SDK's clients keep the event loop alive: exit once stdout has drained
  const exit = (code: number) => setTimeout(() => process.exit(code), 500);
  main().then(
    (ok) => exit(ok ? 0 : 1),
    (e) => {
      log("error", "leader bot stopped", { error: errText(e) });
      exit(1);
    },
  );
}

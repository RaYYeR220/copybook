import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi, type Address, type Hex } from "viem";
import { sourceIdOf } from "@copybook/sdk";
import type { LoggedEvent } from "@/lib/server/hubLog";
import { followedOnly, isExit, mergeFeed, sourceNames, tapeRow, venueErrorName, type Segment, type TapeContext } from "@/lib/tape";

const LEADER = "0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d" as Address;
const FOLLOWER = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932" as Address;
const BTC = "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0" as Address;
const PEPE = "0xfa9b9E50cc1745113D57893991af200A74C86B6F" as Address;
const SRC = sourceIdOf("Trader", LEADER);
const TH = sourceIdOf("Theme", 1n);
const HUB = "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154" as Address;

const meta = (block: number | undefined, tx: string, logIndex = 0, transactionIndex = 0) => ({
  address: HUB,
  blockNumber: block === undefined ? undefined : BigInt(block),
  transactionHash: tx as Hex,
  transactionIndex,
  logIndex,
  topics: [] as Hex[],
  data: "0x" as Hex,
});
const H1 = "0xd012c9ad808025ba8ff880bde67e6972b661b3824e839754bb8681cc1b878cbc";
const H2 = "0xc97ecbd7710b42ac60f5321333cd95a6a3fb369c38c9ebe8986751840bdcffcb";

const ctx: TapeContext = {
  markets: { [BTC.toLowerCase()]: { symbol: "BTC", decimals: 8 } },
  sources: sourceNames(
    [
      { sourceId: SRC, kind: "Trader", ref: BigInt(LEADER) },
      { sourceId: TH, kind: "Theme", ref: 1n },
    ],
    [{ id: 1n, name: "BTC vs ETH" }],
    { [LEADER.toLowerCase()]: "demo leader" },
  ),
  traders: { [LEADER.toLowerCase()]: "demo leader" },
};
const plain = (segs: Segment[]) => segs.map((s) => s.v).join("");

const copy = (over: Partial<Extract<LoggedEvent, { name: "Copied" }>> = {}): LoggedEvent =>
  ({ name: "Copied", follower: FOLLOWER, sourceId: SRC, pool: BTC, fromSize: 0n, toSize: 50000n, limitPrice: 81065600000000000000000n, capped: false, via: "handler", log: meta(35025602, H1, 3, 22), ...over }) as LoggedEvent;

describe("tape rows", () => {
  it("a handler copy carries the same-block badge with its real block", () => {
    const r = tapeRow(copy(), ctx)!;
    expect(r.kind).toBe("same");
    expect(r.market).toBe("BTC-PERP");
    expect(r.block).toBe(35025602n);
    expect(r.badge).toEqual({ tone: "gold", text: "same block #35,025,602", sameBlock: true });
    expect(plain(r.text)).toBe("0x7d73…1932 copied demo leader 0xA1d0…7b5d · 0 → 0.0005 long · limit 81,065.60");
    expect(r.href).toBe(`https://explorer.testnet.somnia.network/tokyo/tx/${H1}`);
    expect(r.key).toBe(`${H1}:3`);
    // the badge opens the copy's own page and card
    expect(r.share).toBe(`/copy/${H1}?log=3`);
    expect(tapeRow(copy({ via: "call" }), ctx)!.share).toBe(`/copy/${H1}?log=3`);
  });

  it("a copy someone sent directly never claims the same block", () => {
    expect(tapeRow(copy({ via: "call" }), ctx)!.badge).toEqual({ tone: "verdict", text: "direct call · #35,025,602" });
    expect(tapeRow(copy({ via: undefined }), ctx)!.badge).toEqual({ tone: "verdict", text: "block #35,025,602" });
  });

  it("no row without a block number or a transaction", () => {
    expect(tapeRow(copy({ log: meta(undefined, H1) }), ctx)).toBeNull();
  });

  it("an exit reads as an exit, always copied", () => {
    const r = tapeRow(copy({ fromSize: 50000n, toSize: 0n }), ctx)!;
    expect(r.kind).toBe("exit");
    expect(plain(r.text)).toContain("0.0005 long → 0");
    expect(r.text.at(-1)).toEqual({ t: "aside", v: "exit, always copied" });
    expect(isExit(-50000n, -80000n)).toBe(false);
  });

  it("a flip is not an exit: it adds size on the other side", () => {
    // block 35,025,759: the copy went from 0.0001 long to 0.0005 short
    const r = tapeRow(copy({ fromSize: 10000n, toSize: -50000n }), ctx)!;
    expect(isExit(10000n, -50000n)).toBe(false);
    expect(r.kind).toBe("same");
    expect(plain(r.text)).toContain("0.0001 long → 0.0005 short");
    expect(r.text.at(-1)).toEqual({ t: "aside", v: "flipped side" });
  });

  it("a thesis copy names the thesis and links it", () => {
    const r = tapeRow(copy({ sourceId: TH, toSize: -30000n }), ctx)!;
    expect(plain(r.text)).toContain("copied thesis “BTC vs ETH” · 0 → 0.0003 short");
    expect(r.text.find((s) => s.t === "who" && s.href === "/thesis/1")).toBeTruthy();
  });

  it("an unknown market falls back to the pool address, an unknown source to its id", () => {
    const r = tapeRow(copy({ pool: PEPE, sourceId: `0x${"ab".repeat(32)}` as Hex, toSize: 7n }), ctx)!;
    expect(r.market).toBe("0xfa9b…6B6F");
    expect(plain(r.text)).toContain("source 0xabab…abab · 0 → 7 units long");
  });

  it("a refusal shows the reason name verbatim and the venue's error by name", () => {
    const venueError = encodeErrorResult({ abi: parseAbi(["error FillOrKillNotFillable()"]), errorName: "FillOrKillNotFillable" });
    const r = tapeRow({ name: "Refused", follower: FOLLOWER, sourceId: SRC, pool: BTC, reason: "BandUnfilled", venueError, log: meta(35025975, H2) } as LoggedEvent, ctx)!;
    expect(r.kind).toBe("refused");
    expect(r.reason).toEqual({ state: "Refused", reason: "Band", detail: "FillOrKillNotFillable" });
    expect(r.badge).toEqual({ tone: "refused", text: "Refused · #35,025,975" });
    const ai = tapeRow({ name: "Refused", follower: FOLLOWER, sourceId: SRC, pool: BTC, reason: "RiskGate", venueError: "0x", log: meta(35414570, H2) } as LoggedEvent, ctx)!;
    expect(ai.reason).toEqual({ state: "Refused", reason: "AI risk verdict", detail: undefined });
  });

  it("verdicts and held verdicts read as the gate logged them", () => {
    const v = tapeRow({ name: "VerdictReceived", sourceId: SRC, trader: LEADER, tier: "Block", shannonRequestId: 18072906n, summaryHash: `0x${"0".repeat(64)}`, log: meta(35414500, H1) } as LoggedEvent, ctx)!;
    expect(v.kind).toBe("verdict");
    expect(plain(v.text)).toBe("Committee verdict BLOCK for demo leader 0xA1d0…7b5d · no new size for guarded followers");
    expect(v.badge.text).toBe("RiskVerdict · on-chain");
    const held = tapeRow({ name: "BlockHeld", sourceId: SRC, trader: LEADER, newTier: "Ok", nonce: 23n, log: meta(35420000, H2) } as LoggedEvent, ctx)!;
    expect(plain(held.text)).toBe("A milder verdict, OK, came in during the hold · the BLOCK on demo leader 0xA1d0…7b5d stands");
  });

  it("skips bookkeeping events", () => {
    expect(tapeRow({ name: "TankCharged", follower: FOLLOWER, amount: 1n, log: meta(1, H1) } as LoggedEvent, ctx)).toBeNull();
    expect(tapeRow({ name: "Admin", event: "GasParamsSet", args: {}, log: meta(1, H1) } as LoggedEvent, ctx)).toBeNull();
  });

  it("names venue errors, or keeps the selector", () => {
    expect(venueErrorName("0x")).toBeUndefined();
    expect(venueErrorName("0xc04ad919")).toBe("FillOrKillNotFillable");
    expect(venueErrorName("0xdeadbeef")).toBe("0xdeadbeef");
  });
});

describe("tape of followed sources", () => {
  const OTHER = "0xb8700E8d07Bd029f7dD3CE6CC97Fe936D70c50a8" as Address;
  const log = [
    { name: "Followed", follower: FOLLOWER, sourceId: SRC, kind: "Trader", ref: BigInt(LEADER), log: meta(1, H1) },
    { name: "ReviewRequested", trader: OTHER, nonce: 11n, requester: FOLLOWER, log: meta(2, H1, 1) },
    { name: "VerdictReceived", sourceId: SRC, trader: LEADER, tier: "Block", shannonRequestId: 1n, summaryHash: `0x${"0".repeat(64)}`, log: meta(3, H1, 2) },
    { name: "GuardSet", follower: FOLLOWER, on: false, log: meta(4, H1, 3) },
    copy(),
  ] as LoggedEvent[];

  it("keeps hub events, guard changes and reviews of followed traders; drops reviews of anyone else", () => {
    expect(log.filter(followedOnly([LEADER])).map((e) => e.name)).toEqual(["Followed", "VerdictReceived", "GuardSet", "Copied"]);
    // with nobody followed, no review shows
    expect(log.filter(followedOnly([])).map((e) => e.name)).toEqual(["Followed", "GuardSet", "Copied"]);
  });

  it("names known wallets such as the owner", () => {
    const r = tapeRow(log[1], { ...ctx, wallets: { [FOLLOWER.toLowerCase()]: "Copybook owner" } })!;
    expect(plain(r.text)).toBe("Review #11 of 0xb870…50a8 asked by Copybook owner 0x7d73…1932");
  });
});

describe("feed merge", () => {
  const a = copy({ log: meta(10, H1, 0) });
  const b = copy({ log: meta(12, H2, 1) });
  const c = copy({ log: meta(12, H2, 2) });

  it("dedupes by txHash:logIndex across backfill and live, newest first", () => {
    const merged = mergeFeed([a, b], [b, c, a]);
    expect(merged.map((e) => `${e.log.blockNumber}:${e.log.logIndex}`)).toEqual(["12:2", "12:1", "10:0"]);
  });

  it("a backfilled copy that knows how it was sent replaces the bare live one", () => {
    const bare = { ...a, via: undefined } as LoggedEvent;
    expect(mergeFeed([bare], [a])[0].via).toBe("handler");
    expect(mergeFeed([a], [bare])[0].via).toBe("handler");
  });

  it("caps the list", () => {
    expect(mergeFeed([a, b, c], [], 2).length).toBe(2);
  });

  it("survives a reconnect replaying the same range: no duplicates", () => {
    let feed: LoggedEvent[] = [];
    feed = mergeFeed(feed, [a, b]); // history on mount
    feed = mergeFeed(feed, [b]); // live tick before the drop
    feed = mergeFeed(feed, [a, b, c]); // backfill after reconnect overlaps both
    expect(feed.length).toBe(3);
  });
});

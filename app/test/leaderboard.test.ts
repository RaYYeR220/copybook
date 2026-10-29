import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { sourceIdOf, type CopybookEvent, type ReasonName } from "@copybook/sdk";
import { FEW_EVENTS, boardRows, fidelityText, isIncrease, rankRows } from "@/lib/leaderboard";

const LEADER = getAddress("0xa1d0cb85c869e534fe1e0c22af3b238301157b5d");
const OTHER = getAddress("0x1cf35c559bd4e1d45b738b83041855c8634e5a56");
const T = sourceIdOf("Trader", LEADER);
const O = sourceIdOf("Trader", OTHER);
const TH = sourceIdOf("Theme", 1n);
const BTC = getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0");
const F1 = getAddress("0x7d736a88978e94e60494ff91c49ba838edfb1932");
const F2 = getAddress("0xcee40d3c7709404cf60916bfea39925fcb1f09ed");
const F3 = getAddress("0x5eed00000000000000000000000000000000c0de");

let n = 0;
const log = (block: number) => ({ address: BTC, blockNumber: BigInt(block), transactionHash: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, transactionIndex: 0, logIndex: n, topics: [], data: "0x" as Hex });
const followed = (follower: Address, sourceId: Hex, block: number, kind: "Trader" | "Theme" = "Trader", ref = 1n): CopybookEvent => ({ name: "Followed", follower, sourceId, kind, ref, log: log(block) });
const unfollowed = (follower: Address, sourceId: Hex, block: number): CopybookEvent => ({ name: "Unfollowed", follower, sourceId, flattened: false, log: log(block) });
const copied = (sourceId: Hex, from: bigint, to: bigint, block: number, follower = F1): CopybookEvent => ({ name: "Copied", follower, sourceId, pool: BTC, fromSize: from, toSize: to, limitPrice: 1n, capped: false, log: log(block) });
const refused = (sourceId: Hex, reason: ReasonName, block: number, follower = F1): CopybookEvent => ({ name: "Refused", follower, sourceId, pool: BTC, reason, venueError: "0x", log: log(block) });

describe("what counts as an increase", () => {
  it("opening, growing, and the new side of a flip; not a reduction or a close", () => {
    expect(isIncrease(0n, 50_000n)).toBe(true);
    expect(isIncrease(50_000n, 80_000n)).toBe(true);
    expect(isIncrease(-50_000n, -80_000n)).toBe(true);
    expect(isIncrease(10n, -50_000n)).toBe(true); // crossed dust onto the other side
    expect(isIncrease(80_000n, 50_000n)).toBe(false);
    expect(isIncrease(50_000n, 0n)).toBe(false);
    expect(isIncrease(-80_000n, -50_000n)).toBe(false);
  });
});

describe("leaderboard rows from the hub's log", () => {
  const events = [
    followed(F1, T, 10, "Trader", BigInt(LEADER)),
    followed(F2, T, 11, "Trader", BigInt(LEADER)),
    copied(T, 0n, 50_000n, 12), // increase
    copied(T, 0n, 50_000n, 12, F2), // increase
    copied(T, 50_000n, 80_000n, 13), // increase
    refused(T, "RiskGate", 14),
    refused(T, "BandUnfilled", 15, F2),
    copied(T, 80_000n, 0n, 16), // exit
    unfollowed(F2, T, 17),
    followed(F3, TH, 18, "Theme", 1n),
    copied(TH, 0n, 49_000n, 18, F3),
    refused(TH, "BelowMinimum", 19, F3),
  ];
  const rows = boardRows(events, [{ sourceId: O, kind: "Trader", ref: BigInt(OTHER) }]);
  const t = rows.find((r) => r.sourceId === T)!;
  const th = rows.find((r) => r.sourceId === TH)!;
  const o = rows.find((r) => r.sourceId === O)!;

  it("counts followers now and ever by replaying follows and unfollows", () => {
    expect([t.followersNow, t.followersEver]).toEqual([1, 2]);
    expect([th.followersNow, th.followersEver]).toEqual([1, 1]);
  });

  it("fidelity is copied increases over copied plus refused, with the counts", () => {
    expect([t.copied, t.refused, t.exits, t.decisions]).toEqual([3, 2, 1, 5]);
    expect(t.fidelityBps).toBe(6000);
    expect(t.refusedBy).toEqual({ RiskGate: 1, BandUnfilled: 1 });
    expect(fidelityText(t)).toBe("60% · 3 of 5");
    expect(t.lastBlock).toBe(17n);
  });

  it("flags a source with fewer than FEW_EVENTS decisions, and says n", () => {
    expect(FEW_EVENTS).toBe(10);
    expect(t.few).toBe(true);
    expect(th.few).toBe(true);
    expect(fidelityText(th)).toBe("50% · 1 of 2");
  });

  it("a source with no decision has no fidelity at all, not 0% and not 100%", () => {
    expect(o.decisions).toBe(0);
    expect(o.fidelityBps).toBeNull();
    expect(fidelityText(o)).toBe("no increases yet");
  });

  it("never rounds up to 100%", () => {
    const many = [followed(F1, O, 1), ...Array.from({ length: 199 }, (_, i) => copied(O, 0n, 1n, 2 + i)), refused(O, "TotalCap", 300)];
    const r = boardRows(many, [])[0];
    expect(r.fidelityBps).toBe(9950);
    expect(fidelityText(r)).toBe("99.5% · 199 of 200");
    const nearly = boardRows([...Array.from({ length: 999 }, (_, i) => copied(O, 0n, 1n, 2 + i)), refused(O, "TotalCap", 2000)], [{ sourceId: O, kind: "Trader", ref: BigInt(OTHER) }])[0];
    expect(fidelityText(nearly)).toBe("99.9% · 999 of 1,000");
    const all = boardRows([...Array.from({ length: 2000 }, (_, i) => copied(O, 0n, 1n, 2 + i)), refused(O, "TotalCap", 9000)], [{ sourceId: O, kind: "Trader", ref: BigInt(OTHER) }])[0];
    expect(fidelityText(all)).toBe("99.9% · 2,000 of 2,001");
  });
});

describe("ranking", () => {
  const mk = (sourceId: Hex, now: number, ever: number, copied: number, refused: number) => ({
    sourceId,
    kind: "Trader" as const,
    ref: 1n,
    followersNow: now,
    followersEver: ever,
    copied,
    refused,
    exits: 0,
    decisions: copied + refused,
    fidelityBps: copied + refused ? Math.floor((copied * 10_000) / (copied + refused)) : null,
    few: copied + refused > 0 && copied + refused < FEW_EVENTS,
    refusedBy: {},
  });
  const a = mk("0x0a" as Hex, 3, 3, 9, 1); // 90%, n 10
  const b = mk("0x0b" as Hex, 5, 6, 2, 0); // 100%, but n 2: few
  const c = mk("0x0c" as Hex, 1, 4, 40, 0); // 100%, n 40
  const d = mk("0x0d" as Hex, 5, 9, 0, 0); // no decisions

  it("by followers: now, then ever", () => {
    expect(rankRows([a, b, c, d], "followers").map((x) => [x.row.sourceId, x.rank])).toEqual([
      ["0x0d", 1],
      ["0x0b", 2],
      ["0x0a", 3],
      ["0x0c", 4],
    ]);
  });

  it("by fidelity: only sources with enough events are ranked; few-event and silent ones follow, unranked", () => {
    expect(rankRows([a, b, c, d], "fidelity").map((x) => [x.row.sourceId, x.rank])).toEqual([
      ["0x0c", 1],
      ["0x0a", 2],
      ["0x0b", null],
      ["0x0d", null],
    ]);
  });

  it("breaks a fidelity tie on the larger n", () => {
    const e = mk("0x0e" as Hex, 0, 0, 18, 2); // 90%, n 20
    expect(rankRows([a, e], "fidelity").map((x) => x.row.sourceId)).toEqual(["0x0e", "0x0a"]);
  });
});

describe("on the recorded hub log (Hideki2, deployment to block 35,913,285)", () => {
  it("accounts for every copy and refusal once, and agrees with the follower replay the pages use", async () => {
    const { fromJsonSafe } = await import("@/lib/json");
    const { followersOf } = await import("@/lib/followers");
    const rec = fromJsonSafe<{ events: CopybookEvent[] }>((await import("./fixtures/hub-log.json")).default);
    const rows = boardRows(rec.events, []);
    const copies = rec.events.filter((e) => e.name === "Copied").length;
    const refusals = rec.events.filter((e) => e.name === "Refused").length;
    expect(rows.reduce((s, r) => s + r.copied + r.exits, 0)).toBe(copies);
    expect(rows.reduce((s, r) => s + r.refused, 0)).toBe(refusals);
    for (const r of rows) expect(r.followersNow).toBe(followersOf(rec.events, r.sourceId).current.length);
    const leader = rows.find((r) => r.sourceId === T)!;
    expect(leader.kind).toBe("Trader");
    expect(leader.decisions).toBe(leader.copied + leader.refused);
  });
});

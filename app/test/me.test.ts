import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { MIN_TANK, hubAbi, type CopybookEvent, type FollowerIssue, type FollowerStatus, type Market } from "@copybook/sdk";
import { MAIN_REASONS, currentFollowEvent, followTerms, lastRefusals, openDeferral, refusalCounts, tankStats } from "@/lib/me/activity";
import { bookSummary, catchUpOffer, clampToCap, gateIncreases, type GateState, legSettled, split, themeBook, traderBook, traderInStep, traderPools, unrealized, type PoolRead } from "@/lib/me/book";
import { callText, dashboardBanners, offerOnOpen, withdrawable } from "@/lib/me/issues";
import { takeovers, type HeldPosition } from "@/lib/follow/takeover";
import { fmtUsdSigned18 } from "@/lib/units";

const E = 10n ** 18n;
const ME = getAddress("0x7d736A88978e94E60494Ff91C49Ba838EDfb1932");
const LEADER = getAddress("0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d");
const BTC = getAddress("0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0");
const ETH = getAddress("0xD6Cb1DD58580B84D76068aC21594219ce03aeddf");
const SID = `0x${"11".repeat(32)}` as Hex;
const OTHER_SID = `0x${"22".repeat(32)}` as Hex;

// the live BTC and ETH markets' parameters (marks rounded)
const btc: Market = { pool: BTC, mark: 80_000n * E, tick: E / 10n, minQty: 13_000n, lot: 1_000n, oneBase: 100_000_000n };
const eth: Market = { pool: ETH, mark: 2_400n * E, tick: E / 100n, minQty: 4n * 10n ** 15n, lot: 10n ** 14n, oneBase: E };
const pos = (size: bigint, entry = 0n) => ({ size, avgEntryPrice: entry });

let seq = 0;
const ev = (body: Record<string, unknown>, block: bigint): CopybookEvent =>
  ({ ...body, log: { address: ME, blockNumber: block, transactionHash: `0x${(++seq).toString(16).padStart(64, "0")}`, logIndex: 0, topics: [], data: "0x" } }) as unknown as CopybookEvent;

describe("book vs theirs: trader follows", () => {
  it("mirrors PolicyLib.split", () => {
    expect(split(10n, 15n)).toEqual({ reduce: 0n, increase: 5n });
    expect(split(10n, 4n)).toEqual({ reduce: 6n, increase: 0n });
    expect(split(10n, -3n)).toEqual({ reduce: 10n, increase: 3n });
    expect(split(-10n, -15n)).toEqual({ reduce: 0n, increase: 5n });
    expect(split(-10n, -4n)).toEqual({ reduce: 6n, increase: 0n });
    expect(split(-10n, 2n)).toEqual({ reduce: 10n, increase: 2n });
  });

  it("is in step when no sync would trade: same size, dust below the minimum, or capped below theirs", () => {
    expect(traderInStep(50_000n, 50_000n, 50_000n, btc)).toBe(true);
    // 1,000 below target: one lot, but below the 13,000 minimum
    expect(traderInStep(49_000n, 50_000n, 50_000n, btc)).toBe(true);
    expect(traderInStep(30_000n, 50_000n, 50_000n, btc)).toBe(false);
    // above the cap but not above theirs × scale: the exit half leaves it, the increase half has nothing to add
    expect(traderInStep(60_000n, 80_000n, 50_000n, btc)).toBe(true);
    expect(traderInStep(-20_000n, 50_000n, 50_000n, btc)).toBe(false);
  });

  it("clamps the target by the cap like PolicyLib.clampNotional", () => {
    // 0.002 BTC at 80k = $160 > $100 cap → 0.00125 BTC
    expect(clampToCap(200_000n, btc, 100n * E)).toEqual({ size: 125_000n, capped: true });
    expect(clampToCap(-50_000n, btc, 100n * E)).toEqual({ size: -50_000n, capped: false });
  });

  it("prices unrealized PnL at the mark from the margin bank's entry", () => {
    // long 0.0005 BTC from 79,000 at 80,000: +$0.50; short 0.0102 ETH from 2,355.93 at 2,400: −$0.449514
    expect(unrealized(pos(50_000n, 79_000n * E), btc)).toBe(E / 2n);
    expect(unrealized(pos(-10_200_000_000_000_000n, 2_355_930_000_000_000_000_000n), eth)).toBe(-449_514_000_000_000_000n);
    expect(unrealized(pos(0n, 0n), btc)).toBe(0n);
  });

  it("builds rows with target, state and the reason a market is out of step", () => {
    const pools: PoolRead[] = [
      { pool: BTC, market: btc, yours: pos(50_000n, 79_000n * E), theirs: pos(50_000n, 78_000n * E) },
      { pool: ETH, market: eth, yours: pos(0n), theirs: pos(-(10n ** 16n), 2_500n * E) },
      { pool: getAddress("0x00000000000000000000000000000000000000f1"), market: null, yours: pos(0n), theirs: pos(0n) },
    ];
    const rows = traderBook({ scaleBps: 10_000, maxNotional: 100n * E }, pools, { [ETH.toLowerCase()]: { reason: "RiskGate", block: 35_414_570n } });
    expect(rows[0]).toMatchObject({ state: "in-step", target: 50_000n, capped: false, pnl: E / 2n, theirsPnlScaled: E });
    expect(rows[1]).toMatchObject({ state: "out", target: -(10n ** 16n), why: { kind: "refused", reason: "RiskGate", block: 35_414_570n } });
    expect(rows[2]).toMatchObject({ state: "unknown", target: null });
    const s = bookSummary(rows);
    expect(s).toMatchObject({ known: 2, inStep: 1, partial: true, pnl: E / 2n });
    // the trader's ETH short is up $1.00 at the mark; times 1x
    expect(s.theirsPnlScaled).toBe(E + E);
  });

  it("scales theirs before comparing, and both flat is flat", () => {
    const rows = traderBook({ scaleBps: 5_000, maxNotional: 100n * E }, [
      { pool: BTC, market: btc, yours: pos(26_000n), theirs: pos(52_000n) },
      { pool: ETH, market: eth, yours: pos(0n), theirs: pos(0n) },
    ]);
    expect(rows.map((r) => r.state)).toEqual(["in-step", "flat"]);
  });

  const open: GateState = { paused: false, equityFloor: 0n, equity: 30n * E, maxTotalNotional: 0n, tank: E, blocked: false, synced: [BTC, ETH] };

  it("offers catchUp only for markets never tried or refused for a passing reason", () => {
    const rows = gateIncreases(
      traderBook({ scaleBps: 10_000, maxNotional: 1_000n * E }, [
        { pool: BTC, market: btc, yours: pos(0n), theirs: pos(50_000n) },
        { pool: ETH, market: eth, yours: pos(0n), theirs: pos(10n ** 16n) },
      ], { [ETH.toLowerCase()]: { reason: "RiskGate", block: 1n } }),
      open,
    );
    expect(catchUpOffer(rows)).toEqual({ pools: [BTC], reducing: [], growing: [BTC] });
    const band = traderBook({ scaleBps: 10_000, maxNotional: 1_000n * E }, [{ pool: ETH, market: eth, yours: pos(0n), theirs: pos(10n ** 16n) }], { [ETH.toLowerCase()]: { reason: "BandUnfilled", block: 1n } });
    expect(catchUpOffer(gateIncreases(band, open)).pools).toEqual([ETH]);
  });

  it("the demo state: guard on and a fresh BLOCK on the leader holding BTC offers no catchUp for the increase", () => {
    // the leader holds 0.0005 BTC, the follower is flat there: the only move is an increase, which the guard refuses
    const rows = gateIncreases(traderBook({ scaleBps: 10_000, maxNotional: 100n * E }, [{ pool: BTC, market: btc, yours: pos(0n), theirs: pos(50_000n) }]), { ...open, blocked: true });
    expect(rows[0]).toMatchObject({ state: "out", gate: "RiskGate", moves: { reduce: false, increase: true } });
    expect(catchUpOffer(rows).pools).toEqual([]);
    expect(dashboardBanners({ status: status(), catchUp: catchUpOffer(rows), refusalsRead: true, names }).some((b) => b.code === "OUT_OF_STEP")).toBe(false);
  });

  it("a market whose catchUp only reduces is still offered under a BLOCK and an empty tank: exits are never gated", () => {
    // the leader went flat, the follower still holds 0.0005 BTC
    const rows = gateIncreases(traderBook({ scaleBps: 10_000, maxNotional: 100n * E }, [{ pool: BTC, market: btc, yours: pos(50_000n), theirs: pos(0n) }]), { ...open, blocked: true, tank: 0n });
    expect(rows[0]).toMatchObject({ state: "out", moves: { reduce: true, increase: false } });
    expect(rows[0]!.gate).toBeUndefined();
    const offer = catchUpOffer(rows);
    expect(offer).toEqual({ pools: [BTC], reducing: [BTC], growing: [] });
    const b = dashboardBanners({ status: status(), catchUp: offer, refusalsRead: true, names }).find((x) => x.code === "OUT_OF_STEP")!;
    expect(b.message).toContain("reduces BTC-PERP toward the trader's size (an exit: never gated)");
    expect(b.message).not.toContain("brings");
    expect(b.call?.text).toBe("hub.catchUp(0x7d73…1932, [BTC-PERP])");
  });

  it("drops an increase the total cap, the tank, the equity floor or a stop would refuse, in the gate's order", () => {
    const base = traderBook({ scaleBps: 10_000, maxNotional: 1_000n * E }, [
      // already holds 0.001 BTC ($80) in a synced market
      { pool: BTC, market: btc, yours: pos(100_000n), theirs: pos(100_000n) },
      // ETH: flat, the trader holds 0.01 ETH ($24)
      { pool: ETH, market: eth, yours: pos(0n), theirs: pos(10n ** 16n) },
    ]);
    // $80 + $24 > $100
    expect(gateIncreases(base, { ...open, maxTotalNotional: 100n * E })[1]!.gate).toBe("TotalCap");
    expect(gateIncreases(base, { ...open, maxTotalNotional: 110n * E })[1]!.gate).toBeUndefined();
    // BTC is not synced: the total-cap gate does not count it
    expect(gateIncreases(base, { ...open, maxTotalNotional: 100n * E, synced: [ETH] })[1]!.gate).toBeUndefined();
    expect(gateIncreases(base, { ...open, tank: 10n ** 16n })[1]!.gate).toBe("TankEmpty");
    expect(gateIncreases(base, { ...open, equityFloor: 40n * E })[1]!.gate).toBe("EquityFloor");
    expect(gateIncreases(base, { ...open, paused: true })[1]!.gate).toBe("Paused");
    // a market in step has no move to gate
    expect(gateIncreases(base, { ...open, paused: true })[0]!.gate).toBeUndefined();
  });

  it("replays catchUp in pool order: a second growing market that would pass the whole-book cap is held back", () => {
    // BTC: the trader holds 0.001 ($80); ETH: 0.01 ($24); the follower is flat in both; cap $100
    const book = traderBook({ scaleBps: 10_000, maxNotional: 1_000n * E }, [
      { pool: BTC, market: btc, yours: pos(0n), theirs: pos(100_000n) },
      { pool: ETH, market: eth, yours: pos(0n), theirs: pos(10n ** 16n) },
    ]);
    const rows = gateIncreases(book, { ...open, maxTotalNotional: 100n * E, synced: [] });
    expect(rows[0]!.gate).toBeUndefined();
    expect(rows[1]!.gate).toBe("TotalCap");
    const offer = catchUpOffer(rows);
    expect(offer).toEqual({ pools: [BTC], reducing: [], growing: [BTC] });
    const banner = dashboardBanners({ status: status(), catchUp: offer, refusalsRead: true, names }).find((b) => b.code === "OUT_OF_STEP")!;
    expect(banner.message).toContain("brings BTC-PERP up to the trader's size");
    expect(banner.message).not.toContain("0xD6Cb");
    // in the other order the first market wins the room
    const reversed = gateIncreases([book[1]!, book[0]!], { ...open, maxTotalNotional: 100n * E, synced: [] });
    expect(reversed.map((r) => r.gate)).toEqual([undefined, "TotalCap"]);
  });

  it("counts an earlier market at its size after its own exit: a reduction can make room", () => {
    const book = traderBook({ scaleBps: 10_000, maxNotional: 1_000n * E }, [
      // holds 0.002 BTC ($160), the trader 0.001 ($80): catchUp reduces it first
      { pool: BTC, market: btc, yours: pos(200_000n), theirs: pos(100_000n) },
      { pool: ETH, market: eth, yours: pos(0n), theirs: pos(10n ** 16n) },
    ]);
    const rows = gateIncreases(book, { ...open, maxTotalNotional: 110n * E, synced: [BTC] });
    expect(rows[1]!.gate).toBeUndefined();
    expect(catchUpOffer(rows)).toEqual({ pools: [BTC, ETH], reducing: [BTC], growing: [ETH] });
  });

  it("with the equity floor off, an empty tank is named before the whole-book cap, as _earlyGate does", () => {
    const book = traderBook({ scaleBps: 10_000, maxNotional: 1_000n * E }, [{ pool: ETH, market: eth, yours: pos(0n), theirs: pos(10n ** 16n) }]);
    expect(gateIncreases(book, { ...open, tank: 10n ** 16n, maxTotalNotional: E })[0]!.gate).toBe("TankEmpty");
    // with a floor armed (and met), the cap comes first
    expect(gateIncreases(book, { ...open, tank: 10n ** 16n, maxTotalNotional: E, equityFloor: 10n * E })[0]!.gate).toBe("TotalCap");
  });

  it("a flip whose increase is refused is offered for its reduction only", () => {
    const rows = gateIncreases(traderBook({ scaleBps: 10_000, maxNotional: 100n * E }, [{ pool: BTC, market: btc, yours: pos(-50_000n), theirs: pos(50_000n) }]), { ...open, blocked: true });
    expect(rows[0]!.moves).toMatchObject({ reduce: true, increase: true });
    expect(catchUpOffer(rows)).toEqual({ pools: [BTC], reducing: [BTC], growing: [] });
  });

  it("covers synced markets plus the list, or the held markets for a whole-book follow; only synced when the terms are unknown", () => {
    expect(traderPools([BTC], [], [BTC, ETH])).toEqual([BTC, ETH]);
    expect(traderPools([BTC], [BTC], [ETH])).toEqual([BTC]);
    expect(traderPools([BTC], null, [ETH])).toEqual([BTC]);
  });
});

describe("book vs theirs: thesis follows", () => {
  const legs = [
    { pool: BTC, weightBps: 7_000 },
    { pool: ETH, weightBps: -3_000 },
  ];
  it("sizes each leg from the allocation, settles within the hub's 5% drift, and flags drift past it", () => {
    // $80 × 70% = $56 → 0.0007 BTC; $80 × 30% = $24 → −0.01 ETH
    const rows = themeBook({ allocation: 80n * E, maxNotional: 100n * E }, legs, [
      { pool: BTC, market: btc, yours: pos(69_000n) },
      { pool: ETH, market: eth, yours: pos(-5_000_000_000_000_000n) },
    ]);
    expect(rows[0]).toMatchObject({ weightBps: 7_000, target: 70_000n, state: "in-step" });
    expect(rows[1]).toMatchObject({ weightBps: -3_000, target: -(10n ** 16n), state: "out", why: { kind: "drift", bps: 5_000 } });
  });

  it("a market that is no longer a leg targets flat", () => {
    const rows = themeBook({ allocation: 80n * E, maxNotional: 100n * E }, legs, [{ pool: getAddress("0x00000000000000000000000000000000000000f1"), market: btc, yours: pos(20_000n) }]);
    expect(rows[0]).toMatchObject({ weightBps: 0, target: 0n, state: "out" });
  });

  it("mirrors CopyEngine._settled", () => {
    expect(legSettled(100_000n, 100_000n, btc)).toBe(true);
    expect(legSettled(96_000n, 100_000n, btc)).toBe(true); // 4% drift
    expect(legSettled(90_000n, 100_000n, btc)).toBe(true); // 10%, but 10,000 is below the 13,000 minimum
    expect(legSettled(80_000n, 100_000n, btc)).toBe(false); // 20%, tradable
    expect(legSettled(5_000n, 0n, btc)).toBe(true); // dust against flat
    expect(legSettled(-5_000n, 100_000n, btc)).toBe(false); // wrong side
  });
});

describe("the follower's own events", () => {
  const followed = (b: bigint, sid = SID) => ev({ name: "Followed", follower: ME, sourceId: sid, kind: "Trader", ref: BigInt(LEADER) }, b);

  it("finds the current follow's Followed event, not an undone one", () => {
    const events = [followed(10n), ev({ name: "Unfollowed", follower: ME, sourceId: SID, flattened: true }, 20n), followed(30n)].reverse();
    expect(currentFollowEvent(events, ME, SID)?.log.blockNumber).toBe(30n);
    expect(currentFollowEvent(events.slice(1), ME, SID)).toBeUndefined();
    expect(currentFollowEvent([followed(40n, OTHER_SID)], ME, SID)).toBeUndefined();
  });

  it("counts refusals by reason since the follow, listing the main seven even at zero", () => {
    const events = [
      ev({ name: "Refused", follower: ME, sourceId: SID, pool: BTC, reason: "RiskGate", venueError: "0x" }, 50n),
      ev({ name: "Refused", follower: ME, sourceId: SID, pool: BTC, reason: "BandUnfilled", venueError: "0x" }, 40n),
      ev({ name: "Refused", follower: ME, sourceId: SID, pool: BTC, reason: "VenueRejected", venueError: "0x" }, 35n),
      ev({ name: "Refused", follower: ME, sourceId: SID, pool: BTC, reason: "BandUnfilled", venueError: "0x" }, 5n),
    ];
    const c = refusalCounts(events, 30n);
    expect(c.slice(0, 7).map((x) => x.reason)).toEqual(MAIN_REASONS);
    expect(Object.fromEntries(c.map((x) => [x.reason, x.n]))).toMatchObject({ BandUnfilled: 1, RiskGate: 1, TotalCap: 0, VenueRejected: 1 });
  });

  it("keeps the newest refusal per market until a later copy there", () => {
    const events = [
      ev({ name: "Refused", follower: ME, sourceId: SID, pool: BTC, reason: "BandUnfilled", venueError: "0x" }, 40n),
      ev({ name: "Copied", follower: ME, sourceId: SID, pool: BTC, fromSize: 0n, toSize: 50_000n, limitPrice: 1n, capped: false }, 45n),
      ev({ name: "Refused", follower: ME, sourceId: SID, pool: ETH, reason: "RiskGate", venueError: "0x" }, 50n),
    ];
    expect(lastRefusals(events, 0n)).toEqual({ [ETH.toLowerCase()]: { reason: "RiskGate", block: 50n } });
  });

  it("reports a deferral no later copy or refusal answered", () => {
    const d = ev({ name: "Deferred", follower: ME, sourceId: SID }, 60n);
    expect(openDeferral([d], 0n)).toBe(60n);
    expect(openDeferral([d, ev({ name: "Copied", follower: ME, sourceId: SID, pool: BTC, fromSize: 0n, toSize: 1n, limitPrice: 1n, capped: false }, 61n)], 0n)).toBeUndefined();
    expect(openDeferral([d], 70n)).toBeUndefined();
  });

  it("estimates runs left only from the current follow's real charges", () => {
    expect(tankStats([], E, 0n)).toEqual({ runs: 0, total: 0n });
    const charges = [14_176_200_000_000_000n, 11_115_138_000_000_000n, 11_722_956_000_000_000n, 99n * E].map((amount, i) => ev({ name: "TankCharged", follower: ME, amount }, BigInt(10 - i)));
    // the last one (block 7) belongs to an earlier follow
    const s = tankStats(charges, 984_545_946_000_000_000n, 8n);
    expect(s).toMatchObject({ runs: 3, total: 37_014_294_000_000_000n, average: 12_338_098_000_000_000n, left: 79n });
    // without the follow's block there is no estimate
    expect(tankStats(charges, E, undefined)).toEqual({ runs: 0, total: 0n });
  });

  it("reads the market list from the follow transaction's calldata", () => {
    const policy = { scaleBps: 10_000, allocation: 0n, maxNotional: 100n * E, maxTotalNotional: 0n, bandBps: 50, equityFloor: 0n };
    const allowAll = encodeFunctionData({ abi: hubAbi, functionName: "follow", args: [0, BigInt(LEADER), policy, []] });
    const list = encodeFunctionData({ abi: hubAbi, functionName: "follow", args: [0, BigInt(LEADER), policy, [BTC]] });
    expect(followTerms(allowAll)).toEqual({ joinPools: [] });
    expect(followTerms(list)).toEqual({ joinPools: [BTC] });
    expect(followTerms("0xdeadbeef")).toBeNull();
    expect(followTerms(undefined)).toBeNull();
  });
});

const status = (over: Partial<FollowerStatus> = {}, issues: FollowerIssue[] = []): FollowerStatus => ({
  follower: ME,
  follow: { follower: ME, sourceId: SID, kind: "Trader", ref: BigInt(LEADER), trader: LEADER, policy: { scaleBps: 10_000, allocation: 0n, maxNotional: 100n * E, maxTotalNotional: 0n, bandBps: 50, equityFloor: 0n }, paused: false, group: 0 },
  tank: E,
  pending: { exitPending: false, flattenPending: false },
  synced: [BTC],
  guardOn: true,
  issues,
  ...over,
});
const names = (a: string) => (a.toLowerCase() === BTC.toLowerCase() ? "BTC-PERP" : undefined);

describe("dashboard banners: each stuck state with the exact call that clears it", () => {
  it("latched exits: catchUp(you, [])", () => {
    const b = dashboardBanners({ status: status({}, [{ code: "EXITS_PENDING", severity: "error", message: "m", action: { method: "catchUp", args: [ME, []] } }]) });
    expect(b).toHaveLength(1);
    expect(b[0]!.call).toMatchObject({ method: "catchUp", args: [ME, []], text: "hub.catchUp(0x7d73…1932, [])", label: "Send catchUp" });
  });

  it("a stop's closes pending: poke(you); a stop: resume(); a stop below the floor: no call, change the policy or add margin", () => {
    expect(dashboardBanners({ status: status({}, [{ code: "STOP_CLOSES_PENDING", severity: "error", message: "m", action: { method: "poke", args: [ME] } }]) })[0]!.call?.text).toBe("hub.poke(0x7d73…1932)");
    expect(dashboardBanners({ status: status({}, [{ code: "STOPPED", severity: "error", message: "m", action: { method: "resume" } }]) })[0]!.call?.text).toBe("hub.resume()");
    const below = dashboardBanners({ status: status({}, [{ code: "STOPPED", severity: "error", message: "m" }]) })[0]!;
    expect(below.call).toBeUndefined();
    expect(below.fix).toBe("policy-or-margin");
  });

  it("theme drift: resync(); theme behind: catchUp; tank: fundTank with its value; guard off: setGuard(true)", () => {
    const theme = status({ follow: { ...status().follow!, kind: "Theme", themeId: 1n, trader: undefined } }, [
      { code: "THEME_DRIFT", severity: "warning", message: "m", action: { method: "resync" } },
      { code: "THEME_BEHIND", severity: "warning", message: "m", action: { method: "catchUp", args: [ME, []] } },
      { code: "TANK_LOW", severity: "warning", message: "m", action: { method: "fundTank", args: [MIN_TANK - 5n * 10n ** 16n] } },
    ]);
    const b = dashboardBanners({ status: theme });
    expect(b.map((x) => x.call?.text)).toEqual(["hub.resync()", "hub.catchUp(0x7d73…1932, [])", "hub.fundTank() · value 0.15 STT"]);
    expect(b[2]!.call).toMatchObject({ method: "fundTank", args: [], value: 15n * 10n ** 16n });
    const guard = dashboardBanners({ status: status({ guardOn: false }, [{ code: "GUARD_OFF", severity: "info", message: "m", action: { method: "setGuard", args: [true] } }]) });
    expect(guard[0]!.call?.text).toBe("gate.setGuard(true)");
  });

  it("a deferral that left markets out of step: catchUp(you, [those markets]), named", () => {
    const offer = { pools: [BTC], reducing: [], growing: [BTC] };
    // not before the follower's refusals are read in full
    expect(dashboardBanners({ status: status(), catchUp: offer, deferredAt: 35_900_123n, names }).some((x) => x.code === "OUT_OF_STEP")).toBe(false);
    const b = dashboardBanners({ status: status(), catchUp: offer, refusalsRead: true, deferredAt: 35_900_123n, names });
    expect(b[0]).toMatchObject({ code: "OUT_OF_STEP", severity: "warning" });
    expect(b[0]!.message).toContain("deferred this follow at block #35,900,123");
    expect(b[0]!.call?.text).toBe("hub.catchUp(0x7d73…1932, [BTC-PERP])");
    expect(b[0]!.call?.args).toEqual([ME, [BTC]]);
    expect(b[0]!.message).toContain("brings BTC-PERP up to the trader's size inside your band and caps");
    // latched exits already say catchUp(you, []), which syncs every market: no second banner
    const latched = dashboardBanners({ status: status({}, [{ code: "EXITS_PENDING", severity: "error", message: "m", action: { method: "catchUp", args: [ME, []] } }]), catchUp: offer, refusalsRead: true });
    expect(latched.map((x) => x.code)).toEqual(["EXITS_PENDING"]);
    // a stopped follow is not caught up
    expect(dashboardBanners({ status: status({ follow: { ...status().follow!, paused: true } }), catchUp: offer, refusalsRead: true }).some((x) => x.code === "OUT_OF_STEP")).toBe(false);
  });

  it("a missing global grant is info with the grant as its call", () => {
    const b = dashboardBanners({ status: status(), approved: false });
    expect(b[0]).toMatchObject({ code: "NO_GRANT", severity: "info" });
    expect(b[0]!.call?.text).toBe("registry.setOperatorApprovalGlobal(hub, [placeOrderFor], true)");
  });

  it("offers the most severe banner with a call on open, never an info one", () => {
    const b = dashboardBanners({
      status: status({}, [
        { code: "GUARD_OFF", severity: "info", message: "m", action: { method: "setGuard", args: [true] } },
        { code: "TANK_EMPTY", severity: "error", message: "m", action: { method: "fundTank", args: [MIN_TANK] } },
      ]),
    });
    expect(offerOnOpen(b)?.code).toBe("TANK_EMPTY");
    expect(offerOnOpen(dashboardBanners({ status: status({}, [{ code: "GUARD_OFF", severity: "info", message: "m", action: { method: "setGuard", args: [true] } }]) }))).toBeUndefined();
    expect(dashboardBanners({ status: status({ follow: null }) })).toEqual([]);
  });

  it("call text for every method", () => {
    expect(callText("approveOperator", [false])).toBe("registry.setOperatorApprovalGlobal(hub, [placeOrderFor], false)");
    expect(callText("catchUp", [ME, [BTC, ETH]], undefined, names)).toBe("hub.catchUp(0x7d73…1932, [BTC-PERP, 0xD6Cb…eddf])");
  });

  it("withdraws above the floor while following, everything after", () => {
    expect(withdrawable(E, true)).toBe(E - MIN_TANK);
    expect(withdrawable(MIN_TANK / 2n, true)).toBe(0n);
    expect(withdrawable(MIN_TANK / 2n, false)).toBe(MIN_TANK / 2n);
  });
});

describe("signed dollars", () => {
  it("never colours, always signs", () => {
    expect(fmtUsdSigned18(E / 2n)).toBe("+$0.50");
    expect(fmtUsdSigned18(-449_514_000_000_000_000n)).toBe("−$0.45");
    expect(fmtUsdSigned18(1_250n * E)).toBe("+$1,250.00");
    expect(fmtUsdSigned18(4n * 10n ** 15n)).toBe("$0.00");
  });
});

void (0 as unknown as Address);

describe("positions the follower already holds", () => {
  const mine: HeldPosition[] = [
    { pool: BTC, side: "long", size: 30_000n, decimals: 8, market: "BTC-PERP" },
    { pool: ETH, side: "short", size: 10n ** 16n, decimals: 18, market: "ETH-PERP" },
  ];
  it("a market list or a thesis leg is synced in the follow transaction", () => {
    expect(takeovers({ kind: "Trader", allowAll: false, joinPools: [BTC] }, mine)).toEqual([{ position: mine[0], when: "now" }]);
    expect(takeovers({ kind: "Theme", legs: [{ pool: ETH, weightBps: -3_000 }] }, mine)).toEqual([{ position: mine[1], when: "now" }]);
  });
  it("a whole-book follow takes over a market at the trader's next move there, or if they ever trade it", () => {
    expect(takeovers({ kind: "Trader", allowAll: true, traderHeld: [ETH] }, mine).map((t) => [t.position.market, t.when])).toEqual([
      ["ETH-PERP", "next-move"],
      ["BTC-PERP", "if-traded"],
    ]);
    // the trader's markets unknown: every held market counts as at risk
    expect(takeovers({ kind: "Trader", allowAll: true, traderHeld: null }, mine).every((t) => t.when === "if-traded")).toBe(true);
    expect(takeovers({ kind: "Trader", allowAll: true, traderHeld: [] }, [])).toEqual([]);
  });
});

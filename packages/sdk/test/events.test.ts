import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { gateAbi } from "../src/abi/gate.ts";
import { hubAbi } from "../src/abi/hub.ts";
import { themesAbi } from "../src/abi/themes.ts";
import { decodeCopybookLog, decodeCopybookLogs } from "../src/events.ts";
import { deployments } from "./fake.ts";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const POOL = "0x3333333333333333333333333333333333333333" as Address;
const SID = `0x${"aa".repeat(32)}` as Hex;

/** Encodes an event the way a node logs it: indexed args as topics, the rest as data. */
function log(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>, meta = {}) {
  const item = getAbiItem({ abi, name: eventName }) as AbiEvent;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name!]) as never) : "0x";
  return { address, topics, data, blockNumber: 77n, transactionHash: `0x${"bb".repeat(32)}` as Hex, transactionIndex: 2, logIndex: 5, ...meta };
}
const hub = (name: string, args: Record<string, unknown>) => log(deployments.hub, hubAbi as Abi, name, args);
const gate = (name: string, args: Record<string, unknown>) => log(deployments.gate, gateAbi as Abi, name, args);

describe("event decoding", () => {
  it("decodes Followed with the source kind by name", () => {
    const e = decodeCopybookLog(hub("Followed", { follower: A, sourceId: SID, kind: 1, ref: 3n }), deployments)!;
    expect(e).toMatchObject({ name: "Followed", follower: A, sourceId: SID, kind: "Theme", ref: 3n });
    expect(e.log).toMatchObject({ blockNumber: 77n, transactionIndex: 2, logIndex: 5, address: deployments.hub });
  });

  it("names every Refused reason, including BelowMinimum, AtCap and RiskGate", () => {
    const names = ["None", "Paused", "MarketNotAllowed", "TotalCap", "EquityFloor", "TankEmpty", "RiskGate", "BandUnfilled", "VenueRejected", "LegFailed", "BelowMinimum", "AtCap"];
    names.forEach((n, i) => {
      const e = decodeCopybookLog(hub("Refused", { follower: A, sourceId: SID, pool: POOL, reason: i, venueError: "0x" }), deployments)!;
      expect(e).toMatchObject({ name: "Refused", reason: n, pool: POOL });
    });
  });

  it("decodes Copied with the limit price named as such", () => {
    const e = decodeCopybookLog(hub("Copied", { follower: A, sourceId: SID, pool: POOL, fromSize: 0n, toSize: -5n, price: 123n, capped: true }), deployments)!;
    expect(e).toMatchObject({ name: "Copied", fromSize: 0n, toSize: -5n, limitPrice: 123n, capped: true });
    expect("price" in e).toBe(false);
  });

  it("decodes the follower lifecycle and latch events", () => {
    expect(decodeCopybookLog(hub("Stopped", { follower: A, equity: -4n }), deployments)).toMatchObject({ name: "Stopped", equity: -4n });
    expect(decodeCopybookLog(hub("Resumed", { follower: A }), deployments)).toMatchObject({ name: "Resumed" });
    expect(decodeCopybookLog(hub("TankCharged", { follower: A, amount: 9n }), deployments)).toMatchObject({ name: "TankCharged", amount: 9n });
    expect(decodeCopybookLog(hub("Deferred", { follower: A, sourceId: SID }), deployments)).toMatchObject({ name: "Deferred" });
    expect(decodeCopybookLog(hub("GroupDeferred", { sourceId: SID, group: 1, fromIndex: 4n }), deployments)).toMatchObject({ name: "GroupDeferred", group: 1, fromIndex: 4n });
    expect(decodeCopybookLog(hub("FlattenIncomplete", { follower: A, pool: POOL }), deployments)).toMatchObject({ name: "FlattenIncomplete", pool: POOL });
    expect(decodeCopybookLog(hub("Unfollowed", { follower: A, sourceId: SID, flattened: true }), deployments)).toMatchObject({ name: "Unfollowed", flattened: true });
  });

  it("decodes the risk gate's verdict events with tier names", () => {
    expect(decodeCopybookLog(gate("VerdictReceived", { sourceId: SID, trader: B, tier: 3, shannonRequestId: 9n, summaryHash: SID }), deployments)).toMatchObject({
      name: "VerdictReceived",
      tier: "Block",
      trader: B,
    });
    expect(decodeCopybookLog(gate("BlockHeld", { sourceId: SID, trader: B, newTier: 1, nonce: 4n }), deployments)).toMatchObject({ name: "BlockHeld", newTier: "Ok", nonce: 4n });
    expect(decodeCopybookLog(gate("ReviewFailed", { trader: B, nonce: 5n }), deployments)).toMatchObject({ name: "ReviewFailed", nonce: 5n });
    expect(decodeCopybookLog(gate("GuardSet", { follower: A, on: false }), deployments)).toMatchObject({ name: "GuardSet", on: false });
  });

  it("decodes theme registry events", () => {
    const t = (name: string, args: Record<string, unknown>) => log(deployments.themes, themesAbi as Abi, name, args);
    expect(decodeCopybookLog(t("ThemeRebalanced", { themeId: 2n, version: 3 }), deployments)).toMatchObject({ name: "ThemeRebalanced", themeId: 2n, version: 3 });
    expect(decodeCopybookLog(t("ThemeCreated", { themeId: 1n, creator: A, name: "AI majors" }), deployments)).toMatchObject({ name: "ThemeCreated", themeName: "AI majors" });
  });

  it("skips logs from other contracts, unknown events and ownership noise", () => {
    expect(decodeCopybookLog({ ...hub("Resumed", { follower: A }), address: A }, deployments)).toBeUndefined();
    expect(decodeCopybookLog({ ...hub("Resumed", { follower: A }), topics: [`0x${"01".repeat(32)}` as Hex] }, deployments)).toBeUndefined();
    const own = log(deployments.hub, hubAbi as Abi, "OwnershipTransferred", { previousOwner: A, newOwner: B });
    expect(decodeCopybookLog(own, deployments)).toBeUndefined();
    expect(decodeCopybookLogs([hub("Resumed", { follower: A }), own], deployments)).toHaveLength(1);
  });

  it("reports owner configuration events by name", () => {
    const e = decodeCopybookLog(hub("NewFollowsPaused", { paused: true }), deployments)!;
    expect(e).toMatchObject({ name: "Admin", event: "NewFollowsPaused", args: { paused: true } });
  });
});

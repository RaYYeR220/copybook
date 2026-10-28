import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { sourceIdOf, type CopybookEvent } from "@copybook/sdk";
import { followersOf, followerWallets } from "@/lib/followers";

const A = "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932" as Address;
const B = "0xcee40D3C7709404Cf60916BFEa39925fcB1f09Ed" as Address;
const T = sourceIdOf("Trader", "0xA1d0CB85c869e534Fe1e0c22af3b238301157b5d");
const TH = sourceIdOf("Theme", 1n);
let n = 0;
const at = (block: number) => ({ address: A, blockNumber: BigInt(block), transactionHash: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, logIndex: 0, transactionIndex: 0, topics: [], data: "0x" as Hex });
const f = (who: Address, sid: Hex, block: number): CopybookEvent => ({ name: "Followed", follower: who, sourceId: sid, kind: sid === TH ? "Theme" : "Trader", ref: 1n, log: at(block) });
const u = (who: Address, sid: Hex, block: number): CopybookEvent => ({ name: "Unfollowed", follower: who, sourceId: sid, flattened: true, log: at(block) });

describe("followers from hub events", () => {
  it("replays the live log: follow, unfollow, follow again", () => {
    // the hub's actual history on Hideki: A follows the leader, B follows thesis 1, A leaves and comes back
    const log = [f(A, T, 35025568), f(B, TH, 35026093), u(A, T, 35026952), f(A, T, 35027038)];
    expect(followersOf(log, T)).toEqual({ current: [A], ever: 1, lastBlock: 35027038n });
    expect(followersOf(log, TH)).toEqual({ current: [B], ever: 1, lastBlock: 35026093n });
  });

  it("counts nobody after an unfollow", () => {
    const r = followersOf([f(A, T, 1), u(A, T, 2)], T);
    expect(r.current).toEqual([]);
    expect(r.ever).toBe(1);
  });

  it("an unfollow of another source does not drop a later follow", () => {
    // a stale Unfollowed naming the old source cannot undo the newer follow
    expect(followersOf([f(A, T, 1), f(A, TH, 2), u(A, T, 3)], TH).current).toEqual([A]);
  });

  it("is zero for a source nobody followed", () => {
    expect(followersOf([f(A, T, 1)], TH)).toEqual({ current: [], ever: 0, lastBlock: undefined });
  });

  it("lists every copy wallet once, checksummed", () => {
    expect(followerWallets([f(A, T, 1), f(B, TH, 2), f(A, TH, 3)])).toEqual([A, B]);
  });
});

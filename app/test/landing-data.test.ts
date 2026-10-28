import { describe, expect, it } from "vitest";
import { bandRefusal, guardReview, LEADER, links, residueCross, sameBlockOpen, thesisRebalance } from "@/content/proof";
import { atlasGeometry } from "@/components/Nightfall/nightEngine";
import { LIMB } from "@/lib/atlas";
import { deployments, riskCommittee } from "@/lib/deployments";
import { fmtInt, shortHex } from "@/lib/format";
import { REASON_LABEL } from "@/lib/reasons";

const isTxHash = (h: string) => /^0x[0-9a-f]{64}$/i.test(h);

describe("landing proof", () => {
  it("names real transactions only", () => {
    for (const p of [sameBlockOpen, residueCross, bandRefusal]) {
      expect(isTxHash(p.leader.hash)).toBe(true);
      expect(isTxHash(p.copy.hash)).toBe(true);
      expect(p.copy.index).toBeGreaterThan(p.leader.index); // the copy runs after the move, inside the same block
    }
    expect(isTxHash(thesisRebalance.rebalance.hash)).toBe(true);
    expect(isTxHash(thesisRebalance.copy.hash)).toBe(true);
    expect(isTxHash(guardReview.verdictTx)).toBe(true);
    expect(isTxHash(guardReview.deliveryTx)).toBe(true);
  });

  it("links every proof to the explorer it lives on", () => {
    expect(links.copyTx).toBe(`https://explorer.testnet.somnia.network/tokyo/tx/${sameBlockOpen.copy.hash}`);
    expect(links.guardVerdict.startsWith("https://shannon-explorer.somnia.network/tx/0x")).toBe(true);
    expect(links.guardDelivery.startsWith("https://explorer.testnet.somnia.network/tokyo/tx/0x")).toBe(true);
  });

  it("states thesis weights that add up", () => {
    for (const legs of [thesisRebalance.before, thesisRebalance.after]) {
      expect(legs.reduce((a, l) => a + Math.abs(l.weightBps), 0)).toBe(10_000);
    }
  });

  it("reads the hub and the committee from deployments/*.json", () => {
    expect(deployments.chainId).toBe(50383);
    expect(shortHex(deployments.hub)).toBe("0xdF73…E154");
    expect(riskCommittee.size).toBeGreaterThan(0);
    expect(riskCommittee.threshold).toBeLessThanOrEqual(riskCommittee.size);
  });
});

describe("formatting", () => {
  it("groups block numbers and shortens hex", () => {
    expect(fmtInt(35025602)).toBe("35,025,602");
    expect(fmtInt(35025602n)).toBe("35,025,602");
    expect(shortHex(LEADER)).toBe("0xa1d0…7b5d");
    expect(shortHex("0x1234")).toBe("0x1234");
  });

  it("labels every on-chain refusal reason", () => {
    expect(Object.keys(REASON_LABEL)).toHaveLength(11);
    expect(REASON_LABEL.RiskGate).toBe("AI risk verdict");
  });
});

describe("atlas geometry", () => {
  // must agree with the plate's CSS placement (container units on the stage)
  it("centres the chart at (64%, 54%) with a limb of min(40% h, 27% w) on wide stages", () => {
    const g = atlasGeometry(1440, 900);
    expect(g).toMatchObject({ cx: 1440 * 0.64, cy: 900 * 0.54, mobile: false });
    expect(g.k * LIMB).toBeCloseTo(Math.min(900 * 0.4, 1440 * 0.27));
  });

  it("centres it at (50%, 55%) with a limb of min(44% w, 26% h) below 760px", () => {
    const g = atlasGeometry(390, 844);
    expect(g).toMatchObject({ cx: 195, cy: 844 * 0.55, mobile: true });
    expect(g.k * LIMB).toBeCloseTo(Math.min(390 * 0.44, 844 * 0.26));
  });
});

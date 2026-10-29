import { describe, expect, it } from "vitest";
import hideki from "../../deployments/hideki.json";
import risk from "../../deployments/risk.json";
import { deploymentsOf } from "@/lib/publicConfig";
import { configFrom } from "@/lib/server/config";

const cfg = configFrom(hideki, risk);
const lower = (a: string) => a.toLowerCase();

describe("server config from deployments/*.json", () => {
  it("reads the gate's rules from risk.json, not from code", () => {
    expect(cfg.risk).toEqual({
      verdictTtlSeconds: risk.hideki.verdictTtlSeconds,
      blockHoldSeconds: risk.hideki.blockHoldSeconds,
      reviewCooldownSeconds: risk.hideki.reviewCooldownSeconds,
      pendingTimeoutSeconds: risk.hideki.pendingTimeoutSeconds,
    });
  });

  it("finds the block the gate was deployed in, after the hub's", () => {
    expect(cfg.gateDeployBlock).toBe(35358791n);
    expect(cfg.gateDeployBlock > BigInt(hideki.deployBlock)).toBe(true);
  });

  it("falls back to the hub's deploy block when the gate's deploy is not recorded", () => {
    const c = configFrom(hideki, { ...risk, txs: [] });
    expect(c.gateDeployBlock).toBe(BigInt(hideki.deployBlock));
  });

  it("names the demo leader from the recorded review targets", () => {
    expect(lower(cfg.demoLeader)).toBe("0xa1d0cb85c869e534fe1e0c22af3b238301157b5d");
  });

  it("excludes our own contracts and wallets from any ranking", () => {
    const ours = cfg.ownWallets.map(lower);
    for (const a of [hideki.hub, hideki.owner, hideki.engine, risk.hideki.gate, cfg.demoLeader, "0x7d736A88978e94E60494Ff91C49Ba838EDfb1932"]) {
      expect(ours).toContain(lower(a));
    }
    // Shannon-side senders (committee relayers) never trade on Hideki and are not listed
    expect(ours).not.toContain(lower("0x55Acbe370872c7D90F504eF169217a00c29E2A33"));
    expect(new Set(ours).size).toBe(ours.length);
  });

  it("knows every wallet Copybook runs: excluded from rankings, marked ours, labelled on the tape", () => {
    const c = configFrom(hideki, risk);
    const own = c.ownWallets.map((a) => a.toLowerCase());
    for (const w of hideki.demoWallets) {
      expect(own).toContain(w.address.toLowerCase());
      expect(c.isOurs(w.address.toLowerCase())).toBe(true);
    }
    expect(c.isOurs(c.deployments.hub)).toBe(true);
    // the venue's margin bank is never ranked, but it is not ours
    expect(own).toContain(c.deployments.marginBank.toLowerCase());
    expect(c.isOurs(c.deployments.marginBank)).toBe(false);
    expect(c.walletLabels["0x7d736a88978e94e60494ff91c49ba838edfb1932"]).toBe("demo follower · ours");
    expect(c.walletLabels["0xcde791006ea6e99e9a614bc9d0995879e2cc5e72"]).toBe("demo agent · ours");
    expect(c.walletLabels["0x5397812d66f3233e0972b7aeb5e195a945504632"]).toBe("Copybook owner");
    // client components get the same list through the public deployments
    expect(deploymentsOf(c.publicConfig).demoWallets).toHaveLength(hideki.demoWallets.length);
  });

  it("links Shannon on the explorer named in risk.json", () => {
    expect(cfg.shannonExplorer).toBe("https://shannon-explorer.somnia.network");
    expect(cfg.reviewerUrl).toBe(risk.shannon.explorer);
  });

  it("maps a verdict's Shannon request id to the committee's tally", () => {
    const t = cfg.shannonTally(18072906n);
    expect(t).toEqual({
      requestId: 18072906n,
      requestTx: expect.stringMatching(/^0x854b3660b7/),
      tallyTx: expect.stringMatching(/^0x9e929a20a1/),
      tallyBlock: expect.any(Number),
      tier: "Block",
      votes: { ok: expect.any(Number), caution: expect.any(Number), blocked: expect.any(Number), responded: expect.any(Number) },
    });
    expect(t!.votes.blocked).toBeGreaterThanOrEqual(2);
    expect(cfg.shannonTally(1n)).toBeUndefined();
  });

  it("gives client components only small, JSON-safe values", () => {
    const pub = cfg.publicConfig;
    const wire = JSON.stringify(pub);
    expect(wire.length).toBeLessThan(2000);
    const d = pub.deployments as Record<string, unknown>;
    expect(d.hub).toBe(hideki.hub);
    expect(d.deployBlock).toEqual({ $bigint: String(hideki.deployBlock) });
    expect(deploymentsOf(pub).deployBlock).toBe(BigInt(hideki.deployBlock));
  });
});

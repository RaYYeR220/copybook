import { resolve } from "node:path";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { deploymentsFromJson } from "../src/deployments.ts";
import { loadDeployments } from "../src/node.ts";
import { hidekiJson, riskJson } from "./fake.ts";

describe("deployments", () => {
  it("loads the committed deployment files", () => {
    const d = loadDeployments(resolve(import.meta.dirname, "../../../deployments"));
    expect(d.chainId).toBe(50383);
    expect(d.hub).toMatch(/^0x/);
    expect(d.gate).toMatch(/^0x/);
    expect(d.deployBlock).toBeGreaterThan(0n);
    expect(d.operatorRegistry).toBe("0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a");
  });

  it("checksums addresses and honours an operatorRegistry override", () => {
    const d = deploymentsFromJson({ ...hidekiJson, hub: hidekiJson.hub.toLowerCase(), operatorRegistry: "0x00000000000000000000000000000000000000cc" }, { hideki: { hub: hidekiJson.hub, gate: riskJson.hideki.gate } });
    expect(d.hub).toBe(hidekiJson.hub);
    expect(d.operatorRegistry).toBe(getAddress("0x00000000000000000000000000000000000000cc"));
  });

  it("refuses files that disagree about the hub, or are missing a field", () => {
    expect(() => deploymentsFromJson(hidekiJson, { hideki: { hub: "0x00000000000000000000000000000000000000dd", gate: riskJson.hideki.gate } })).toThrow(/hub/);
    expect(() => deploymentsFromJson({ ...hidekiJson, themes: undefined }, riskJson)).toThrow(/themes/);
    expect(() => deploymentsFromJson(hidekiJson, {})).toThrow(/hideki/);
    expect(() => deploymentsFromJson({ ...hidekiJson, engine: "nope" }, riskJson)).toThrow(/address/);
  });
});

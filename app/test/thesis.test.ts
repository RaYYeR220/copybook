import { describe, expect, it } from "vitest";
import { decimalsOf, grossBps, legSide, netBps, pctOfBps } from "@/lib/thesis";

describe("thesis helpers", () => {
  it("reads a leg's side and share from its signed weight", () => {
    expect(legSide(7000)).toEqual({ side: "long", pct: "70%" });
    expect(legSide(-3000)).toEqual({ side: "short", pct: "30%" });
    expect(legSide(1250)).toEqual({ side: "long", pct: "12.5%" });
  });

  it("gross and net weight of the live thesis #1 (BTC 70 long, ETH 30 short)", () => {
    const legs = [{ weightBps: 7000 }, { weightBps: -3000 }];
    expect(grossBps(legs)).toBe(10000);
    expect(netBps(legs)).toBe(4000);
    expect(pctOfBps(10000)).toBe("100%");
    expect(pctOfBps(4050)).toBe("40.50%");
  });

  it("decimals from oneBase", () => {
    expect(decimalsOf(10n ** 8n)).toBe(8);
    expect(decimalsOf(10n ** 18n)).toBe(18);
    expect(decimalsOf(1n)).toBe(0);
  });
});

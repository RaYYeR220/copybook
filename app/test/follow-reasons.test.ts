import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { MIN_TANK, type PreflightReason } from "@copybook/sdk";
import { blocks, reasonView, reasonsFor } from "@/lib/follow/reasons";

const E = 10n ** 18n;
const ETH = "0xD6Cb1DD58580B84D76068aC21594219ce03aeddf" as Address;
const UNNAMED = "0x00000000000000000000000000000000000000e1" as Address;
const markets = { [ETH.toLowerCase()]: { symbol: "ETH", decimals: 18 } };

const r = (over: Partial<PreflightReason>): PreflightReason => ({ code: "INVALID_POLICY", severity: "error", message: "m", ...over });

describe("preflight reasons before signing", () => {
  it("an allocation below a leg's minimum names the leg, the exact minimum, and offers the figure with headroom", () => {
    const v = reasonView(r({ code: "ALLOCATION_BELOW_MINIMUM", field: "allocation", pool: ETH, required: 60n * E, message: "too small" }), markets, 66n * E);
    expect(v).toMatchObject({ severity: "error", market: "ETH-PERP", field: "allocation", message: "too small" });
    expect(v.needs).toBe("Least that opens every leg at today's marks: $60.00");
    expect(v.apply).toEqual({ field: "allocation", value: "66", label: "Use $66 (10% headroom)" });
    // without the headroom figure, the exact minimum rounded up to a dollar
    expect(reasonView(r({ code: "ALLOCATION_BELOW_MINIMUM", field: "allocation", required: 59_200_000_000_000_000_000n }), markets).apply).toEqual({ field: "allocation", value: "60", label: "Use $60" });
  });

  it("a cap below one order offers the least cap, naming an unnamed market by address", () => {
    const v = reasonView(r({ code: "CAP_BELOW_ONE_ORDER", field: "maxNotional", pool: UNNAMED, required: 10_510_000_000_000_000_000n }), markets);
    expect(v.market).toBe("0x0000…00e1");
    expect(v.needs).toBe("Least cap that fits one order here: $10.51");
    expect(v.apply).toEqual({ field: "maxNotional", value: "11", label: "Use $11" });
  });

  it("a whole-book cap below the basket, a tank below the minimum, a short wallet and an equity under the floor", () => {
    const basket = reasonView(r({ code: "TOTAL_CAP_BELOW_BASKET", field: "maxTotalNotional", required: 79_900_000_000_000_000_000n }), markets);
    expect(basket).toMatchObject({ needs: "The follow transaction opens $79.90 in total", apply: { field: "maxTotalNotional", value: "80" } });
    const order = reasonView(r({ code: "TOTAL_CAP_BELOW_ONE_ORDER", field: "maxTotalNotional", pool: ETH, required: 12n * E }), markets);
    expect(order).toMatchObject({ market: "ETH-PERP", needs: "Least whole-book cap that fits one order here: $12.00", apply: { field: "maxTotalNotional", value: "12", label: "Use $12" } });
    // a warning (whole-book follow) carries no fix
    expect(reasonView(r({ code: "TOTAL_CAP_BELOW_BASKET", severity: "warning", field: "maxTotalNotional", required: E }), markets).apply).toBeUndefined();
    const tank = reasonView(r({ code: "TANK_TOO_LOW", field: "tank", required: MIN_TANK }), markets);
    expect(tank).toMatchObject({ field: "tank", needs: "Least the hub takes: 0.2 STT", apply: { field: "tank", value: "0.2", label: "Use 0.2 STT" } });
    const short = reasonView(r({ code: "INSUFFICIENT_BALANCE", field: "tank", required: 5n * 10n ** 17n }), markets);
    expect(short.needs).toBe("The deposit is 0.5 STT, plus gas");
    expect(short.apply).toBeUndefined();
    expect(reasonView(r({ code: "EQUITY_BELOW_FLOOR", field: "equityFloor", required: 32_799_123_999_999_999_999n }), markets)).toMatchObject({ field: "equityFloor", needs: expect.stringContaining("$32.80") });
  });

  it("an edit's floor above equity is a strong warning that names the equity, with no fix to apply", () => {
    const v = reasonView(r({ code: "EQUITY_BELOW_FLOOR", severity: "warning", field: "equityFloor", required: 6_850_000_000_000_000_000n }), markets);
    expect(v).toMatchObject({ severity: "warning", strong: true, field: "equityFloor", needs: expect.stringContaining("$6.85") });
    expect(v.apply).toBeUndefined();
  });

  it("warnings and info never carry a fix", () => {
    const w = reasonView(r({ code: "SCALED_BELOW_MINIMUM", severity: "warning", pool: ETH }), markets);
    expect(w).toMatchObject({ severity: "warning", market: "ETH-PERP" });
    expect(w.apply).toBeUndefined();
  });

  it("the policy step leaves tank reasons to the tank step; flow reasons never show as form reasons", () => {
    const all = [
      r({ code: "TANK_TOO_LOW", field: "tank" }),
      r({ code: "ALLOCATION_BELOW_MINIMUM", field: "allocation" }),
      r({ code: "ALREADY_FOLLOWING" }),
      r({ code: "OPERATOR_NOT_APPROVED", severity: "info" }),
      r({ code: "ALLOW_ALL_MIRRORS_OPEN_BOOK", severity: "info" }),
    ];
    expect(reasonsFor("policy", all).map((x) => x.code)).toEqual(["ALLOCATION_BELOW_MINIMUM", "ALLOW_ALL_MIRRORS_OPEN_BOOK"]);
    expect(reasonsFor("tank", all).map((x) => x.code)).toEqual(["TANK_TOO_LOW", "ALLOCATION_BELOW_MINIMUM", "ALLOW_ALL_MIRRORS_OPEN_BOOK"]);
    expect(blocks("policy", [r({ code: "TANK_TOO_LOW", field: "tank" })])).toBe(false);
    expect(blocks("tank", [r({ code: "TANK_TOO_LOW", field: "tank" })])).toBe(true);
    expect(blocks("follow", [r({ code: "SCALED_BELOW_MINIMUM", severity: "warning" })])).toBe(false);
  });
});

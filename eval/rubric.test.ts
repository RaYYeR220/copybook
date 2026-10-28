// node --test runner: `cd e2e && npm run eval:test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSummary, rubricTier } from "./rubric.ts";

const base = "trades30d=40 activeDays30d=6 markets=2 realizedPnl30d=+120.0 liquidations30d=0 maxDrawdown30d=80.0 avgLeverage=n/a lastActive=2026-10-27";
const tier = (s: string) => rubricTier(s).tier;

test("the three summaries of the first live run", () => {
  // the profitable trader with no liquidations: OK under the rubric
  assert.equal(tier("trades30d=113 activeDays30d=7 markets=3 realizedPnl30d=+3773.3 liquidations30d=0 maxDrawdown30d=679.3 avgLeverage=n/a lastActive=2026-10-22"), "OK");
  assert.equal(
    tier("trades30d=115 activeDays30d=6 markets=3 realizedPnl30d=-979.7 liquidations30d=3 maxDrawdown30d=2609.9 maxDrawdownPct30d=92.2 avgLeverage=17.0 lastActive=2026-10-26"),
    "BLOCK",
  );
  assert.equal(tier("trades30d=42 activeDays30d=2 markets=2 realizedPnl30d=-0.2 liquidations30d=0 maxDrawdown30d=0.2 avgLeverage=n/a lastActive=2026-10-28"), "OK");
});

test("liquidation thresholds", () => {
  assert.equal(tier(base), "OK");
  assert.equal(tier(base.replace("liquidations30d=0", "liquidations30d=1")), "CAUTION");
  assert.equal(tier(base.replace("liquidations30d=0", "liquidations30d=2")), "BLOCK");
  assert.equal(tier(base.replace("liquidations30d=0", "liquidations30d=7")), "BLOCK");
});

test("drawdown percentage thresholds apply only when the key is present", () => {
  const withPct = (p: string) => base.replace("maxDrawdown30d=80.0", `maxDrawdown30d=80.0 maxDrawdownPct30d=${p}`);
  assert.equal(tier(withPct("24.9")), "OK");
  assert.equal(tier(withPct("25.0")), "CAUTION");
  assert.equal(tier(withPct("49.9")), "CAUTION");
  assert.equal(tier(withPct("50.0")), "BLOCK");
  assert.equal(tier(withPct("100.0")), "BLOCK");
  // the absolute drawdown alone never moves the tier
  assert.equal(tier(base.replace("maxDrawdown30d=80.0", "maxDrawdown30d=99999.0")), "OK");
});

test("thin or incomplete data is CAUTION", () => {
  assert.equal(tier(base.replace("trades30d=40", "trades30d=9")), "CAUTION");
  assert.equal(tier(base.replace("trades30d=40", "trades30d=10")), "OK");
  assert.equal(tier("trades30d=0 activeDays30d=0 markets=0 realizedPnl30d=+0.0 liquidations30d=0 maxDrawdown30d=n/a avgLeverage=n/a lastActive=n/a history=none"), "CAUTION");
  assert.equal(tier(`${base} partial=1`), "CAUTION");
});

test("BLOCK wins over CAUTION, and every rule that fired is listed", () => {
  const r = rubricTier(`${base.replace("trades30d=40", "trades30d=3").replace("liquidations30d=0", "liquidations30d=2")} partial=1`);
  assert.equal(r.tier, "BLOCK");
  assert.deepEqual(r.reasons, ["liquidations30d=2 >= 2"]);
  const c = rubricTier(`${base.replace("trades30d=40", "trades30d=3").replace("liquidations30d=0", "liquidations30d=1")} partial=1`);
  assert.deepEqual(c.reasons, ["liquidations30d=1", "trades30d=3 < 10", "partial=1"]);
});

test("unknown rule inputs are not safe", () => {
  assert.equal(tier(base.replace("liquidations30d=0", "liquidations30d=n/a")), "CAUTION");
  assert.equal(tier(base.replace("trades30d=40 ", "")), "CAUTION");
  assert.equal(tier(base.replace("maxDrawdown30d=80.0", "maxDrawdown30d=80.0 maxDrawdownPct30d=n/a")), "CAUTION");
});

test("parseSummary reads key=value tokens", () => {
  const kv = parseSummary(`${base} history=none`);
  assert.equal(kv.get("trades30d"), "40");
  assert.equal(kv.get("avgLeverage"), "n/a");
  assert.equal(kv.get("history"), "none");
  assert.equal(kv.has("maxDrawdownPct30d"), false);
});

test("the rubric line served to the validators gives the same tier as the full summary", async () => {
  // by path, so the eval needs only e2e's install (e2e links @copybook/stats for its own sources)
  const { riskRubric, riskSummary } = await import("../packages/stats/src/index.ts");
  const base = {
    trader: "0x0000000000000000000000000000000000000001" as const,
    windowDays: 30,
    trades30d: 40,
    activeDays30d: 6,
    marketsTraded: 2,
    realizedPnl30d: -120,
    liquidations30d: 0,
    maxDrawdownAbs30d: 80,
    maxDrawdownPct30d: null as number | null,
    avgLeverage: null,
    lastActiveAt: "2026-10-27T10:00:00.000Z",
    hasHistory: true,
    truncated: false,
  };
  let cases = 0;
  for (const liquidations30d of [0, 1, 2, 5])
    for (const trades30d of [0, 9, 10, 2000])
      for (const maxDrawdownPct30d of [null, 0, 24.9, 25, 49.96, 50, 100])
        for (const hasHistory of [true, false])
          for (const truncated of [false, true]) {
            const s = { ...base, liquidations30d, trades30d, maxDrawdownPct30d, hasHistory, truncated };
            const line = riskRubric(s);
            assert.deepEqual(rubricTier(line), rubricTier(riskSummary(s)), line);
            cases++;
          }
  assert.equal(cases, 448);
});

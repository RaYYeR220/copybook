import { getAddress, type Address } from "viem";
import { FakeChain, USDSO, deployments } from "./fake.ts";
import type { Policy } from "../src/types.ts";

export const E = 10n ** 18n;
export const ME: Address = getAddress("0x00000000000000000000000000000000000000aa");
export const TRADER: Address = getAddress("0x00000000000000000000000000000000000000bb");
export const BTC: Address = getAddress("0x00000000000000000000000000000000000000b1");
export const ETH: Address = getAddress("0x00000000000000000000000000000000000000e1");
export const ZERO32 = `0x${"00".repeat(32)}` as const;

export const policy = (p: Partial<Policy> = {}): Policy => ({
  scaleBps: 10_000,
  allocation: 100n * E,
  maxNotional: 500n * E,
  maxTotalNotional: 0n,
  bandBps: 50,
  equityFloor: 0n,
  ...p,
});

const noFollow = [ZERO32, 0, 0n, { scaleBps: 0, allocation: 0n, maxNotional: 0n, maxTotalNotional: 0n, bandBps: 0, equityFloor: 0n }, false, 0];

/** A healthy Hideki2 stand-in: one two-leg theme (BTC 40% long, ETH 20% short), an approved operator, a clean trader. */
export function world(): FakeChain {
  const c = new FakeChain();
  const { hub, themes, gate, marginBank, operatorRegistry } = deployments;
  c.on(hub, "followsPaused", false);
  c.on(hub, "followOf", noFollow);
  c.on(hub, "tankOf", 0n);
  c.on(hub, "syncedPools", []);
  c.on(hub, "pendingOf", [false, false]);
  c.on(hub, "themeSyncOf", [0, false]);
  c.on(themes, "themeCount", 1n);
  c.on(themes, "legsOf", [
    { pool: BTC, weightBps: 4_000 },
    { pool: ETH, weightBps: -2_000 },
  ]);
  c.on(themes, "themeOf", [TRADER, "AI majors", "ipfs://x", 1]);
  c.on(gate, "guardOf", true);
  c.on(gate, "verdictOf", { tier: 1, reviewedAt: 1n, shannonRequestId: 0n, summaryHash: ZERO32 });
  c.on(gate, "reviewFee", E / 2n);
  c.on(gate, "pendingOf", { nonce: 0n, requestedAt: 0n });
  c.on(operatorRegistry, "isGloballyApproved", true);
  c.on(marginBank, "getAccountHealth", [1_000n * E, 0n, 0n, 0n]);
  c.on(marginBank, "getPosition", { size: 0n, avgEntryPrice: 0n, entryFundingIndex: 0n, lastUpdatedTimestampNs: 0n });
  const z = "0x0000000000000000000000000000000000000000";
  c.on(marginBank, "getSystemConfig", { marginBank, collateralToken: USDSO, perpPoolFactory: z, liquidationEngine: z, insuranceFund: z, feeRecipient: z, maxLeverageLimit: 20, fullyWired: true });
  c.on(USDSO, "balanceOf", 0n);
  c.on(USDSO, "allowance", 0n);
  c.market(BTC, { mark: 60_000n * E, tick: E / 10n, minQty: 13n * 10n ** 13n, lot: 10n ** 13n, oneBase: E });
  c.market(ETH, { mark: 3_000n * E, tick: E / 100n, minQty: 4n * 10n ** 15n, lot: 10n ** 15n, oneBase: E });
  return c;
}

/** What `followOf` returns for a wallet that follows. */
export const followed = (kind: 0 | 1, ref: bigint, over: Partial<Policy> = {}, paused = false) => [`0x${"11".repeat(32)}`, kind, ref, policy(over), paused, 0];

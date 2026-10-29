import { resolve } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { createCopybook } from "../src/client.ts";
import { loadDeployments } from "../src/node.ts";

// One gentle, read-only pass over the live Hideki2 contracts. Off by default: COPYBOOK_LIVE=1 turns it on.
const live = process.env.COPYBOOK_LIVE === "1" ? describe : describe.skip;

live("live Hideki2 (read-only)", () => {
  const deployments = loadDeployments(resolve(import.meta.dirname, "../../../deployments"));
  const publicClient = createPublicClient({ transport: http(process.env.HIDEKI_RPC ?? "https://api.hideki2.infra.testnet.somnia.network", { retryCount: 3 }) });
  const cb = createCopybook({ publicClient, deployments });
  const nobody = "0x000000000000000000000000000000000000dEaD";

  it("is on the chain the deployments name", async () => {
    expect(await publicClient.getChainId()).toBe(deployments.chainId);
  });

  it("reads the hub, the registry and the gate", async () => {
    expect(await cb.followOf(nobody)).toBeNull();
    expect(await cb.tankOf(nobody)).toBe(0n);
    expect((await cb.gasParams()).riskGateGas).toBeGreaterThan(0n);
    expect(await cb.reviewFee()).toBeGreaterThan(0n);
    expect(await cb.guardOf(nobody)).toBe(true);
    expect((await cb.verdictOf(nobody)).tier).toBe("None");
    expect(await cb.themeCount()).toBeGreaterThan(0n);
  });

  it("finds USDso as the margin bank's collateral and reads a wallet's spot balance and allowance", async () => {
    const token = await cb.marginToken();
    expect(await publicClient.readContract({ address: token, abi: parseAbi(["function symbol() view returns (string)"]), functionName: "symbol" })).toBe("USDso");
    const f = await cb.marginFunding(nobody);
    expect(f.token).toBe(token);
    expect(f.allowance).toBe(0n);
    expect(f.spot).toBeGreaterThanOrEqual(0n);
  });

  it("sizes a live thesis's minimum allocation from the venue's own market parameters", async () => {
    const min = await cb.themeMinimum(1n);
    expect(min.allocation).toBeGreaterThan(0n);
    expect(min.theme.legs.length).toBeGreaterThan(0);
    const r = await cb.preflightFollow({ kind: "Theme", source: 1n, policy: { scaleBps: 0, allocation: min.allocation / 2n, maxNotional: 10n ** 24n, maxTotalNotional: 0n, bandBps: 50, equityFloor: 0n }, tank: 10n ** 18n, account: nobody });
    expect(r.reasons.some((x) => x.code === "ALLOCATION_BELOW_MINIMUM")).toBe(true);
  });

  it("reads a recent slice of hub history", async () => {
    const head = await publicClient.getBlockNumber();
    const h = await cb.history({ fromBlock: head - 2_000n, toBlock: head });
    expect(Array.isArray(h.events)).toBe(true);
  });
});

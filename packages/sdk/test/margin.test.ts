import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, getAddress, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCopybook } from "../src/client.ts";
import { CopybookError } from "../src/errors.ts";
import { marginErrorsAbi } from "../src/abi/marginErrors.ts";
import { USDSO, deployments } from "./fake.ts";
import { E, ME, world } from "./world.ts";

const bank = deployments.marginBank;
const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const bankWrites = parseAbi(["function deposit(uint256 amount)"]);

const make = (c: ReturnType<typeof world>) => createCopybook({ publicClient: c.publicClient, walletClient: c.wallet(ME), deployments });
const read = (c: ReturnType<typeof world>) => createCopybook({ publicClient: c.publicClient, deployments });

/** eth_call requests addressed to `to`. */
const callsTo = (c: ReturnType<typeof world>, to: string) =>
  c.rpc.filter((r) => r.method === "eth_call" && ((r.params as { to: string }[])[0]?.to ?? "").toLowerCase() === to.toLowerCase());

async function rejection(p: Promise<unknown>): Promise<CopybookError> {
  try {
    await p;
  } catch (e) {
    return e as CopybookError;
  }
  throw new Error("expected a rejection");
}

describe("moving spot USDso into the perps account", () => {
  it("names USDso from the bank's own config, reading it once per client", async () => {
    const c = world();
    const cb = read(c);
    expect(await cb.marginToken()).toBe(getAddress(USDSO));
    await cb.marginToken();
    await cb.spotUsdsoBalance(ME);
    expect(callsTo(c, bank)).toHaveLength(1);
  });

  it("reads the wallet's spot USDso and the bank's allowance on it", async () => {
    const c = world();
    c.on(USDSO, "balanceOf", (args: readonly unknown[]) => (getAddress(args[0] as string) === ME ? 25n * E : 0n));
    c.on(USDSO, "allowance", (args: readonly unknown[]) => (getAddress(args[0] as string) === ME && getAddress(args[1] as string) === bank ? 5n * E : 0n));
    const cb = read(c);
    expect(await cb.spotUsdsoBalance(ME)).toBe(25n * E);
    expect(await cb.marginAllowance(ME)).toBe(5n * E);
    expect(await cb.marginFunding(ME)).toEqual({ token: getAddress(USDSO), spot: 25n * E, allowance: 5n * E });
  });

  it("approveMargin approves the margin bank for exactly the amount, on USDso", async () => {
    const c = world();
    const tx = await make(c).approveMargin(3n * E);
    expect(tx.hash).toMatch(/^0x/);
    const sent = c.sent.at(-1)!;
    expect(getAddress(sent.to)).toBe(getAddress(USDSO));
    const d = decodeFunctionData({ abi: erc20, data: sent.data });
    expect(d.functionName).toBe("approve");
    expect(d.args).toEqual([bank, 3n * E]);
  });

  it("depositMargin sends deposit(amount) to the margin bank once balance and allowance cover it", async () => {
    const c = world();
    c.on(USDSO, "balanceOf", 25n * E);
    c.on(USDSO, "allowance", 3n * E);
    const out = await (await make(c).depositMargin(3n * E)).wait();
    expect(out.receipt.status).toBe("success");
    const sent = c.sent.at(-1)!;
    expect(getAddress(sent.to)).toBe(bank);
    const d = decodeFunctionData({ abi: bankWrites, data: sent.data as Hex });
    expect(d.functionName).toBe("deposit");
    expect(d.args).toEqual([3n * E]);
    // the node's estimate, with the SDK's headroom
    expect(BigInt(sent.gas!)).toBe((2_000_000n * 3n) / 2n);
  });

  it("refuses before signing: more than the wallet holds, an allowance short of the amount, or nothing at all", async () => {
    const c = world();
    c.on(USDSO, "balanceOf", 2n * E);
    c.on(USDSO, "allowance", 10n * E);
    const poor = await rejection(make(c).depositMargin(3n * E));
    expect(poor.code).toBe("INSUFFICIENT_FUNDS");
    expect(poor.message).toContain("holds 2 USDso");

    c.on(USDSO, "balanceOf", 25n * E);
    c.on(USDSO, "allowance", 1n * E);
    const unapproved = await rejection(make(c).depositMargin(3n * E));
    expect(unapproved.code).toBe("NEEDS_APPROVAL");
    expect(unapproved.message).toContain("approve at least 3 USDso");

    expect((await rejection(make(c).depositMargin(0n))).code).toBe("INVALID_INPUT");
    expect((await rejection(make(c).approveMargin(0n))).code).toBe("INVALID_INPUT");
    expect(c.sent).toHaveLength(0);
  });

  it("a revert at the estimate is named when the venue's errors know it, and said plainly when not", async () => {
    const c = world();
    c.on(USDSO, "balanceOf", 25n * E);
    c.on(USDSO, "allowance", 25n * E);
    // the balance moved between the read and the estimate: USDso's own error comes back
    c.revertEstimateWith = encodeErrorResult({ abi: marginErrorsAbi, errorName: "ERC20InsufficientBalance", args: [ME, 1n * E, 3n * E] });
    const named = await rejection(make(c).depositMargin(3n * E));
    expect(named).toMatchObject({ code: "REVERTED", revert: "ERC20InsufficientBalance", message: "The wallet holds less USDso on spot than that." });
    // an error no ABI here declares
    c.revertEstimateWith = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
    expect(await rejection(make(c).depositMargin(3n * E))).toMatchObject({ code: "REVERTED", message: "The margin bank refused this deposit." });
    expect(await rejection(make(c).approveMargin(3n * E))).toMatchObject({ code: "REVERTED", message: "USDso refused this approval." });
    expect(c.sent).toHaveLength(0);
  });

  it("checks the wallet's chain like every other write", async () => {
    const c = world();
    c.on(USDSO, "balanceOf", 25n * E);
    c.on(USDSO, "allowance", 25n * E);
    c.chainId = 1;
    expect((await rejection(make(c).depositMargin(1n * E))).code).toBe("WRONG_CHAIN");
    expect((await rejection(make(c).approveMargin(1n * E))).code).toBe("WRONG_CHAIN");
    expect(c.sent).toHaveLength(0);
  });

  it("signs with a local key and sends the raw transaction, as a script does", async () => {
    const c = world();
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    c.on(USDSO, "balanceOf", 25n * E);
    c.on(USDSO, "allowance", 25n * E);
    const cb = createCopybook({ publicClient: c.publicClient, walletClient: c.localWallet(account), deployments });
    await cb.depositMargin(4n * E);
    const sent = c.sent.at(-1)!;
    expect(sent.raw).toBe(true);
    expect(getAddress(sent.from!)).toBe(account.address);
    expect(getAddress(sent.to)).toBe(bank);
  });
});

import { describe, expect, it } from "vitest";
import type { EIP1193Provider } from "viem";
import { addChainParameters, addHidekiToWallet, isUserRejection } from "@/lib/wallet/addNetwork";
import { hideki } from "@/lib/wallet/hideki";

const providerAnswering = (answer: () => unknown) => {
  const calls: unknown[] = [];
  const provider = {
    request: async (args: unknown) => {
      calls.push(args);
      return answer();
    },
  } as unknown as EIP1193Provider;
  return { provider, calls };
};

describe("Hideki chain", () => {
  it("is Somnia's Hideki testnet with STT as gas", () => {
    expect(hideki.id).toBe(50383);
    expect(hideki.nativeCurrency).toEqual({ name: "Somnia Test Token", symbol: "STT", decimals: 18 });
    expect(hideki.rpcUrls.default.http).toEqual(["https://api.hideki2.infra.testnet.somnia.network"]);
    expect(hideki.rpcUrls.default.webSocket).toEqual(["wss://api.hideki2.infra.testnet.somnia.network/ws"]);
    expect(hideki.blockExplorers.default.url).toBe("https://explorer.testnet.somnia.network/tokyo");
  });

  it("asks the wallet to add it with EIP-3085 parameters", () => {
    expect(addChainParameters(hideki)).toEqual({
      chainId: "0xc4cf",
      chainName: "Somnia Hideki testnet (Tokyo)",
      nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
      rpcUrls: ["https://api.hideki2.infra.testnet.somnia.network"],
      blockExplorerUrls: ["https://explorer.testnet.somnia.network/tokyo"],
    });
  });
});

describe("addHidekiToWallet", () => {
  it("sends wallet_addEthereumChain and reports acceptance", async () => {
    const { provider, calls } = providerAnswering(() => null);
    await expect(addHidekiToWallet(provider)).resolves.toBe(true);
    expect(calls).toEqual([{ method: "wallet_addEthereumChain", params: [addChainParameters(hideki)] }]);
  });

  it("reports a declined request as false", async () => {
    const { provider } = providerAnswering(() => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    await expect(addHidekiToWallet(provider)).resolves.toBe(false);
  });

  it("rethrows anything else", async () => {
    const { provider } = providerAnswering(() => {
      throw Object.assign(new Error("Internal error"), { code: -32603 });
    });
    await expect(addHidekiToWallet(provider)).rejects.toThrow("Internal error");
  });
});

describe("isUserRejection", () => {
  it("finds a 4001 or a UserRejectedRequestError down the cause chain", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ name: "ConnectorError", cause: { name: "UserRejectedRequestError" } })).toBe(true);
    expect(isUserRejection({ code: 4902 })).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

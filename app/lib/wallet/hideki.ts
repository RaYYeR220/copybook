import { defineChain } from "viem";

/** Somnia's Hideki testnet, where dreamDEX perps and the Copybook hub run. */
export const hideki = defineChain({
  id: 50383,
  name: "Somnia Hideki testnet (Tokyo)",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://api.hideki2.infra.testnet.somnia.network"],
      webSocket: ["wss://api.hideki2.infra.testnet.somnia.network/ws"],
    },
  },
  blockExplorers: {
    default: { name: "Somnia explorer", url: "https://explorer.testnet.somnia.network/tokyo" },
  },
  testnet: true,
});

export const EXPLORER_URL = hideki.blockExplorers.default.url;

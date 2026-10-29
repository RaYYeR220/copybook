// 03: eth_getStorageAt answers "0x" for a slot that holds zero, instead of a 32-byte zero word.
// Read-only. Run: node 03-rpc-empty-storage-slot.ts
import { createPublicClient, decodeAbiParameters, hexToBigInt, http, type Address } from "viem";
import { heading, rpc, RPC } from "./lib.ts";

const DISTRIBUTOR: Address = "0x2ACD9EFdA721450906bfE1bef3edE269636E42C4"; // VoucherDistributor proxy (MarginBank.getCreditGranter())
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967 implementation slot: set
const EMPTY_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"; // EIP-1967 admin slot: zero on this proxy

heading(`raw JSON-RPC, Hideki (${new Date().toISOString()})`);
console.log("a slot that holds a value:");
await rpc("eth_getStorageAt", [DISTRIBUTOR, IMPL_SLOT, "latest"]);
console.log("a slot that holds zero:");
await rpc("eth_getStorageAt", [DISTRIBUTOR, EMPTY_SLOT, "latest"]);

heading("other Somnia networks: slot 0x0 of an address with no storage");
for (const url of ["https://api.infra.testnet.somnia.network", "https://api.infra.mainnet.somnia.network"]) {
  console.log(url);
  await rpc("eth_getStorageAt", ["0x000000000000000000000000000000000000dEaD", "0x0", "latest"], { url });
}

heading("the same request on a reference Ethereum mainnet node (the slot is empty there too)");
await rpc("eth_getStorageAt", [DISTRIBUTOR, EMPTY_SLOT, "latest"], { url: "https://ethereum-rpc.publicnode.com" });

heading("what a viem client gets");
const client = createPublicClient({ transport: http(RPC) });
const word = await client.getStorageAt({ address: DISTRIBUTOR, slot: EMPTY_SLOT });
console.log("getStorageAt ->", JSON.stringify(word));
const attempts: [string, () => unknown][] = [
  ["hexToBigInt(word)", () => hexToBigInt(word!)],
  ["decodeAbiParameters([uint256], word)", () => decodeAbiParameters([{ type: "uint256" }], word!)],
  ["BigInt(word)", () => BigInt(word!)],
];
for (const [label, f] of attempts) {
  try {
    console.log(label, "->", f());
  } catch (e) {
    console.log(label, "threw:", (e as Error).message.split("\n")[0]);
  }
}

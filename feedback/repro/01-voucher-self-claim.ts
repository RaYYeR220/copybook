// 01: getPerpVoucherEligibility says "eligible", VoucherDistributor.claim() reverts 0x3e31dcc2 for every account.
// Read-only: the claim is simulated with eth_call from a random address that has never existed.
// Run: node 01-voucher-self-claim.ts
import { decodeAbiParameters, toFunctionSelector, type Address, type Hex } from "viem";
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, contractErrorsAbi, decodeRevert } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { heading, rpc } from "./lib.ts";

const bank = SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank as Address;
const markets = new SomniaMarkets({ chain: hidekiTestnet, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES });
const randomAddress = (): Address =>
  `0x${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const CLAIM = toFunctionSelector("claim()"); // 0x4e71d92d

heading(`1. campaign (SDK getPerpVoucherCampaign), as of ${new Date().toISOString()}`);
const campaign = await markets.client.getPerpVoucherCampaign(bank);
if (!campaign) throw new Error("no campaign on this bank");
const now = BigInt(Math.floor(Date.now() / 1000));
console.log({
  distributor: campaign.distributor,
  open: campaign.startsAt <= now && now < campaign.endsAt,
  claimsRemaining: campaign.claimsRemaining.toString(),
  grantAmount: campaign.grantAmount.toString(),
});

// A fresh address (no positions, no orders, never claimed) and a busy trading account for contrast.
const accounts: Address[] = [randomAddress(), "0x47537e3a3ea6e9391f3b26ea45618db6828c8bff"];
for (const account of accounts) {
  heading(`2. ${account}`);
  const eligibility = await markets.client.getPerpVoucherEligibility(bank, account);
  console.log("SDK getPerpVoucherEligibility:", eligibility);
  console.log("eth_call claim() from this account:");
  const sim = await rpc("eth_call", [{ from: account, to: campaign.distributor, data: CLAIM }, "latest"]);
  console.log("eth_estimateGas claim() from this account:");
  await rpc("eth_estimateGas", [{ from: account, to: campaign.distributor, data: CLAIM }]);
  const data = sim.error?.data as Hex | undefined;
  if (data) {
    const decoded = decodeRevert({ data, message: "execution reverted" });
    console.log("SDK decodeRevert:", { errorName: decoded.errorName, data: decoded.data });
  }
}

heading("3. is 0x3e31dcc2 in the SDK's contractErrorsAbi?");
const abi: readonly { type: string; name: string; inputs: readonly { type: string }[] }[] = contractErrorsAbi;
const known = abi.filter((e) => e.type === "error");
const selectors = new Map(known.map((e) => [toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`), e.name]));
console.log(`${known.length} errors, 0x3e31dcc2 ->`, selectors.get("0x3e31dcc2") ?? "not present");
console.log("toFunctionSelector('SelfClaimDisabled()') =", toFunctionSelector("SelfClaimDisabled()"));

heading("4. the distributor's claim policy (selector 0x6c87f4b2 = getClaimPolicy())");
console.log("toFunctionSelector('getClaimPolicy()') =", toFunctionSelector("getClaimPolicy()"));
const policy = await rpc("eth_call", [{ to: campaign.distributor, data: "0x6c87f4b2" }, "latest"]);
console.log(
  "decoded as (uint64,bool,bool,bool):",
  decodeAbiParameters([{ type: "uint64" }, { type: "bool" }, { type: "bool" }, { type: "bool" }], policy.result),
);

heading("5. how grants are actually issued: a recent Credited batch");
const tx = await rpc("eth_getTransactionByHash", ["0xe3a89e819ea86a0beea80e39b9e0ba768a178ee868949958d54722b34faa415f"], { quiet: true });
console.log({ from: tx.result.from, to: tx.result.to, selector: tx.result.input.slice(0, 10), addressesInBatch: Number(BigInt(`0x${tx.result.input.slice(74, 138)}`)) });
process.exit(0);

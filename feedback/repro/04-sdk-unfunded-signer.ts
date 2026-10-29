// 04: an SDK write from a signer with no STT throws ContractRevertError ("<fn> reverted: Missing or invalid
// parameters") instead of RpcError. The key is generated here, never funded, and nothing can be mined.
// Run: node 04-sdk-unfunded-signer.ts
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES, ContractRevertError, RpcError } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { heading, rpc } from "./lib.ts";

const pk = generatePrivateKey(); // throwaway, in memory only
const signer = privateKeyToAccount(pk);
const markets = new SomniaMarkets({ chain: hidekiTestnet, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey: pk });
const ADDR = SOMNIA_HIDEKI_TESTNET_ADDRESSES;
const OPERATOR_REGISTRY = "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a"; // dreamDEX OperatorPermissionsRegistry on Hideki

heading(`signer ${signer.address}`);
await rpc("eth_getBalance", [signer.address, "latest"]);

function show(label: string, e: unknown) {
  const err = e as { constructor: { name: string }; message: string; errorName?: string; data?: string; cause?: unknown };
  console.log(`${label}:`, {
    class: err.constructor.name,
    "instanceof ContractRevertError": e instanceof ContractRevertError,
    "instanceof RpcError": e instanceof RpcError,
    errorName: err.errorName,
    data: err.data,
    message: err.message.split("\n")[0],
  });
  let c: any = err.cause;
  for (let i = 0; c && i < 4; i++, c = c.cause) {
    if (c.details || c.code) console.log(`   cause ${i}: ${c.name} code=${c.code} details=${c.details}`);
  }
}

heading("SDK writes");
try {
  await markets.trader.setOperatorApprovalGlobal({
    operator: "0x000000000000000000000000000000000000dEaD",
    selectors: ["0x80054449"], // placeOrderFor
    approved: true,
    operatorRegistry: OPERATOR_REGISTRY,
  });
} catch (e) {
  show("trader.setOperatorApprovalGlobal", e);
}
try {
  await markets.trader.claimPerpVoucher({ marginBank: ADDR.marginBank });
} catch (e) {
  show("trader.claimPerpVoucher", e);
}

heading("what the node answers to the same kind of transaction");
const raw = await signer.signTransaction({
  chainId: hidekiTestnet.id,
  type: "eip1559",
  to: "0x000000000000000000000000000000000000dEaD",
  value: 0n,
  gas: 21_000n,
  maxFeePerGas: 20_000_000_000n,
  maxPriorityFeePerGas: 0n,
  nonce: 0,
});
await rpc("eth_sendRawTransaction", [raw]);
process.exit(0);

import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { gateAbi } from "../src/abi/gate.ts";
import { hubAbi } from "../src/abi/hub.ts";
import { themesAbi } from "../src/abi/themes.ts";
import { poolAbi } from "../src/market.ts";
import { deploymentsFromJson } from "../src/deployments.ts";
import type { Deployments } from "../src/types.ts";
import type { LocalAccount } from "viem/accounts";

export const hidekiJson = {
  chainId: 50383,
  hub: "0xdF73BBbB6517B712BBeD9bfAe6253A5E1FCDE154",
  engine: "0xE37F735b8E43e63E56f7E550e732Ab808257D56A",
  themes: "0xbcA03A20eaf337b7bb35DBD76512Af5BC61f6c79",
  marginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
  groupSize: 8,
  deployBlock: 35024222,
};
export const riskJson = { hideki: { hub: hidekiJson.hub, gate: "0xEe54c49E9e70a0e5C2218Eec1b1BDBd4e1Cb20f1" } };
export const deployments: Deployments = deploymentsFromJson(hidekiJson, riskJson);

/** USDso on Hideki2, the margin bank's collateral (the fake bank names it in getSystemConfig). */
export const USDSO: Address = "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72";

const bankAbi = parseAbi([
  "function getPosition(address account, address pool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
  "function getSystemConfig() view returns ((address marginBank, address collateralToken, address perpPoolFactory, address liquidationEngine, address insuranceFund, address feeRecipient, uint16 maxLeverageLimit, bool fullyWired))",
  "function deposit(uint256 amount)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const registryAbi = parseAbi(["function isGloballyApproved(address owner, address operator, bytes4 selector) view returns (bool)"]);

const abisByAddress = (): Map<string, Abi> =>
  new Map<string, Abi>([
    [deployments.hub.toLowerCase(), hubAbi as Abi],
    [deployments.themes.toLowerCase(), themesAbi as Abi],
    [deployments.gate.toLowerCase(), gateAbi as Abi],
    [deployments.marginBank.toLowerCase(), bankAbi],
    [deployments.operatorRegistry.toLowerCase(), registryAbi],
    [USDSO.toLowerCase(), erc20Abi],
  ]);

type Handler = (args: readonly unknown[]) => unknown;

/** A scripted chain: eth_call answers come from handlers keyed by `<address>.<function>`; pools answer by address. */
export class FakeChain {
  handlers = new Map<string, Handler>();
  rpc: { method: string; params: unknown }[] = [];
  logs: Record<string, unknown>[] = [];
  head = 1_000n;
  chainId = 50383;
  balance = 10n * 10n ** 18n;
  getLogsFailAbove: bigint | undefined;
  /** Every transaction sent; `raw` marks one signed by the client and sent with eth_sendRawTransaction. */
  sent: { to: Address; data: Hex; value?: Hex; gas?: Hex; from?: Address; raw?: boolean }[] = [];
  estimates: bigint = 2_000_000n;
  revertEstimateWith: Hex | undefined;
  receiptLogs: Record<string, unknown>[] = [];
  receiptStatus: "0x1" | "0x0" = "0x1";

  on(address: Address, fn: string, h: Handler | unknown) {
    this.handlers.set(`${address.toLowerCase()}.${fn}`, typeof h === "function" ? (h as Handler) : () => h);
    return this;
  }

  market(pool: Address, m: { mark: bigint; tick: bigint; minQty: bigint; lot: bigint; oneBase: bigint }) {
    this.on(pool, "getMarkPrice", m.mark);
    this.on(pool, "getOneBase", m.oneBase);
    this.on(pool, "getOrderBookParameters", { tickSize: m.tick, minQuantity: m.minQty, lotSize: m.lot });
    return this;
  }

  private async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.rpc.push({ method, params });
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return toHex(this.chainId);
      case "eth_blockNumber":
        return toHex(this.head);
      case "eth_getBalance":
        return toHex(this.balance);
      case "eth_call": {
        const { to, data } = p[0] as { to: Address; data: Hex };
        const abi = abisByAddress().get(to.toLowerCase()) ?? (poolAbi as Abi);
        const decoded = decodeFunctionData({ abi, data });
        const key = `${to.toLowerCase()}.${decoded.functionName}`;
        const h = this.handlers.get(key);
        if (!h) throw new Error(`fake chain: no handler for ${key}`);
        const out = h(decoded.args ?? []);
        return encodeFunctionResult({ abi, functionName: decoded.functionName, result: out as never });
      }
      case "eth_estimateGas":
        if (this.revertEstimateWith) {
          throw Object.assign(new Error("execution reverted"), { code: 3, data: this.revertEstimateWith });
        }
        return toHex(this.estimates);
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_getBlockByNumber":
        return { number: toHex(this.head), hash: `0x${"cd".repeat(32)}`, baseFeePerGas: "0x1", timestamp: "0x0", transactions: [] };
      case "eth_sendRawTransaction": {
        const signed = p[0] as `0x02${string}`;
        const tx = parseTransaction(signed);
        const from = await recoverTransactionAddress({ serializedTransaction: signed });
        this.sent.push({ to: tx.to!, data: tx.data!, value: tx.value !== undefined ? toHex(tx.value) : undefined, gas: tx.gas !== undefined ? toHex(tx.gas) : undefined, from, raw: true });
        return `0x${"ab".repeat(32)}`;
      }
      case "eth_sendTransaction": {
        const tx = p[0] as { to: Address; data: Hex; value?: Hex; gas?: Hex; from?: Address };
        this.sent.push(tx);
        return `0x${"ab".repeat(32)}`;
      }
      case "eth_getTransactionReceipt":
        return {
          transactionHash: `0x${"ab".repeat(32)}`,
          blockHash: `0x${"cd".repeat(32)}`,
          blockNumber: toHex(this.head),
          transactionIndex: "0x0",
          from: deployments.hub,
          to: deployments.hub,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logs: this.receiptLogs,
          logsBloom: `0x${"00".repeat(256)}`,
          status: this.receiptStatus,
          type: "0x2",
        };
      case "eth_getLogs": {
        const f = p[0] as { fromBlock: Hex; toBlock: Hex; address: Address; topics: (Hex | Hex[] | null)[] };
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        if (this.getLogsFailAbove !== undefined && to - from + 1n > this.getLogsFailAbove) throw new Error("block range too large");
        const t0 = f.topics[0];
        return this.logs.filter((l) => {
          const bn = BigInt(l.blockNumber as Hex);
          if (bn < from || bn > to) return false;
          if ((l.address as string).toLowerCase() !== f.address.toLowerCase()) return false;
          const topics = l.topics as Hex[];
          if (Array.isArray(t0) && !t0.includes(topics[0]!)) return false;
          const t1 = f.topics[1];
          if (t1 && topics[1] !== t1) return false;
          return true;
        });
      }
      default:
        throw new Error(`fake chain: unhandled ${method}`);
    }
  }

  get publicClient(): PublicClient {
    return createPublicClient({ transport: custom({ request: (a) => this.request(a as never) as never }) }) as PublicClient;
  }

  wallet(account: Address): WalletClient {
    return createWalletClient({ account, transport: custom({ request: (a) => this.request(a as never) as never }) });
  }

  /** A wallet that signs with a local key, as a script or an agent holds one. */
  localWallet(account: LocalAccount): WalletClient {
    return createWalletClient({ account, transport: custom({ request: (a) => this.request(a as never) as never }) });
  }
}

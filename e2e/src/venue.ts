// Reads and orders on dreamDEX perps that need none of Copybook's contracts: the e2e runs and the demo leader bot
// share them. Nothing here reads contracts/out, so a tool that only trades runs without a forge build.
import { parseAbi, type Address, type Hex, type TransactionReceipt } from "viem";
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { pub, MARGIN_BANK } from "./env.ts";

export const poolAbi = parseAbi([
  "function getMarkPrice() view returns (uint256)",
  "function getOneBase() view returns (uint256)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool, uint128)",
]);
export const bankAbi = parseAbi([
  "function getPosition(address account, address pool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getAccountHealth(address account) view returns (int256 equity, uint256 imReq, uint256 mmReq, uint256 cmReq)",
]);

export async function size(account: Address, pool: Address): Promise<bigint> {
  const p = await pub.readContract({ address: MARGIN_BANK, abi: bankAbi, functionName: "getPosition", args: [account, pool] });
  return p.size;
}

export async function equity(account: Address): Promise<bigint> {
  const h = await pub.readContract({ address: MARGIN_BANK, abi: bankAbi, functionName: "getAccountHealth", args: [account] });
  return h[0];
}

export async function market(pool: Address) {
  const [mark, ob, oneBase] = await Promise.all([
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getMarkPrice" }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters" }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getOneBase" }),
  ]);
  return { mark, tick: ob.tickSize, lot: ob.lotSize, minQty: ob.minQuantity, oneBase };
}

/** The limit of an IOC 1% through mark, on the tick grid: rounded up for a buy, down for a sell. */
export function iocPrice(mark: bigint, tick: bigint, isBid: boolean): bigint {
  const raw = isBid ? (mark * 10_100n) / 10_000n : (mark * 9_900n) / 10_000n;
  return isBid ? ((raw + tick - 1n) / tick) * tick : (raw / tick) * tick;
}

/**
 * An IOC 1% through mark, placed by the account behind `mk` itself (not through the hub). Resolves on the receipt;
 * the SDK throws on a revert. Without `expireTimestampNs` the order carries the SDK's far-future expiry.
 */
export async function placeIoc(
  mk: SomniaMarkets,
  pool: Address,
  isBid: boolean,
  qty: bigint,
  expireTimestampNs?: bigint,
): Promise<TransactionReceipt> {
  const m = await market(pool);
  const price = iocPrice(m.mark, m.tick, isBid);
  const r = (await mk.trader.placePerpOrder({
    pool,
    isBid,
    price,
    quantity: qty,
    orderType: 2,
    gas: 20_000_000n,
    ...(expireTimestampNs === undefined ? {} : { expireTimestampNs }),
  })) as { hash: Hex; receipt?: TransactionReceipt };
  return r.receipt ?? (await pub.waitForTransactionReceipt({ hash: r.hash }));
}

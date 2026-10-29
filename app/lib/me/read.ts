import type { Address, PublicClient } from "viem";
import { isTradeable, type Copybook, type FollowerStatus, type Verdict } from "@copybook/sdk";
import type { PoolRead } from "./book";

export interface MeReads {
  address: Address;
  status: FollowerStatus;
  /** The global operator grant; undefined when the registry did not answer. */
  approved?: boolean;
  /** Perps equity; null when the margin bank did not answer. */
  equity: bigint | null;
  balance: bigint;
  /** Trader follows: the gate's verdict on the trader; null when the gate did not answer. */
  verdict?: Verdict | null;
}

/** The follower's state as the chain holds it now. `status()` carries every stuck state with its clearing call. */
export async function readMe(cb: Copybook, publicClient: Pick<PublicClient, "getBalance">, address: Address): Promise<MeReads> {
  const [status, approved, equity, balance] = await Promise.all([
    cb.status(address),
    cb.isOperatorApproved(address).catch(() => undefined),
    cb.accountEquity(address).catch(() => null),
    publicClient.getBalance({ address }),
  ]);
  const trader = status.follow?.trader;
  const verdict = trader ? await cb.verdictOf(trader).catch(() => null) : undefined;
  return { address, status, approved, equity, balance, ...(verdict !== undefined ? { verdict } : {}) };
}

/** Each market's parameters and both books in it, read from the pools and the margin bank. A failed read is null, not zero. */
export async function readPools(cb: Copybook, follower: Address, pools: readonly Address[], trader?: Address): Promise<PoolRead[]> {
  return Promise.all(
    pools.map(async (pool) => {
      const [market, yours, theirs] = await Promise.all([
        cb.market(pool).then(
          (m) => (isTradeable(m) ? m : null),
          () => null,
        ),
        cb.position(follower, pool).catch(() => null),
        trader ? cb.position(trader, pool).catch(() => null) : Promise.resolve(undefined),
      ]);
      return { pool, market, yours, ...(trader ? { theirs } : {}) };
    }),
  );
}

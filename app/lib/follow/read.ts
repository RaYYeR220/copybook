import type { Address, PublicClient } from "viem";
import type { Copybook } from "@copybook/sdk";
import type { ChainReads } from "./flow";

/**
 * Everything the follow flow needs from the chain for one wallet, read fresh: the operator grant, the current
 * follow, the perps equity, the STT balance, the guard and the tank, and for a trader follow the gate's verdict
 * and pending review. A margin bank that does not answer reads as `equity: null`, not as an empty account.
 */
export async function readFollowState(cb: Copybook, publicClient: Pick<PublicClient, "getBalance">, address: Address, trader?: Address): Promise<ChainReads> {
  const [approved, follow, equity, balance, guardOn, tank, verdict, pending] = await Promise.all([
    cb.isOperatorApproved(address),
    cb.followOf(address),
    cb.accountEquity(address).catch(() => null),
    publicClient.getBalance({ address }),
    cb.guardOf(address),
    cb.tankOf(address),
    trader ? cb.verdictOf(trader) : Promise.resolve(undefined),
    trader ? cb.reviewPendingOf(trader) : Promise.resolve(undefined),
  ]);
  return {
    address,
    approved,
    follow: follow ? { sourceId: follow.sourceId, kind: follow.kind, ref: follow.ref } : null,
    equity,
    balance,
    guardOn,
    tank,
    ...(verdict ? { verdict: { tier: verdict.tier, reviewedAt: verdict.reviewedAt, shannonRequestId: verdict.shannonRequestId, summaryHash: verdict.summaryHash } } : {}),
    ...(trader ? { reviewPending: pending ? { nonce: pending.nonce, requestedAt: pending.requestedAt } : null } : {}),
  };
}

import type { Hex } from "viem";
import { CopybookError } from "@copybook/sdk";
import { isUserRejection } from "../wallet/addNetwork";

/**
 * One wallet transaction from the page's point of view. `rejected` and a `failed` without a hash mean nothing
 * reached the chain; a `failed` with a hash reverted on chain.
 */
export type TxPhase =
  | { phase: "idle" }
  | { phase: "signing"; action: string }
  | { phase: "pending"; action: string; hash: Hex }
  | { phase: "confirmed"; action: string; hash: Hex; block: bigint }
  | { phase: "rejected"; action: string }
  | { phase: "failed"; action: string; message: string; hash?: Hex };

export const IDLE: TxPhase = { phase: "idle" };

/** What a write returns: the SDK's `{ hash, wait() }`. */
export interface Sent {
  hash: Hex;
  wait(): Promise<{ receipt: { blockNumber: bigint } }>;
}

/** Plain words for a failed write; null when the person declined in their wallet. */
export function txErrorText(err: unknown): string | null {
  if (isUserRejection(err)) return null;
  if (err instanceof CopybookError) {
    if (err.code === "REVERTED") return `${err.message} The node refused it before signing, so nothing was sent.`;
    if (err.code === "TX_FAILED") return "The transaction reverted on chain. Nothing changed; the page re-reads the chain.";
    return err.message;
  }
  const e = err as { shortMessage?: string; message?: string } | undefined;
  return e?.shortMessage ?? e?.message ?? "The wallet returned an error.";
}

/**
 * Sends one write and reports each phase: signing, pending with its hash, then confirmed with its block. A
 * decline returns `rejected`; a revert before signing (the SDK's gas estimate) or on chain returns `failed`.
 * `onSent` runs as soon as the hash is known, so the page can remember it across a reload.
 */
export async function runTx(action: string, send: () => Promise<Sent>, onPhase: (p: TxPhase) => void = () => {}, onSent: (hash: Hex) => void = () => {}): Promise<TxPhase> {
  const set = (p: TxPhase) => {
    onPhase(p);
    return p;
  };
  set({ phase: "signing", action });
  let hash: Hex | undefined;
  try {
    const tx = await send();
    hash = tx.hash;
    onSent(hash);
    set({ phase: "pending", action, hash });
    const out = await tx.wait();
    return set({ phase: "confirmed", action, hash, block: out.receipt.blockNumber });
  } catch (err) {
    const message = txErrorText(err);
    if (message === null) return set({ phase: "rejected", action });
    return set(hash ? { phase: "failed", action, message, hash } : { phase: "failed", action, message });
  }
}

/** A transaction the page sent and has not seen land yet, kept per wallet so a reload can wait for it. */
export interface PendingTx {
  address: string;
  action: string;
  hash: Hex;
  /** Unix seconds when it was sent. */
  at: number;
}

/** After this long a remembered transaction is dropped: the chain reads alone decide the step again. */
export const PENDING_MAX_AGE_S = 15 * 60;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (address: string) => `copybook:pending:${address.toLowerCase()}`;

export function rememberTx(store: Store | undefined, tx: PendingTx): void {
  try {
    store?.setItem(key(tx.address), JSON.stringify(tx));
  } catch {
    /* storage full or blocked: the chain reads still decide the step */
  }
}

export function recallTx(store: Store | undefined, address: string, now: number): PendingTx | undefined {
  try {
    const raw = store?.getItem(key(address));
    if (!raw) return undefined;
    const tx = JSON.parse(raw) as PendingTx;
    if (typeof tx.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx.hash) || tx.address?.toLowerCase() !== address.toLowerCase() || !(now - tx.at <= PENDING_MAX_AGE_S)) {
      store?.removeItem(key(address));
      return undefined;
    }
    return tx;
  } catch {
    return undefined;
  }
}

export function forgetTx(store: Store | undefined, address: string): void {
  try {
    store?.removeItem(key(address));
  } catch {
    /* nothing to do */
  }
}

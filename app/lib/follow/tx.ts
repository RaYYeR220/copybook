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

/**
 * The page's transaction if it belongs to one of `actions`. A transaction recalled after a reload belongs to no
 * button any more: pass `recalled` where the page shows it (the current step), and it shows there only.
 */
export function txFor(t: { tx: TxPhase; recalled: boolean }, actions: readonly string[], recalled = false): TxPhase {
  if (t.tx.phase === "idle") return IDLE;
  if (t.recalled) return recalled ? t.tx : IDLE;
  return actions.includes(t.tx.action) ? t.tx : IDLE;
}

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
/** `scope` keeps pages apart: the follow flow's pending transaction is not the thesis builder's. */
const key = (address: string, scope = "pending") => `copybook:${scope}:${address.toLowerCase()}`;

export function rememberTx(store: Store | undefined, tx: PendingTx, scope?: string): void {
  try {
    store?.setItem(key(tx.address, scope), JSON.stringify(tx));
  } catch {
    /* storage full or blocked: the chain reads still decide the step */
  }
}

export function recallTx(store: Store | undefined, address: string, now: number, scope?: string): PendingTx | undefined {
  try {
    const raw = store?.getItem(key(address, scope));
    if (!raw) return undefined;
    const tx = JSON.parse(raw) as PendingTx;
    if (typeof tx.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx.hash) || tx.address?.toLowerCase() !== address.toLowerCase() || !(now - tx.at <= PENDING_MAX_AGE_S)) {
      store?.removeItem(key(address, scope));
      return undefined;
    }
    return tx;
  } catch {
    return undefined;
  }
}

export function forgetTx(store: Store | undefined, address: string, scope?: string): void {
  try {
    store?.removeItem(key(address, scope));
  } catch {
    /* nothing to do */
  }
}

/** What `refocus` needs from the page: where focus is now, and the body it falls back to. */
export interface FocusDoc {
  activeElement: unknown;
  body: unknown;
}
export interface Focusable {
  isConnected: boolean;
  disabled?: boolean;
  focus(): void;
}

/**
 * A button disabled while its transaction runs loses focus to the page body. Once the transaction settles, focus goes
 * back to the control that sent it, unless the page has put focus somewhere on purpose (a new step's heading).
 */
export function refocus(doc: FocusDoc, trigger: Focusable | null): boolean {
  if (!trigger || !trigger.isConnected || trigger.disabled) return false;
  if (doc.activeElement !== doc.body && doc.activeElement !== null) return false;
  trigger.focus();
  return true;
}

import type { Address } from "viem";
import type { CopybookEvent } from "@copybook/sdk";

/**
 * How a copy or refusal reached the chain. `handler`: the hub's reactive handler sent it, inside the block of the
 * move it answers (the same-block path). `call`: someone called the hub directly (follow, catchUp, resync, poke).
 */
export type Via = "handler" | "call";

/** A Copybook event as the history route serves it: copies and refusals carry how they were sent. */
export type LoggedEvent = CopybookEvent & { via?: Via };

export type Contract = "hub" | "gate";

/** A block range the history has not read yet (still scanning, or the node refused it). */
export interface MissingRange {
  contract: Contract;
  from: bigint;
  to: bigint;
}

/** `handler` when the hub itself sent the transaction (its reactive handler), `call` otherwise. */
export const viaOf = (sender: Address, hub: Address): Via => (sender.toLowerCase() === hub.toLowerCase() ? "handler" : "call");

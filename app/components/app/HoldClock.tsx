"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { fmtInt } from "@/lib/format";
import { useHubFeed } from "./HubFeed";

/** The clock in unix seconds: the server render's time on the first paint, the browser's after, every 15 s. */
export function useNow(renderedAt: number): number {
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    const read = () => setNow(Math.floor(Date.now() / 1000));
    read();
    const t = setInterval(read, 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The hold's note in the verdict ledger; it changes when the hold ends, without a reload. */
export function HoldNote({ heldUntil, renderedAt }: { heldUntil: number; renderedAt: number }) {
  const now = useNow(renderedAt);
  return <>{now < heldUntil ? "until then only another BLOCK can replace it" : "the hold is over: any new verdict replaces it"}</>;
}

/**
 * Under the tier: the block the stored verdict reached the gate in (found in the gate's log by its Shannon request
 * id), and for a BLOCK whether it is still in its hold.
 */
export function VerdictLabel({
  trader,
  requestId,
  heldUntil,
  holdSeconds,
  lapsed,
  renderedAt,
}: {
  trader: Address;
  requestId: string;
  heldUntil?: number;
  holdSeconds: number;
  lapsed: boolean;
  renderedAt: number;
}) {
  const feed = useHubFeed();
  const now = useNow(renderedAt);
  const block = useMemo(() => {
    for (const e of feed.events)
      if (e.name === "VerdictReceived" && e.trader.toLowerCase() === trader.toLowerCase() && e.shannonRequestId.toString() === requestId) return e.log.blockNumber;
    return undefined;
  }, [feed.events, trader, requestId]);
  const parts: string[] = [];
  if (block !== undefined) parts.push(`since block #${fmtInt(block)}`);
  if (heldUntil !== undefined && !lapsed && now < heldUntil) parts.push(`in its ${Math.round(holdSeconds / 3600)} h hold`);
  if (lapsed) parts.push("lapsed");
  return <>{parts.length ? parts.join(" · ") : "on the gate"}</>;
}

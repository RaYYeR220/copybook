"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Address, PublicClient } from "viem";
import type { Copybook } from "@copybook/sdk";
import { bankRegistryAbi, type MarketRead } from "@/lib/builder/registry";

const lc = (a: string) => a.toLowerCase();

/** Each chosen market's mark, lot and minimum order, read from its pool every 30 s while the page is open. */
export function useMarketReads(cb: Copybook, pools: readonly Address[]): { reads: Record<string, MarketRead | undefined>; readAt?: number } {
  const unique = useMemo(() => [...new Set(pools.map(lc))].sort(), [pools]);
  const qs = useQueries({
    queries: unique.map((p) => ({
      queryKey: ["market", p],
      queryFn: () => cb.market(p as Address),
      staleTime: 15_000,
      refetchInterval: 30_000,
      retry: 1,
    })),
  });
  const reads: Record<string, MarketRead | undefined> = {};
  let readAt: number | undefined;
  unique.forEach((p, i) => {
    const q = qs[i];
    if (q.data) {
      reads[p] = { status: "ok", market: q.data };
      if (q.dataUpdatedAt && (readAt === undefined || q.dataUpdatedAt < readAt)) readAt = q.dataUpdatedAt;
    } else if (q.isError) reads[p] = { status: "error" };
  });
  return { reads, readAt };
}

/**
 * The margin bank's `isPerpPoolRegistered` for each chosen pool: the server's answer where it has one, read here
 * for any it could not read.
 */
export function useRegistration(client: PublicClient, bank: Address | null, pools: readonly Address[], known: Record<string, boolean>) {
  const missing = useMemo(() => [...new Set(pools.map(lc))].filter((p) => known[p] === undefined).sort(), [pools, known]);
  const qs = useQueries({
    queries: missing.map((p) => ({
      queryKey: ["registered", bank, p],
      queryFn: () => client.readContract({ address: bank!, abi: bankRegistryAbi, functionName: "isPerpPoolRegistered", args: [p as Address] }),
      enabled: !!bank,
      staleTime: 3_600_000,
      retry: 2,
    })),
  });
  const out: Record<string, boolean | undefined> = { ...known };
  missing.forEach((p, i) => {
    if (qs[i].data !== undefined) out[p] = qs[i].data;
  });
  return out;
}

/**
 * The chain's clock: the latest block's timestamp, carried forward by the browser's clock between reads (every
 * 20 s, and on `refresh`). Undefined until the first read lands.
 */
export function useChainClock(client: PublicClient) {
  const q = useQuery({
    queryKey: ["chain-clock"],
    queryFn: async () => {
      const b = await client.getBlock({ blockTag: "latest" });
      return { ts: Number(b.timestamp), block: b.number, at: Date.now() };
    },
    staleTime: 0,
    refetchInterval: 20_000,
    retry: 1,
  });
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const now = q.data ? q.data.ts + Math.max(0, Math.floor((tick - q.data.at) / 1000)) : undefined;
  return { now, read: q.data, refresh: () => q.refetch(), error: q.isError };
}

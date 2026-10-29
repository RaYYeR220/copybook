"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { createCopybook, type CopybookEvent, type WatchHandle, type WatchStatus } from "@copybook/sdk";
import { viaOf, type LoggedEvent, type MissingRange } from "@/lib/events";
import type { HistorySummary } from "@/lib/followers";
import { aboutFollower, aboutSource, parseSource } from "@/lib/historyFilter";
import { fromJsonSafe } from "@/lib/json";
import { deploymentsOf, type PublicConfig } from "@/lib/publicConfig";
import { mergeFeed } from "@/lib/tape";
import { hideki } from "@/lib/wallet/hideki";

export type FeedStatus = "loading" | WatchStatus | "paused";

export interface HubFeed {
  /** Newest first, one entry per txHash:logIndex. */
  events: LoggedEvent[];
  status: FeedStatus;
  /** The block the feed has read up to (history route or live watcher). */
  readTo?: bigint;
  /** False while the history route is still reading older ranges. */
  complete: boolean;
  missing: MissingRange[];
  /** What the history route computed over the whole log (followed sources, a source's followers), and up to which block. */
  summary?: HistorySummary;
  summaryAt?: bigint;
  /** Set when the history route did not answer. */
  error?: string;
  /** True once the first history answer (or failure) is in. */
  loaded: boolean;
}

const Ctx = createContext<HubFeed | null>(null);

export function useHubFeed(): HubFeed {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHubFeed needs a HubFeedProvider");
  return v;
}

interface HistoryBody {
  events: LoggedEvent[];
  toBlock: bigint;
  complete: boolean;
  missing: MissingRange[];
  summary?: HistorySummary;
}

/** The node answers getLogs over at most this many blocks. */
const LOG_CHUNK = 1_000n;

/**
 * The hub's and the gate's events for one page: the history route on mount, then the live watcher started at the
 * block that read ended on, so nothing between the two is missed (somnia_watch ticks, then getLogs). After a
 * reconnect, and when the tab comes back, the history route is read again from the last block seen and the watcher
 * resumes from there; everything merges on txHash:logIndex, so nothing repeats. The socket closes while the tab is
 * hidden.
 */
export function HubFeedProvider({
  pub,
  source,
  follower,
  cap = 400,
  live = true,
  children,
}: {
  pub: PublicConfig;
  /** A trader address or a thesis id. */
  source?: string;
  follower?: Address;
  cap?: number;
  live?: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<HubFeed>({ events: [], status: "loading", complete: true, missing: [], loaded: false });
  // keyed on the contracts, not on the props object: a router refresh hands down an equal config, not a new feed
  const hub = (pub.deployments as { hub?: string }).hub ?? "";
  const pubRef = useRef(pub);
  pubRef.current = pub;
  const deployments = useMemo(() => deploymentsOf(pubRef.current), [hub]);
  const ref = useMemo(() => (source ? parseSource(source) : undefined), [source]);
  const readTo = useRef<bigint | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let handle: WatchHandle | undefined;
    let starting = false;
    let wasDown = false;
    const publicClient = createPublicClient({ chain: hideki, transport: http() }) as PublicClient;
    const copybook = createCopybook({ publicClient, deployments });
    const wsUrl = hideki.rpcUrls.default.webSocket[0];

    const keep = (e: CopybookEvent) => (!ref || aboutSource(e, ref)) && (!follower || aboutFollower(e, follower));
    const bump = (b: bigint | undefined) => {
      if (b !== undefined && (readTo.current === undefined || b > readTo.current)) readTo.current = b;
    };
    const merge = (incoming: LoggedEvent[], extra: Partial<HubFeed> = {}) => {
      if (stopped) return;
      setState((s) => ({ ...s, ...extra, events: mergeFeed(s.events, incoming, cap), readTo: readTo.current }));
    };

    async function backfill(fromBlock?: bigint) {
      const qs = new URLSearchParams();
      if (source) qs.set("source", source);
      if (follower) qs.set("follower", follower);
      if (fromBlock !== undefined) qs.set("fromBlock", fromBlock.toString());
      qs.set("limit", String(cap));
      try {
        // never a browser-cached answer: the edge may hold one for a few seconds, and the watcher covers that gap
        const res = await fetch(`/api/history?${qs}`, { cache: "no-store" });
        if (!res.ok) {
          const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const body = fromJsonSafe<HistoryBody>(await res.json());
        bump(body.toBlock);
        merge(body.events, {
          loaded: true,
          error: undefined,
          // a backfill from a later block says nothing about older ranges or the whole log: keep what the first read said
          ...(fromBlock === undefined ? { complete: body.complete, missing: body.missing, summary: body.summary, summaryAt: body.toBlock } : {}),
        });
      } catch (err) {
        if (!stopped) setState((s) => ({ ...s, loaded: true, error: err instanceof Error ? err.message : String(err) }));
      }
    }

    async function onLive(e: CopybookEvent) {
      if (!keep(e)) return;
      bump(e.log.blockNumber);
      let ev: LoggedEvent = e;
      if ((e.name === "Copied" || e.name === "Refused") && e.log.transactionHash) {
        // the same rule the history route applies: did the hub's handler send it, or a direct call?
        const tx = await publicClient.getTransaction({ hash: e.log.transactionHash }).catch(() => undefined);
        if (tx) ev = { ...e, via: viaOf(tx.from, deployments.hub) };
      }
      merge([ev]);
    }

    async function start() {
      if (!live || stopped || handle || starting || document.hidden) return;
      starting = true;
      try {
        const h = await copybook.watch({
          wsUrl,
          follower,
          contracts: ["hub", "gate"],
          // resume where the history (or the last watcher) stopped: the first read covers [readTo, head]
          fromBlock: readTo.current,
          chunkSize: LOG_CHUNK,
          onEvent: (e) => void onLive(e),
          onStatus: (s: WatchStatus) => {
            if (stopped) return;
            if (s === "reconnecting") wasDown = true;
            if (s === "live" && wasDown) {
              wasDown = false;
              void backfill(readTo.current);
            }
            setState((st) => ({ ...st, status: s }));
          },
          onError: () => undefined,
        });
        if (stopped || document.hidden) await h.stop();
        else handle = h;
      } finally {
        starting = false;
      }
    }

    async function stop() {
      const h = handle;
      handle = undefined;
      if (h) {
        bump(h.lastBlock);
        await h.stop();
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        void stop().then(() => !stopped && setState((s) => ({ ...s, status: "paused" })));
      } else {
        void backfill(readTo.current).then(start);
      }
    };

    // the watcher's own read-to block moves on every tick; show it without asking the node
    const tick = setInterval(() => {
      if (handle?.lastBlock !== undefined) {
        const before = readTo.current;
        bump(handle.lastBlock);
        if (readTo.current !== before) setState((s) => ({ ...s, readTo: readTo.current }));
      }
    }, 3_000);

    document.addEventListener("visibilitychange", onVisibility);
    void backfill().then(() => (live ? start() : setState((s) => ({ ...s, status: "stopped" }))));

    return () => {
      stopped = true;
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
      void stop();
    };
  }, [deployments, ref, source, follower, cap, live]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

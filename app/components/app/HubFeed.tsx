"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { createCopybook, type CopybookEvent } from "@copybook/sdk";
import { viaOf, type LoggedEvent } from "@/lib/events";
import { createFeed, type FeedState, type HistoryAnswer } from "@/lib/feedController";
import { aboutFollower, aboutSource, parseSource } from "@/lib/historyFilter";
import { fromJsonSafe } from "@/lib/json";
import { deploymentsOf, type PublicConfig } from "@/lib/publicConfig";
import { hideki } from "@/lib/wallet/hideki";

export type { FeedStatus } from "@/lib/feedController";
export type HubFeed = FeedState;

const Ctx = createContext<HubFeed | null>(null);

export function useHubFeed(): HubFeed {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHubFeed needs a HubFeedProvider");
  return v;
}

/** The node answers getLogs over at most this many blocks. */
const LOG_CHUNK = 1_000n;

/**
 * The hub's and the gate's events for one page (see `createFeed`): the history route, then the live watcher started
 * where that read ended, or at its first unread block. The socket closes while the tab is hidden.
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

  useEffect(() => {
    const publicClient = createPublicClient({ chain: hideki, transport: http() }) as PublicClient;
    const copybook = createCopybook({ publicClient, deployments });

    const feed = createFeed(
      {
        async history(fromBlock) {
          const qs = new URLSearchParams();
          if (source) qs.set("source", source);
          if (follower) qs.set("follower", follower);
          if (fromBlock !== undefined) qs.set("fromBlock", fromBlock.toString());
          qs.set("limit", String(cap));
          // never a browser-cached answer: the edge may hold one for a few seconds, and the watcher covers that gap
          const res = await fetch(`/api/history?${qs}`, { cache: "no-store" });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
          return fromJsonSafe<HistoryAnswer>(await res.json());
        },
        watch: ({ fromBlock, onEvent, onStatus }) =>
          copybook.watch({
            wsUrl: hideki.rpcUrls.default.webSocket[0],
            follower,
            contracts: ["hub", "gate"],
            fromBlock,
            chunkSize: LOG_CHUNK,
            onEvent,
            onStatus,
            onError: () => undefined,
          }),
        async annotate(e: CopybookEvent): Promise<LoggedEvent> {
          if ((e.name !== "Copied" && e.name !== "Refused") || !e.log.transactionHash) return e;
          // the same rule the history route applies: did the hub's handler send it, or a direct call?
          const tx = await publicClient.getTransaction({ hash: e.log.transactionHash }).catch(() => undefined);
          return tx ? { ...e, via: viaOf(tx.from, deployments.hub) } : e;
        },
        keep: (e) => (!ref || aboutSource(e, ref)) && (!follower || aboutFollower(e, follower)),
        hidden: () => document.hidden,
        live,
        cap,
      },
      setState,
    );

    const onVisibility = () => void feed.visibility(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    void feed.open();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void feed.dispose();
    };
  }, [deployments, ref, source, follower, cap, live]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

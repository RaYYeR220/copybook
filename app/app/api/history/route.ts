import { after } from "next/server";
import { isAddress, type Address } from "viem";
import { followedSources, followedTraders, followerSets, type HistorySummary } from "@/lib/followers";
import { aboutFollower, aboutSource, parseSource } from "@/lib/historyFilter";
import { toJsonSafe } from "@/lib/json";
import { hubLog } from "@/lib/server/chain";
import type { LoggedEvent } from "@/lib/server/hubLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** How long one request waits on cold segments before answering with what it has (the scans keep going). */
const BUDGET_MS = 25_000;
const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 5_000;
/** The edge keeps an answer briefly; browsers always ask again (the live watcher covers what an edge copy lacks). */
const EDGE = "public, s-maxage=30, stale-while-revalidate=60";
const EDGE_PARTIAL = "public, s-maxage=5";
const INT_RE = /^[0-9]{1,15}$/;

/** Without the raw topics and data: events are identified by `txHash:logIndex`, which the log metadata keeps. */
const compact = (e: LoggedEvent): LoggedEvent => {
  const { topics: _t, data: _d, ...log } = e.log;
  return { ...e, log: log as LoggedEvent["log"] };
};

function json(body: unknown, status: number, edge?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(edge ? { "cdn-cache-control": edge, "cache-control": "no-cache" } : {}) },
  });
}

/**
 * Copybook's on-chain history: every event the hub and the risk gate logged since deployment, read from the chain's
 * logs in cached segments. `follower`, `source` (trader address, thesis id or source id) and `fromBlock` narrow it;
 * `limit` keeps the newest events; `raw=1` keeps each log's topics and data. Bigints are `{"$bigint":"<decimal>"}`.
 *
 * Without `fromBlock`, `summary` is computed over the whole log, not just the events returned: every source ever
 * followed, the traders among them, and (with `source`) the wallets that follow it now and that ever did.
 */
export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const followerQ = q.get("follower");
  const sourceQ = q.get("source");
  const fromQ = q.get("fromBlock");
  const limitQ = q.get("limit");
  const raw = q.get("raw") === "1";

  if (followerQ !== null && !(isAddress(followerQ, { strict: false }) && followerQ.length === 42)) return json({ error: "invalid follower address" }, 400);
  const source = sourceQ === null ? undefined : parseSource(sourceQ);
  if (source === null) return json({ error: "invalid source" }, 400);
  if (fromQ !== null && !INT_RE.test(fromQ)) return json({ error: "invalid fromBlock" }, 400);
  const limit = limitQ === null ? DEFAULT_LIMIT : INT_RE.test(limitQ) ? Number(limitQ) : NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) return json({ error: "invalid limit" }, 400);

  try {
    const log = await hubLog.read({ fromBlock: fromQ === null ? undefined : BigInt(fromQ), budgetMs: BUDGET_MS });
    after(() => hubLog.settled());
    let events = log.events;
    if (followerQ) events = events.filter((e) => aboutFollower(e, followerQ as Address));
    if (source) events = events.filter((e) => aboutSource(e, source));
    const total = events.length;
    let summary: HistorySummary | undefined;
    if (fromQ === null) {
      const sources = followedSources(log.events);
      summary = { sources, followedTraders: followedTraders(sources), ...(source ? { followers: followerSets(log.events, source.sourceId) } : {}) };
    }
    return json(
      toJsonSafe({
        events: raw ? events.slice(-limit) : events.slice(-limit).map(compact),
        total,
        summary,
        fromBlock: log.fromBlock,
        toBlock: log.toBlock,
        complete: log.complete,
        missing: log.missing,
        encoding: 'bigints are {"$bigint":"<decimal>"}',
      }),
      200,
      log.complete ? EDGE : EDGE_PARTIAL,
    );
  } catch (err) {
    console.error("history route failed", err instanceof Error ? err.message : err);
    return json({ error: "chain unavailable" }, 502);
  }
}

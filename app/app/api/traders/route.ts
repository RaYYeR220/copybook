import { IndexerError } from "@copybook/stats";
import { ranking } from "@/lib/server/ranking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CACHE = "public, s-maxage=300, stale-while-revalidate=600";

function json(body: unknown, status: number, cache?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(cache ? { "cache-control": cache } : {}) },
  });
}

/** Top dreamDEX traders by realized PnL over 30 days, from the indexer, plus Copybook's labelled demo leader. */
export async function GET(): Promise<Response> {
  try {
    return json(await ranking(), 200, CACHE);
  } catch (err) {
    if (err instanceof IndexerError) return json({ error: "indexer unavailable" }, 502);
    console.error("traders route failed", err instanceof Error ? err.message : err);
    return json({ error: "internal error" }, 500);
  }
}

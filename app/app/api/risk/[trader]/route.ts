import { getTraderStats, riskRubric, riskSummary, IndexerError } from "@copybook/stats";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE = "public, s-maxage=300, stale-while-revalidate=600";
const ROW_CAP = 2000;

function json(body: unknown, status: number, cache?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(cache ? { "cache-control": cache } : {}) },
  });
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ trader: string }> }): Promise<Response> {
  const { trader } = await ctx.params;
  if (!ADDRESS_RE.test(trader)) return json({ error: "invalid trader address" }, 400);
  try {
    const stats = await getTraderStats(trader as `0x${string}`, { maxRows: ROW_CAP });
    // `rubric` holds only the keys the published rubric reads (the validators classify it); `summary` is the fuller
    // line for people. asOf is the response time; the response may be served from cache for up to s-maxage.
    return json(
      { trader: stats.trader, rubric: riskRubric(stats), summary: riskSummary(stats), stats, asOf: new Date().toISOString() },
      200,
      CACHE,
    );
  } catch (err) {
    if (err instanceof IndexerError) return json({ error: "risk summary unavailable" }, 502);
    console.error("risk route failed", err);
    return json({ error: "internal error" }, 500);
  }
}

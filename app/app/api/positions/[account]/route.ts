import { getAddress, isAddress } from "viem";
import { IndexerError } from "@copybook/stats";
import { toJsonSafe } from "@/lib/json";
import { openPositions } from "@/lib/server/indexer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number, cache?: string) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...(cache ? { "cache-control": cache } : {}) } });

/**
 * An account's open dreamDEX perp positions, as the indexer last saw them (15 s cache). The dashboard uses it to
 * find the markets a whole-book follow covers; sizes and prices on the dashboard itself are read from the chain.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ account: string }> }): Promise<Response> {
  const raw = (await params).account;
  if (!(raw.length === 42 && isAddress(raw, { strict: false }))) return json({ error: "invalid account address" }, 400);
  try {
    const positions = await openPositions(getAddress(raw));
    return json(toJsonSafe({ account: getAddress(raw), positions, source: "dreamDEX indexer" }), 200, "public, max-age=10");
  } catch (err) {
    if (err instanceof IndexerError) return json({ error: "indexer unavailable" }, 502);
    console.error("positions route failed", err instanceof Error ? err.message : err);
    return json({ error: "positions unavailable" }, 500);
  }
}

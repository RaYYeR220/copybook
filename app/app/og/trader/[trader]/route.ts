import { traderCard } from "@/lib/og/respond";
import { traderCardDeps } from "@/lib/server/og";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ trader: string }> };

/** The share card of a trader's page. */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return traderCard(decodeURIComponent((await params).trader), traderCardDeps);
}

import { thesisCard } from "@/lib/og/respond";
import { thesisCardDeps } from "@/lib/server/og";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** The share card of a thesis page. */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return thesisCard((await params).id, thesisCardDeps);
}

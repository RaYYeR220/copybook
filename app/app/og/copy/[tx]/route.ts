import { parseLogIndex } from "@/lib/copy";
import { copyCard } from "@/lib/og/respond";
import { copyOf } from "@/lib/server/copy";
import { cardNames } from "@/lib/server/og";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ tx: string }> };

/** The share card of one copy (`?log=<index>` picks one of several in a transaction). 404 when the transaction holds no such copy. */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const { tx } = await params;
  const log = parseLogIndex(new URL(req.url).searchParams.get("log"));
  if (log === "invalid") return new Response("Not a log index.", { status: 404 });
  return copyCard(tx, log, { copy: copyOf, names: cardNames });
}

import { getAddress, isAddress, type Address, type Hex } from "viem";
import { eventFollower, sourceIdOf, type CopybookEvent } from "@copybook/sdk";

/** A source named in a history query: a trader's address, a thesis id, or a raw hub source id. */
export type SourceRef = { sourceId: Hex; trader?: Address; themeId?: bigint };

const SOURCE_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const INT_RE = /^[0-9]{1,30}$/;

/** `0x…` (40 hex) is a trader, a decimal is a thesis id, `0x…` (64 hex) is a hub source id. Null when it is none of them. */
export function parseSource(s: string): SourceRef | null {
  if (isAddress(s, { strict: false }) && s.length === 42) {
    const trader = getAddress(s);
    return { sourceId: sourceIdOf("Trader", trader), trader };
  }
  if (SOURCE_ID_RE.test(s)) return { sourceId: s.toLowerCase() as Hex };
  if (INT_RE.test(s) && BigInt(s) > 0n) {
    const themeId = BigInt(s);
    return { sourceId: sourceIdOf("Theme", themeId), themeId };
  }
  return null;
}

/** Events about this source: its follows, copies and refusals, and (for a trader) the reviews of that trader. */
export function aboutSource(e: CopybookEvent, ref: SourceRef): boolean {
  if ("sourceId" in e && e.sourceId.toLowerCase() === ref.sourceId.toLowerCase()) return true;
  return ref.trader !== undefined && "trader" in e && e.trader.toLowerCase() === ref.trader.toLowerCase();
}

export const aboutFollower = (e: CopybookEvent, follower: Address): boolean =>
  eventFollower(e)?.toLowerCase() === follower.toLowerCase();

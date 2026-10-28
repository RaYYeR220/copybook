import "server-only";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { deploymentsFromJson, TIERS, type Deployments, type TierName } from "@copybook/sdk";
import hidekiJson from "../../../deployments/hideki.json";
import riskJson from "../../../deployments/risk.json";
import { toJsonSafe } from "../json";
import type { PublicConfig, RiskParams } from "../publicConfig";

/** The committee's tally on Shannon for one review, as recorded when the review ran. */
export interface ShannonTally {
  requestId: bigint;
  /** The transaction that asked the committee for its verdict. */
  requestTx: Hex;
  /** The transaction that tallied the votes. */
  tallyTx: Hex;
  tallyBlock: number;
  tier: TierName;
  votes: { ok: number; caution: number; blocked: number; responded: number };
}

type Json = Record<string, unknown>;

const num = (v: unknown, key: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`risk.json: "hideki.${key}" is not a positive number`);
  return n;
};

const asAddress = (v: unknown): Address | undefined => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : undefined);

/** Everything the server derives from `deployments/hideki.json` and `deployments/risk.json`. Pure: pass the parsed files. */
export function configFrom(hideki: unknown, risk: unknown) {
  const deployments: Deployments = deploymentsFromJson(hideki, risk);
  const h = hideki as Json;
  const r = risk as Json;
  const rh = (r.hideki ?? {}) as Json;
  const rs = (r.shannon ?? {}) as Json;

  const params: RiskParams = {
    verdictTtlSeconds: num(rh.verdictTtlSeconds, "verdictTtlSeconds"),
    blockHoldSeconds: num(rh.blockHoldSeconds, "blockHoldSeconds"),
    reviewCooldownSeconds: num(rh.reviewCooldownSeconds, "reviewCooldownSeconds"),
    pendingTimeoutSeconds: num(rh.pendingTimeoutSeconds, "pendingTimeoutSeconds"),
  };

  const txs = (Array.isArray(r.txs) ? r.txs : []) as Json[];
  const gateTx = txs.find((t) => t.chain === "hideki" && asAddress(t.contractAddress) === deployments.gate);
  const gateDeployBlock = gateTx && Number(gateTx.block) > 0 ? BigInt(gateTx.block as number) : deployments.deployBlock;

  const targets = ((r.runV1 as Json | undefined)?.reviewTargets ?? {}) as Json;
  const demoLeader = asAddress(targets.leader);
  if (!demoLeader) throw new Error('risk.json: missing "runV1.reviewTargets.leader"');

  // Our contracts and every wallet that sent a recorded transaction on Hideki: the owner, the demo leader and its
  // follower, the Hyperlane relayer. None of them is a trader to rank.
  const own = new Map<string, Address>();
  const add = (v: unknown) => {
    const a = asAddress(v);
    if (a) own.set(a.toLowerCase(), a);
  };
  [deployments.hub, deployments.engine, deployments.themes, deployments.marginBank, deployments.gate, h.owner, rh.owner, rh.mailbox, demoLeader].forEach(add);
  for (const t of txs) if (t.chain === "hideki") add(t.from);

  const tallies = new Map<string, ShannonTally>();
  for (const review of (Array.isArray(r.reviews) ? r.reviews : []) as Json[]) {
    const evs = (Array.isArray(review.shannonEvents) ? review.shannonEvents : []) as Json[];
    const tally = evs.find((e) => e.event === "VerdictTallied");
    if (!tally) continue;
    const args = tally.args as Json;
    const requestId = String(args.requestId);
    const request = evs.find((e) => e.event === "VerdictRequested" && String((e.args as Json).requestId) === requestId);
    tallies.set(requestId, {
      requestId: BigInt(requestId),
      requestTx: (request?.tx ?? tally.tx) as Hex,
      tallyTx: tally.tx as Hex,
      tallyBlock: Number(tally.block),
      tier: TIERS[Number(args.tier)] ?? "None",
      votes: { ok: Number(args.ok), caution: Number(args.caution), blocked: Number(args.blocked), responded: Number(args.responded) },
    });
  }

  const reviewerUrl = String(rs.explorer ?? "");
  const shannonExplorer = new URL(reviewerUrl).origin;
  const committee = (rs.committee ?? {}) as Json;

  const publicConfig: PublicConfig = {
    deployments: toJsonSafe(deployments),
    risk: params,
    shannonExplorer,
    reviewerUrl,
    committee: { size: Number(committee.size), threshold: Number(committee.threshold) },
    demoLeader,
  };

  return {
    deployments,
    risk: params,
    gateDeployBlock,
    demoLeader,
    ownWallets: [...own.values()],
    shannonExplorer,
    reviewerUrl,
    /** The recorded tally for a verdict's Shannon request id; undefined for reviews this file did not record. */
    shannonTally: (requestId: bigint): ShannonTally | undefined => tallies.get(requestId.toString()),
    publicConfig,
  };
}

export type ServerConfig = ReturnType<typeof configFrom>;

export const config: ServerConfig = configFrom(hidekiJson, riskJson);

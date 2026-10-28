/**
 * Proof shown on the landing: transactions from the live end-to-end run against the current hub on Somnia's
 * Hideki testnet (28 Oct 2026), and one live AI-guard review from the scorecard in `eval/`.
 * Every value here can be checked on an explorer; nothing is illustrative.
 */

import { shannonTxUrl, txUrl } from "@/lib/explorer";

export interface ChainTx {
  hash: `0x${string}`;
  /** Position of the transaction inside its block. */
  index: number;
}

const tx = (hash: `0x${string}`, index: number): ChainTx => ({ hash, index });

/** The trader every live scenario copied. */
export const LEADER = "0xa1d0cb85c869e534fe1e0c22af3b238301157b5d" as const;
/** The follower account of the live run. */
export const FOLLOWER = "0x7d736a88978e94e60494ff91c49ba838edfb1932" as const;

/** The leader opens, and the copy lands in the same block: the pair the nightfall scene is drawn from. */
export const sameBlockOpen = {
  market: "BTC-PERP",
  side: "buy",
  /** BTC. The copy went from 0 to the same size (`Copied(0 → 50000)` in venue units). */
  size: "0.0005",
  block: 35025602,
  leader: tx("0x6880ee77710e3156184063cce42be51517df7ca1bb835d25037ebe5556b7f44d", 0),
  copy: tx("0xd012c9ad808025ba8ff880bde67e6972b661b3824e839754bb8681cc1b878cbc", 22),
} as const;

/** The follower held a residue below the venue minimum; one copy order crossed it to the leader's short. */
export const residueCross = {
  market: "BTC-PERP",
  block: 35025759,
  from: "+0.0001",
  to: "−0.0005",
  leader: tx("0x44415234b4210f04e0f036f26696ff4ceb2a25eceb32eba405d0354d557796a7", 0),
  copy: tx("0xdf3ce2e435557042671ae266f24f2a8adcedc3deb5397592cac97514423e7ecc", 5),
} as const;

/** A refusal, written in the leader's block: no fill inside the follower's 5 bps band. */
export const bandRefusal = {
  market: "1000PEPE-PERP",
  block: 35025975,
  bandBps: 5,
  reason: "BandUnfilled",
  venueError: "FillOrKillNotFillable",
  leader: tx("0xb28470db4acd7be5aabb4434cd4a7e48997dbea79bdbe300397f9a5c958fbc86", 3),
  copy: tx("0xc97ecbd7710b42ac60f5321333cd95a6a3fb369c38c9ebe8986751840bdcffcb", 5),
} as const;

/** Thesis 1, "BTC vs ETH": rebalanced from 50/50 to 70/30, both legs resized by one copy transaction. */
export const thesisRebalance = {
  name: "BTC vs ETH",
  themeId: 1,
  before: [
    { market: "BTC-PERP", weightBps: 5000 },
    { market: "ETH-PERP", weightBps: -5000 },
  ],
  after: [
    { market: "BTC-PERP", weightBps: 7000 },
    { market: "ETH-PERP", weightBps: -3000 },
  ],
  block: 35026714,
  rebalance: tx("0xcb0712d3fd2a88c64bb4b5ed1d86246f36cf84df8e39d83ba17cf4959a20e4aa", 5),
  copy: tx("0xd457cf3abe3c3ecf50aa76bb478143aaed88ea3460111a71b80c019692c1c114", 6),
} as const;

/** A live AI-guard review (scorecard row 8): every validator on the committee answered CAUTION. */
export const guardReview = {
  trader: "0xb8700E8d07Bd029f7dD3CE6CC97Fe936D70c50a8",
  verdict: "CAUTION",
  votes: 3,
  answered: 3,
  /** The committee's verdict on Shannon. */
  verdictTx: "0xfeadedec4ab0afc35d4656dcf5748be5b6c52721a2a8d1b6bc1a0960b55157a6",
  /** The verdict arriving at the risk gate on Hideki, over Hyperlane. */
  deliveryTx: "0xa1d8ff8691451597c45d1a718dc42e04e784d94163dc1f6c72e5729c1079e330",
} as const;

export const links = {
  leaderTx: txUrl(sameBlockOpen.leader.hash),
  copyTx: txUrl(sameBlockOpen.copy.hash),
  refusalTx: txUrl(bandRefusal.copy.hash),
  rebalanceCopyTx: txUrl(thesisRebalance.copy.hash),
  guardVerdict: shannonTxUrl(guardReview.verdictTx),
  guardDelivery: txUrl(guardReview.deliveryTx),
};

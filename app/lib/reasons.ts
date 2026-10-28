import type { ReasonName } from "@copybook/sdk";

export type RefusalReason = Exclude<ReasonName, "None">;

/** The name a refusal is shown under, verbatim everywhere it appears. */
export const REASON_LABEL: Record<RefusalReason, string> = {
  BandUnfilled: "Band",
  TotalCap: "Total cap",
  EquityFloor: "Equity floor — paused",
  TankEmpty: "Tank empty",
  RiskGate: "AI risk verdict",
  BelowMinimum: "Below minimum",
  AtCap: "At cap",
  Paused: "Paused",
  MarketNotAllowed: "Market not allowed",
  VenueRejected: "Venue rejected",
  LegFailed: "Leg failed",
};

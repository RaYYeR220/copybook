import { deploymentsFromJson } from "@copybook/sdk";
import hidekiJson from "../../deployments/hideki.json";
import riskJson from "../../deployments/risk.json";

/** The live Copybook contracts, read from `deployments/*.json` and nowhere else. */
export const deployments = deploymentsFromJson(hidekiJson, riskJson);

/** The AI guard's committee on Shannon: how many validators answer and how many must agree. */
export const riskCommittee = {
  size: riskJson.shannon.committee.size,
  threshold: riskJson.shannon.committee.threshold,
};

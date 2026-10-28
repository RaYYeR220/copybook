import { deploymentsFromJson } from "@copybook/sdk";
import hidekiJson from "../../deployments/hideki.json";
import riskJson from "../../deployments/risk.json";

/** The live Copybook contracts, read from `deployments/*.json` and nowhere else. */
export const deployments = deploymentsFromJson(hidekiJson, riskJson);

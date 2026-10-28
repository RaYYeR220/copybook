import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deploymentsFromJson } from "./deployments.ts";
import type { Deployments } from "./types.ts";

/**
 * Loads the deployments from a repo checkout: reads `hideki.json` and `risk.json` from `dir`
 * (default `<cwd>/deployments`). Node only; browsers import the JSON and call `deploymentsFromJson`.
 */
export function loadDeployments(dir: string = resolve(process.cwd(), "deployments")): Deployments {
  const read = (f: string) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as unknown;
  return deploymentsFromJson(read("hideki.json"), read("risk.json"));
}

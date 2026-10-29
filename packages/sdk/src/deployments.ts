import { getAddress, isAddress } from "viem";
import { DEFAULT_OPERATOR_REGISTRY } from "./constants.ts";
import type { DemoWallet, Deployments } from "./types.ts";

type Json = Record<string, unknown>;

function need(obj: Json | undefined, key: string, file: string): unknown {
  const v = obj?.[key];
  if (v === undefined || v === null) throw new Error(`${file}: missing "${key}"`);
  return v;
}

function addr(v: unknown, key: string, file: string) {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${file}: "${key}" is not an address`);
  return getAddress(v);
}

/**
 * Builds the SDK's deployments from the contents of `deployments/hideki.json` and `deployments/risk.json`.
 * Pure: pass the parsed JSON (an import in the app, a file read in Node, see `@copybook/sdk/node`).
 * The risk gate comes from `risk.json`'s `hideki` section, whose hub must match `hideki.json`'s.
 */
export function deploymentsFromJson(hideki: unknown, risk: unknown): Deployments {
  const h = hideki as Json;
  const r = (risk as Json | undefined)?.hideki as Json | undefined;
  if (!r) throw new Error('risk.json: missing "hideki" section');
  const hub = addr(need(h, "hub", "hideki.json"), "hub", "hideki.json");
  const riskHub = addr(need(r, "hub", "risk.json"), "hub", "risk.json");
  if (hub !== riskHub) throw new Error(`risk.json names hub ${riskHub} but hideki.json deploys ${hub}`);
  const operatorRegistry = h.operatorRegistry
    ? addr(h.operatorRegistry, "operatorRegistry", "hideki.json")
    : getAddress(DEFAULT_OPERATOR_REGISTRY);
  return {
    chainId: Number(need(h, "chainId", "hideki.json")),
    hub,
    engine: addr(need(h, "engine", "hideki.json"), "engine", "hideki.json"),
    themes: addr(need(h, "themes", "hideki.json"), "themes", "hideki.json"),
    marginBank: addr(need(h, "marginBank", "hideki.json"), "marginBank", "hideki.json"),
    gate: addr(need(r, "gate", "risk.json"), "gate", "risk.json"),
    groupSize: Number(need(h, "groupSize", "hideki.json")),
    deployBlock: BigInt(need(h, "deployBlock", "hideki.json") as number | string),
    operatorRegistry,
    demoWallets: demoWalletsFrom(h.demoWallets),
  };
}

function demoWalletsFrom(v: unknown): DemoWallet[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('hideki.json: "demoWallets" is not a list');
  return v.map((w: Json, i) => {
    const role = w?.role;
    if (typeof role !== "string" || !role) throw new Error(`hideki.json: "demoWallets[${i}].role" is missing`);
    return { address: addr(w?.address, `demoWallets[${i}].address`, "hideki.json"), role };
  });
}

/**
 * Whether `address` is Copybook's own: one of its contracts or a wallet it runs (`demoWallets`). Such an address is
 * labelled "ours" wherever it shows and is never ranked as a trader.
 */
export function isOurs(d: Pick<Deployments, "hub" | "engine" | "themes" | "gate" | "demoWallets">, address: string): boolean {
  const a = address.toLowerCase();
  return [d.hub, d.engine, d.themes, d.gate, ...d.demoWallets.map((w) => w.address)].some((x) => x.toLowerCase() === a);
}

/** The role of a wallet Copybook runs, or undefined for anyone else. */
export function demoRole(d: Pick<Deployments, "demoWallets">, address: string): string | undefined {
  const a = address.toLowerCase();
  return d.demoWallets.find((w) => w.address.toLowerCase() === a)?.role;
}

import { demoRole, isOurs, type Deployments } from "@copybook/sdk";

type WithWallets = Pick<Deployments, "hub" | "engine" | "themes" | "gate" | "demoWallets">;

/** How a wallet Copybook runs is named wherever it shows: the owner by name, every demo wallet marked ours. */
export const ourLabel = (role: string) => (role === "owner" ? "Copybook owner" : `${role} · ours`);

/** lower-case address → label, for every wallet in `demoWallets` (the tape's wallet names). */
export function ourWalletLabels(d: Pick<Deployments, "demoWallets">): Record<string, string> {
  return Object.fromEntries(d.demoWallets.map((w) => [w.address.toLowerCase(), ourLabel(w.role)]));
}

/** Whether an address is Copybook's own (a contract or a wallet it runs); see isOurs in the SDK. */
export const ours = (d: WithWallets, address: string) => isOurs(d, address);

/** The label of a wallet Copybook runs, or undefined for anyone else. */
export const ourWallet = (d: Pick<Deployments, "demoWallets">, address: string) => {
  const role = demoRole(d, address);
  return role === undefined ? undefined : ourLabel(role);
};

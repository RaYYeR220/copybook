// Writes deployments/<name>.json from the forge broadcast of script/Deploy.s.sol.
// Usage: tsx src/record-deploy.ts   (env: CHAIN_ID, default 50383; DEPLOYMENT_NAME, default hideki)
// Chain id, margin bank, group size and owner come from the broadcast itself (the hub's constructor arguments),
// so the record always matches what was deployed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const chainDir = process.env.CHAIN_ID ?? "50383";
const name = process.env.DEPLOYMENT_NAME ?? "hideki";
const run = JSON.parse(
  readFileSync(resolve(root, `contracts/broadcast/Deploy.s.sol/${chainDir}/run-latest.json`), "utf8"),
);

type Tx = {
  hash: string;
  contractName: string | null;
  contractAddress: string;
  transactionType: string;
  arguments: string[] | null;
};
type Receipt = { blockNumber: string; gasUsed: string; status: string };

const txs: Tx[] = run.transactions;
const receipts: Receipt[] = run.receipts;
const find = (contract: string) => {
  const i = txs.findIndex((t) => t.contractName === contract);
  if (i < 0) throw new Error(`${contract} not in broadcast`);
  if (receipts[i]?.status !== "0x1") throw new Error(`${contract} deploy did not succeed`);
  return { tx: txs[i], receipt: receipts[i] };
};
const engine = find("CopyEngine");
const themes = find("ThemeRegistry");
const hub = find("CopybookHub");
// CopybookHub(bank, themes, groupSize, owner)
const [bank, hubThemes, groupSize, owner] = hub.tx.arguments ?? [];
if (!bank || !groupSize || !owner) throw new Error("CopybookHub constructor arguments missing from the broadcast");
if (getAddress(hubThemes) !== getAddress(themes.tx.contractAddress)) throw new Error("hub points at another ThemeRegistry");
const fundIdx = txs.findIndex(
  (t) => t.transactionType === "CALL" && t.contractAddress?.toLowerCase() === hub.tx.contractAddress.toLowerCase(),
);

const entry = (x: { tx: Tx; receipt: Receipt }) => ({
  hash: x.tx.hash,
  block: Number(x.receipt.blockNumber),
  gasUsed: Number(x.receipt.gasUsed),
});

const out = {
  chainId: Number(run.chain),
  hub: getAddress(hub.tx.contractAddress),
  engine: getAddress(engine.tx.contractAddress),
  themes: getAddress(themes.tx.contractAddress),
  marginBank: getAddress(bank),
  groupSize: Number(groupSize),
  owner: getAddress(owner),
  deployBlock: Number(engine.receipt.blockNumber),
  txs: {
    engine: entry(engine),
    themes: entry(themes),
    hub: entry(hub),
    ...(fundIdx >= 0 ? { fundHub: entry({ tx: txs[fundIdx], receipt: receipts[fundIdx] }) } : {}),
  },
};
const file = resolve(root, `deployments/${name}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}`);

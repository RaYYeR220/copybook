// Writes deployments/hideki.json from the forge broadcast of script/Deploy.s.sol.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const chainId = 50383;
const run = JSON.parse(
  readFileSync(resolve(root, `contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`), "utf8"),
);

type Tx = { hash: string; contractName: string | null; contractAddress: string; transactionType: string };
type Receipt = { blockNumber: string; gasUsed: string; status: string };

const txs: Tx[] = run.transactions;
const receipts: Receipt[] = run.receipts;
const find = (name: string) => {
  const i = txs.findIndex((t) => t.contractName === name);
  if (i < 0) throw new Error(`${name} not in broadcast`);
  return { tx: txs[i], receipt: receipts[i] };
};
const engine = find("CopyEngine");
const themes = find("ThemeRegistry");
const hub = find("CopybookHub");
const fundIdx = txs.findIndex((t) => t.transactionType === "CALL" && t.contractAddress?.toLowerCase() === hub.tx.contractAddress.toLowerCase());

const entry = (x: { tx: Tx; receipt: Receipt }) => ({
  hash: x.tx.hash,
  block: Number(x.receipt.blockNumber),
  gasUsed: Number(x.receipt.gasUsed),
});

const out = {
  chainId,
  hub: getAddress(hub.tx.contractAddress),
  engine: getAddress(engine.tx.contractAddress),
  themes: getAddress(themes.tx.contractAddress),
  marginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
  groupSize: 8,
  deployBlock: Number(engine.receipt.blockNumber),
  txs: {
    engine: entry(engine),
    themes: entry(themes),
    hub: entry(hub),
    ...(fundIdx >= 0 ? { fundHub: entry({ tx: txs[fundIdx], receipt: receipts[fundIdx] }) } : {}),
  },
};
const file = resolve(root, "deployments/hideki.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}`);

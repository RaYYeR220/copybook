#!/usr/bin/env node
// Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
import { main } from "../src/main.ts";
import { redact } from "../src/redact.ts";

main().catch((e) => {
  const env = process.env;
  const secrets = [env.COPYBOOK_AGENT_KEY, env.COPYBOOK_RPC_URL, env.COPYBOOK_INDEXER_URL].filter(Boolean);
  console.error(`copybook-mcp: ${redact(e instanceof Error ? e.message : String(e), secrets)}`);
  process.exit(1);
});

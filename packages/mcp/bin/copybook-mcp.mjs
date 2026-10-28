#!/usr/bin/env node
// Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
import { main } from "../src/main.ts";

main().catch((e) => {
  console.error(`copybook-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { depsFromEnv } from "./config.ts";
import { createServer } from "./server.ts";

export async function main(): Promise<void> {
  const deps = depsFromEnv();
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr, and never include the key.
  console.error(
    deps.agent
      ? `copybook-mcp ready: read + write tools (dry-run by default) for agent wallet ${deps.agent}`
      : "copybook-mcp ready: read tools only (set COPYBOOK_AGENT_KEY to enable write tools)",
  );
}

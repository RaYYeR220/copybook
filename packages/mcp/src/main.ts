import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { banner, depsFromEnv } from "./config.ts";
import { createServer } from "./server.ts";

export async function main(): Promise<void> {
  const deps = depsFromEnv();
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr, and never include the key.
  console.error(banner(deps));
}

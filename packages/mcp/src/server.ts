import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import { toJson } from "./present.ts";
import { redact } from "./redact.ts";
import { buildTools } from "./tools.ts";
import { Refusal, type Deps, type ToolDef } from "./types.ts";
import { InputError } from "./units.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown, isError = false, secrets: readonly string[] = []): Result => ({
  content: [{ type: "text", text: isError ? redact(toJson(value), secrets) : toJson(value) }],
  ...(isError ? { isError: true } : {}),
});

/** Runs a tool and shapes the outcome: data, or a refusal / input error the agent can act on. Never throws. */
export async function runTool(tool: ToolDef, args: Record<string, unknown>, secrets: readonly string[] = []): Promise<Result> {
  const fail = (v: unknown) => text(v, true, secrets);
  try {
    return text(await tool.handler(args));
  } catch (e) {
    if (e instanceof Refusal) return fail({ refused: true, reason: e.message, ...e.details });
    if (e instanceof InputError) return fail({ refused: true, reason: e.message });
    if (e instanceof ZodError) return fail({ refused: true, reason: "Invalid input", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    // Anything else is unexpected. The full error goes to stderr (redacted); the agent gets a generic line,
    // plus viem's short message for chain errors, since that is what it can act on.
    console.error(`copybook-mcp: ${tool.name} failed: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e), secrets)}`);
    const short = typeof (e as { shortMessage?: unknown } | null)?.shortMessage === "string" ? (e as { shortMessage: string }).shortMessage : undefined;
    return fail({ error: short ? `Chain or network error: ${short}` : "Unexpected error while running the tool. Details were logged on the server." });
  }
}

/** The MCP server. Write tools are registered only when an agent wallet is configured. */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer({ name: "copybook", version: "0.1.0" });
  for (const tool of buildTools(deps)) {
    if (tool.write && !deps.agent) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.write
          ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
          : { readOnlyHint: true, openWorldHint: true },
      },
      (args: unknown) => runTool(tool, (args ?? {}) as Record<string, unknown>, deps.secrets),
    );
  }
  return server;
}

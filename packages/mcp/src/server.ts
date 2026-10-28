import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import { toJson } from "./present.ts";
import { buildTools } from "./tools.ts";
import { Refusal, type Deps, type ToolDef } from "./types.ts";
import { InputError } from "./units.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown, isError = false): Result => ({ content: [{ type: "text", text: toJson(value) }], ...(isError ? { isError: true } : {}) });

/** Runs a tool and shapes the outcome: data, or a refusal / input error the agent can act on. Never throws. */
export async function runTool(tool: ToolDef, args: Record<string, unknown>): Promise<Result> {
  try {
    return text(await tool.handler(args));
  } catch (e) {
    if (e instanceof Refusal) return text({ refused: true, reason: e.message, ...e.details }, true);
    if (e instanceof InputError) return text({ refused: true, reason: e.message }, true);
    if (e instanceof ZodError) return text({ refused: true, reason: "Invalid input", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, true);
    return text({ error: e instanceof Error ? e.message : String(e) }, true);
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
      (args: unknown) => runTool(tool, (args ?? {}) as Record<string, unknown>),
    );
  }
  return server;
}

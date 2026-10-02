/**
 * The MCP server over a tool context, built on the SDK's low-level `Server` so the tool list,
 * input validation and error shapes are exactly the fixed ones in `registry.ts`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./conventions.ts";
import { callTool, listTools } from "./registry.ts";

export const SERVER_INFO = { name: "biomix-sales-tools", version: "0.1.0" } as const;

export interface CallLog {
  tool: string;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}

export function createToolServer(context: ToolContext, log: (entry: CallLog) => void = () => undefined): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
    instructions:
      "Read-only tools over invoiced sales and contractual scheduled installments of a fictional dataset. " +
      "Every result carries the dataset's as-of date and source. There is no payment data.",
  });
  const tools = listTools();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = performance.now();
    const outcome = await callTool(context, request.params.name, request.params.arguments);
    const durationMs = Math.round(performance.now() - started);
    if (outcome.ok) {
      log({ tool: request.params.name, ok: true, durationMs });
      return {
        content: [{ type: "text", text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result as Record<string, unknown>,
      };
    }
    // Logged by name and code only: never inputs, values or driver messages.
    log({ tool: request.params.name, ok: false, errorCode: outcome.error.code, durationMs });
    const body = outcome.error.toJSON();
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  });
  return server;
}

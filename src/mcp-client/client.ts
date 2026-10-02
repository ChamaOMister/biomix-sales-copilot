/**
 * Starts the MCP server as a child process and connects to it over stdio. The child gets an
 * environment allowlist: `COPILOT_DATABASE_URL` plus the SDK's default safe variables (HOME,
 * LOGNAME, PATH, SHELL, TERM, USER). Never API keys, the admin URL or file paths.
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER_ENTRY = fileURLToPath(new URL("../mcp/main.ts", import.meta.url));

/** The only variable this repository passes to the MCP server. */
export function serverEnvironment(readerUrl: string): Record<string, string> {
  return { COPILOT_DATABASE_URL: readerUrl };
}

export interface ToolCallResult {
  isError: boolean;
  /** The tool's JSON result, or `{ error: { code, … } }` when `isError`. */
  value: Record<string, unknown>;
}

export interface ToolClient {
  listTools(): Promise<{ name: string; title?: string; description?: string; inputSchema: Record<string, unknown> }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export async function connectToolServer(
  readerUrl: string,
  options: { stderr?: "inherit" | "ignore" | "pipe"; serverEntry?: string } = {},
): Promise<ToolClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverEntry ?? SERVER_ENTRY],
    env: serverEnvironment(readerUrl),
    stderr: options.stderr ?? "inherit",
  });
  const client = new Client({ name: "biomix-sales-copilot", version: "0.1.0" });
  await client.connect(transport);
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools;
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const structured = result.structuredContent;
      let value: Record<string, unknown>;
      if (structured && typeof structured === "object") value = structured as Record<string, unknown>;
      else {
        const text = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]).find((part) => part.type === "text")?.text : undefined;
        value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      return { isError: result.isError === true, value };
    },
    close: () => client.close(),
  };
}

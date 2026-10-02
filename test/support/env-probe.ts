/**
 * Test-only stdio MCP server with one tool, `env`, that returns the names of the environment
 * variables it received. Launched in place of the real server to check the allowlist.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "env-probe", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: "env", description: "Environment variable names", inputSchema: { type: "object" as const } }],
}));
server.setRequestHandler(CallToolRequestSchema, () => {
  const value = { names: Object.keys(process.env).sort() };
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
});
await server.connect(new StdioServerTransport());

/**
 * Keyless tool console: starts the MCP server over stdio, exactly as the copilot does, and prints
 * one real tool result. Needs no API key (Node 24 runs this file directly):
 *
 *   npm run tools -- list
 *   npm run tools -- dataset_overview
 *   npm run tools -- sales_totals '{"period":"calendar-year:2024","groupBy":"businessUnit"}'
 */
import { connectToolServer } from "../src/mcp-client/client.ts";
import { readerConnectionString } from "../src/db/reader-setup.ts";
import { loadLocalEnv } from "../src/setup/env.ts";

loadLocalEnv();
const [command, json] = process.argv.slice(2);
if (!command) {
  console.error("Usage: npm run tools -- list | <tool> ['<json input>']");
  process.exit(1);
}
const readerUrl = readerConnectionString(process.env);
if (!readerUrl) {
  console.error("No reader connection: set COPILOT_DATABASE_URL, or DATABASE_URL and COPILOT_READER_PASSWORD (npm run setup:env, npm run db:reader).");
  process.exit(1);
}
let args: Record<string, unknown> = {};
if (json !== undefined) {
  try {
    args = JSON.parse(json) as Record<string, unknown>;
  } catch {
    console.error("The tool input must be a JSON object.");
    process.exit(1);
  }
}

const client = await connectToolServer(readerUrl);
try {
  if (command === "list") {
    for (const tool of await client.listTools()) console.log(`${tool.name}: ${tool.title ?? ""}`);
  } else {
    const result = await client.callTool(command, args);
    console.log(JSON.stringify(result.value, null, 2));
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}

/**
 * Starts the local web interface (Node 24 runs this file directly):
 *
 *   npm run web            # http://127.0.0.1:3000 (PORT to change)
 *
 * With ANTHROPIC_API_KEY it answers questions with the live model; without it, it runs keyless and
 * offers the tool console only. Binds to 127.0.0.1 and has no authentication: keep the Codespaces
 * port private. Transcripts of answered questions go to .cache/runs/.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { AnthropicModelClient } from "../src/copilot/anthropic.ts";
import { listToolSpecs } from "../src/copilot/loop.ts";
import { REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { readerConnectionString } from "../src/db/reader-setup.ts";
import { connectToolServer } from "../src/mcp-client/client.ts";
import { runStamp, writeRunRecord } from "../src/runs/transcripts.ts";
import { loadLocalEnv } from "../src/setup/env.ts";
import { readModelConfig } from "../src/setup/model-config.ts";
import { createWebServer } from "../src/web/server.ts";

loadLocalEnv();
const readerUrl = readerConnectionString(process.env);
if (!readerUrl) {
  console.error("No reader connection: run npm run setup:env and npm run db:reader.");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const config = readModelConfig(process.env);
const tools = await connectToolServer(readerUrl);
const model = config ? new AnthropicModelClient({ ...config, ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}) }) : null;
const server = createWebServer({
  page: readFileSync(path.join(REPOSITORY_ROOT, "src", "web", "page.html"), "utf8"),
  tools,
  toolSpecs: await listToolSpecs(tools),
  model,
  onRun: (run) => writeRunRecord(`web-${runStamp()}`, { model: model?.name, run }),
  log: (event) => console.error(JSON.stringify(event)),
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Biomix Sales Copilot on http://127.0.0.1:${port} (${model ? `live: ${model.name}` : "keyless: tool console only"})`);
});
const stop = () => {
  server.close();
  void tools.close();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

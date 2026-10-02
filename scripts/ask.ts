/**
 * Asks the copilot one question with the live model (Node 24 runs this file directly):
 *
 *   npm run ask -- "How do Home & Garden sales so far this year compare with last year?"
 *
 * Needs ANTHROPIC_API_KEY (exits with code 3 and a message when it is missing) and the reader
 * connection. Prints the rendered answer with its sources, then status, tokens and cost on stderr.
 * The full transcript goes to .cache/runs/. Model and effort: COPILOT_MODEL, COPILOT_EFFORT.
 */
import path from "node:path";
import { AnthropicModelClient } from "../src/copilot/anthropic.ts";
import { costNanodollars, formatUsd } from "../src/copilot/cost.ts";
import { runCopilot } from "../src/copilot/loop.ts";
import { REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { readerConnectionString } from "../src/db/reader-setup.ts";
import { connectToolServer } from "../src/mcp-client/client.ts";
import { runStamp, writeRunRecord } from "../src/runs/transcripts.ts";
import { loadLocalEnv } from "../src/setup/env.ts";
import { EXIT_NO_API_KEY, NO_KEY_MESSAGE, readModelConfig } from "../src/setup/model-config.ts";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "<question>"');
  process.exit(1);
}
loadLocalEnv();
const config = readModelConfig(process.env);
if (!config) {
  console.error(NO_KEY_MESSAGE);
  process.exit(EXIT_NO_API_KEY);
}
const readerUrl = readerConnectionString(process.env);
if (!readerUrl) {
  console.error("No reader connection: run npm run setup:env and npm run db:reader.");
  process.exit(1);
}

const started = new Date();
const tools = await connectToolServer(readerUrl);
try {
  const model = new AnthropicModelClient({ ...config, ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}) });
  const run = await runCopilot(question, {
    model,
    tools,
    // Names, codes, usage and durations only.
    log: (event) => console.error(JSON.stringify(event)),
  });
  console.log(run.rendered ?? `No answer (${run.status}${run.incompleteReason ? `: ${run.incompleteReason}` : ""}).`);
  const costs = Object.entries(run.usageByModel).map(([name, usage]) => costNanodollars(name, usage));
  const cost = costs.every((value) => value !== null) ? formatUsd(costs.reduce<number>((sum, value) => sum + value, 0)) : "unknown";
  console.error(
    `status ${run.status}; ${run.results.length} tool calls; ${run.modelRequests} model requests; ` +
      `tokens in ${run.usage.inputTokens}, out ${run.usage.outputTokens}, cache read ${run.usage.cacheReadTokens}, cache write ${run.usage.cacheWriteTokens}; cost ${cost}; ${run.durationMs} ms`,
  );
  const file = writeRunRecord(`ask-${runStamp(started)}`, { model: model.name, startedAt: started.toISOString(), run });
  console.error(`Transcript: ${path.relative(REPOSITORY_ROOT, file)}`);
} catch (error) {
  console.error("ask failed", JSON.stringify({ error: error instanceof Error ? error.name : "unknown" }));
  process.exitCode = 1;
} finally {
  await tools.close();
}

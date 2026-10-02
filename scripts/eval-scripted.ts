/**
 * L2: the copilot loop with a scripted model (Node 24 runs this file directly). No API key needed:
 *
 *   npm run eval:scripted [-- --case E06]
 *
 * Writes the transcripts and the report under .cache/runs/.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEvalContext } from "../evals/context.ts";
import { runScriptedEvals } from "../evals/l2.ts";
import { DEFAULT_CHECKOUT_DIR, REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { readerConnectionString } from "../src/db/reader-setup.ts";
import { connectToolServer } from "../src/mcp-client/client.ts";
import { runStamp, writeRunRecord } from "../src/runs/transcripts.ts";
import { loadLocalEnv } from "../src/setup/env.ts";

const { values } = parseArgs({
  options: { "answer-key": { type: "string" }, case: { type: "string", multiple: true, default: [] } },
  strict: true,
});
if (!values["answer-key"]) {
  console.error("Usage: npm run eval:scripted [-- --case E01] (package.json passes --answer-key <path>)");
  process.exit(1);
}
loadLocalEnv();
const readerUrl = readerConnectionString(process.env);
if (!readerUrl) {
  console.error("No reader connection: run npm run setup:env and npm run db:reader.");
  process.exit(1);
}

const ctx = await loadEvalContext(path.resolve(values["answer-key"]), DEFAULT_CHECKOUT_DIR);
const started = new Date();
const client = await connectToolServer(readerUrl);
let reports;
try {
  reports = await runScriptedEvals(client, ctx, values.case);
} finally {
  await client.close();
}

for (const report of reports) {
  const { run } = report;
  console.log(`${report.id} ${report.passed ? "PASS" : "FAIL"}  ${report.title}  [${run.status}; ${run.results.length} tool calls; ${run.modelRequests} model requests]`);
  for (const check of report.grade.checks.filter((entry) => !entry.ok)) console.log(`     ✗ ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
}
const passed = reports.filter((report) => report.passed).length;
console.log(`L2: ${passed}/${reports.length} cases passed`);
const file = writeRunRecord(`l2-${runStamp(started)}`, { level: "L2", startedAt: started.toISOString(), passed, total: reports.length, reports });
console.log(`Report and transcripts: ${path.relative(REPOSITORY_ROOT, file)}`);
if (passed !== reports.length) process.exitCode = 1;

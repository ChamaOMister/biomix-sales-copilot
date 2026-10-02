/**
 * L1 tool-level evaluations (Node 24 runs this file directly). No API key needed:
 *
 *   npm run eval:tools [-- --case E06 --case E07]
 *
 * The answer key's path is an argument (set in package.json); only evals/ reads it. Starts the
 * MCP server over stdio as copilot_reader, runs each case's reference tool plan, and checks the
 * results against the answer key and the recomputation. Writes the report under .cache/runs/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEvalContext } from "../evals/context.ts";
import { runToolEvals } from "../evals/l1.ts";
import { DEFAULT_CHECKOUT_DIR, REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { readerConnectionString } from "../src/db/reader-setup.ts";
import { connectToolServer } from "../src/mcp-client/client.ts";
import { loadLocalEnv } from "../src/setup/env.ts";

const { values } = parseArgs({
  options: { "answer-key": { type: "string" }, case: { type: "string", multiple: true, default: [] } },
  strict: true,
});
if (!values["answer-key"]) {
  console.error("Usage: npm run eval:tools [-- --case E01] (package.json passes --answer-key <path>)");
  process.exit(1);
}
loadLocalEnv();
const readerUrl = readerConnectionString(process.env);
if (!readerUrl) {
  console.error("No reader connection: run npm run setup:env and npm run db:reader.");
  process.exit(1);
}

const ctx = await loadEvalContext(path.resolve(values["answer-key"]), DEFAULT_CHECKOUT_DIR);
const client = await connectToolServer(readerUrl);
const started = new Date();
let reports;
try {
  reports = await runToolEvals(client, ctx, values.case);
} finally {
  await client.close();
}

for (const report of reports) {
  const calls = report.calls.map((call) => (call.ok ? call.tool : `${call.tool}→${call.errorCode}`)).join(", ") || "no tool calls";
  console.log(`${report.id} ${report.passed ? "PASS" : "FAIL"}  ${report.title}  [${report.checks.length} checks; ${calls}; ${report.durationMs} ms]`);
  for (const check of report.checks.filter((entry) => !entry.ok)) console.log(`     ✗ ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
}
const passed = reports.filter((report) => report.passed).length;
console.log(`L1: ${passed}/${reports.length} cases passed`);

// Reports hold generated values, so they stay under the Git-ignored .cache/.
const dir = path.join(REPOSITORY_ROOT, ".cache", "runs");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `l1-${started.toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify({ level: "L1", startedAt: started.toISOString(), passed, total: reports.length, reports }, null, 2)}\n`);
console.log(`Report: ${path.relative(REPOSITORY_ROOT, file)}`);
if (passed !== reports.length) process.exitCode = 1;

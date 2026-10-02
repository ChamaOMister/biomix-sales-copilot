/**
 * Builds the self-contained HTML answer snapshot (Node 24 runs this file directly):
 *
 *   npm run web:snapshot                       # runs L2 (scripted model, no key) and renders it
 *   npm run web:snapshot -- --from .cache/runs/l3-….json   # renders a saved L3 run instead
 *   npm run web:snapshot -- --code-url https://github.com/…  # links the page to the source code
 *
 * Writes .cache/web/biomix-copilot-snapshot.html (Git-ignored). Publishing it is the maintainer's
 * decision.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CASES } from "../evals/cases.ts";
import { loadEvalContext } from "../evals/context.ts";
import { runScriptedEvals } from "../evals/l2.ts";
import type { CopilotRun } from "../src/copilot/loop.ts";
import { DEFAULT_CHECKOUT_DIR, REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { readerConnectionString } from "../src/db/reader-setup.ts";
import { connectToolServer } from "../src/mcp-client/client.ts";
import { loadLocalEnv } from "../src/setup/env.ts";
import { runView } from "../src/web/server.ts";
import { renderSnapshot, type SnapshotEntry, type SnapshotInput } from "../src/web/snapshot.ts";

const { values } = parseArgs({ options: { "answer-key": { type: "string" }, from: { type: "string" }, "code-url": { type: "string" } }, strict: true });
const codeUrl = values["code-url"];
if (!values["answer-key"] || (codeUrl !== undefined && !/^https:\/\/[^\s"<>]+$/.test(codeUrl))) {
  console.error("Usage: npm run web:snapshot [-- --from <L3 run record>] [--code-url https://…] (package.json passes --answer-key)");
  process.exit(1);
}
loadLocalEnv();

const titles = new Map(CASES.map((evalCase) => [evalCase.id, evalCase.title]));
function entryOf(id: string, run: CopilotRun, passed: boolean): SnapshotEntry {
  const view = runView(run);
  const cited = new Set(run.sources.map((source) => source.resultId));
  return {
    id,
    title: titles.get(id) ?? id,
    question: view.question,
    status: view.status,
    answer: view.answer,
    limitations: view.limitations,
    toolCalls: view.toolCalls.map((call) => ({ ...call, cited: cited.has(call.id) })),
    passed,
  };
}

function datasetOf(runs: CopilotRun[]): SnapshotInput["dataset"] {
  for (const run of runs) {
    for (const result of run.results) {
      const value = result.value as { asOf?: string; source?: { repository: string; tag: string; commit: string; seed: number } };
      if (value.asOf && value.source) return { asOf: value.asOf, ...value.source };
    }
  }
  return null;
}

let input: SnapshotInput;
if (values.from) {
  const record = JSON.parse(readFileSync(path.resolve(values.from), "utf8")) as {
    level: string;
    model: string;
    startedAt: string;
    entries: { id: string; attempt: number; passed: boolean; run: CopilotRun }[];
  };
  if (record.level !== "L3") throw new Error("--from expects an L3 run record from npm run eval:live");
  const firsts = record.entries.filter((entry) => entry.attempt === 1);
  input = {
    level: "L3",
    model: record.model,
    generatedAt: record.startedAt,
    dataset: datasetOf(firsts.map((entry) => entry.run)),
    entries: firsts.map((entry) => entryOf(entry.id, entry.run, entry.passed)),
  };
} else {
  const readerUrl = readerConnectionString(process.env);
  if (!readerUrl) {
    console.error("No reader connection: run npm run setup:env and npm run db:reader.");
    process.exit(1);
  }
  const ctx = await loadEvalContext(path.resolve(values["answer-key"]), DEFAULT_CHECKOUT_DIR);
  const client = await connectToolServer(readerUrl);
  try {
    const reports = await runScriptedEvals(client, ctx);
    input = {
      level: "L2",
      model: "scripted",
      generatedAt: new Date().toISOString(),
      dataset: datasetOf(reports.map((report) => report.run)),
      entries: reports.map((report) => entryOf(report.id, report.run, report.passed)),
    };
  } finally {
    await client.close();
  }
}

const dir = path.join(REPOSITORY_ROOT, ".cache", "web");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "biomix-copilot-snapshot.html");
writeFileSync(file, renderSnapshot(codeUrl ? { ...input, codeUrl } : input));
console.log(`Snapshot (${input.level}, ${input.entries.length} answers): ${path.relative(REPOSITORY_ROOT, file)}`);

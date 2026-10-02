/**
 * L3: the copilot with the live model, graded by the same deterministic checks as L2 (Node 24 runs
 * this file directly). On demand only: locally, or in the manual Publish demo workflow, never in the
 * Checks workflow. It spends API credit:
 *
 *   npm run eval:live [-- --case E04 --repeat 3 --max-run-tokens 3000000]
 *
 * Exits with code 3 and a message when ANTHROPIC_API_KEY is missing (L3 not run). Stops starting
 * new cases once the run's token ceiling is reached. Reports per-case results, the pass rate,
 * tokens, cost and latency. Exits with code 1 unless the guardrail cases E16–E20 all pass and, in a
 * full run, at least 85% of the other cases pass (the threshold set after the first measured runs;
 * docs/milestone-reports.md, milestone 11). The report and transcripts go to .cache/runs/.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { CASES } from "../evals/cases.ts";
import { loadEvalContext } from "../evals/context.ts";
import { gradeRun } from "../evals/grade.ts";
import { AnthropicModelClient } from "../src/copilot/anthropic.ts";
import { costNanodollars, formatUsd } from "../src/copilot/cost.ts";
import { listToolSpecs, runCopilot } from "../src/copilot/loop.ts";
import { addUsage, totalTokens, ZERO_USAGE } from "../src/copilot/types.ts";
import { DEFAULT_CHECKOUT_DIR, REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { readerConnectionString } from "../src/db/reader-setup.ts";
import { connectToolServer } from "../src/mcp-client/client.ts";
import { runStamp, writeRunRecord } from "../src/runs/transcripts.ts";
import { loadLocalEnv } from "../src/setup/env.ts";
import { EXIT_NO_API_KEY, NO_KEY_MESSAGE, readModelConfig } from "../src/setup/model-config.ts";

const GUARDRAILS = ["E16", "E17", "E18", "E19", "E20"];
/** Minimum pass rate of the non-guardrail cases in a full run, in basis points. */
const THRESHOLD_BASIS_POINTS = 8_500;

const { values } = parseArgs({
  options: {
    "answer-key": { type: "string" },
    case: { type: "string", multiple: true, default: [] },
    repeat: { type: "string", default: "1" },
    "max-run-tokens": { type: "string", default: "3000000" },
  },
  strict: true,
});
const repeat = Number(values.repeat);
const maxRunTokens = Number(values["max-run-tokens"]);
if (!values["answer-key"] || !Number.isInteger(repeat) || repeat < 1 || repeat > 10 || !Number.isInteger(maxRunTokens) || maxRunTokens < 1) {
  console.error("Usage: npm run eval:live [-- --case E01 --repeat 1..10 --max-run-tokens N] (package.json passes --answer-key)");
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

const ctx = await loadEvalContext(path.resolve(values["answer-key"]), DEFAULT_CHECKOUT_DIR);
const selected = CASES.filter((evalCase) => values.case.length === 0 || values.case.includes(evalCase.id));
const started = new Date();
const tools = await connectToolServer(readerUrl);
const model = new AnthropicModelClient({ ...config, ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}) });
const toolSpecs = await listToolSpecs(tools);

interface Entry {
  id: string;
  attempt: number;
  passed: boolean;
  status: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  toolCalls: number;
  modelRequests: number;
  tokens: number;
  costNanodollars: number | null;
  durationMs: number;
  run: unknown;
}
const entries: Entry[] = [];
const notRun: string[] = [];
let runUsage = ZERO_USAGE;
try {
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    for (const evalCase of selected) {
      if (totalTokens(runUsage) >= maxRunTokens) {
        notRun.push(`${evalCase.id}#${attempt}`);
        continue;
      }
      const run = await runCopilot(evalCase.question(ctx), {
        model,
        tools,
        toolSpecs,
        budgets: { maxTokens: Math.min(300_000, maxRunTokens - totalTokens(runUsage)) },
      });
      runUsage = addUsage(runUsage, run.usage);
      const grade = await gradeRun(evalCase, ctx, run);
      const costs = Object.entries(run.usageByModel).map(([name, usage]) => costNanodollars(name, usage));
      const cost = costs.every((value) => value !== null) ? costs.reduce<number>((sum, value) => sum + value, 0) : null;
      entries.push({
        id: evalCase.id,
        attempt,
        passed: grade.passed,
        status: run.status,
        checks: grade.checks,
        toolCalls: run.results.length,
        modelRequests: run.modelRequests,
        tokens: totalTokens(run.usage),
        costNanodollars: cost,
        durationMs: run.durationMs,
        run,
      });
      console.log(
        `${evalCase.id}#${attempt} ${grade.passed ? "PASS" : "FAIL"}  ${run.status}; ${run.results.length} tool calls; ` +
          `${totalTokens(run.usage)} tokens; ${cost === null ? "cost unknown" : formatUsd(cost)}; ${run.durationMs} ms`,
      );
      for (const check of grade.checks.filter((entry) => !entry.ok)) console.log(`     ✗ ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
    }
  }
} finally {
  await tools.close();
}

const passed = entries.filter((entry) => entry.passed).length;
const guardrailFailures = entries.filter((entry) => GUARDRAILS.includes(entry.id) && !entry.passed);
const others = entries.filter((entry) => !GUARDRAILS.includes(entry.id));
const othersPassed = others.filter((entry) => entry.passed).length;
// The threshold applies to full runs only; a run limited with --case or the token ceiling reports it as not applied.
const fullRun = values.case.length === 0 && notRun.length === 0;
const thresholdMet = fullRun ? othersPassed * 10_000 >= THRESHOLD_BASIS_POINTS * others.length : null;
const knownCosts = entries.map((entry) => entry.costNanodollars);
const totalCost = knownCosts.every((value) => value !== null) ? knownCosts.reduce<number>((sum, value) => sum + value, 0) : null;
const latencies = entries.map((entry) => entry.durationMs).sort((a, b) => a - b);
const summary = {
  level: "L3",
  model: model.name,
  startedAt: started.toISOString(),
  runs: entries.length,
  passed,
  passRateBasisPoints: entries.length ? Math.round((passed * 10_000) / entries.length) : null,
  guardrailsPassed: guardrailFailures.length === 0,
  othersPassed,
  othersRuns: others.length,
  thresholdBasisPoints: THRESHOLD_BASIS_POINTS,
  thresholdMet,
  usage: runUsage,
  costUsd: totalCost === null ? null : formatUsd(totalCost),
  medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
  notRun,
};
console.log(
  `L3 ${model.name}: ${passed}/${entries.length} passed; guardrails ${summary.guardrailsPassed ? "passed" : "FAILED"}; ` +
    `others ${othersPassed}/${others.length} (threshold 85%: ${thresholdMet === null ? "not applied" : thresholdMet ? "met" : "NOT MET"}); ` +
    `${totalTokens(runUsage)} tokens; cost ${summary.costUsd ?? "unknown"}; median ${summary.medianLatencyMs ?? "-"} ms` +
    (notRun.length ? `; not run (token ceiling): ${notRun.join(", ")}` : ""),
);
const file = writeRunRecord(`l3-${runStamp(started)}`, { ...summary, entries });
console.log(`Report and transcripts: ${path.relative(REPOSITORY_ROOT, file)}`);
if (!summary.guardrailsPassed || thresholdMet === false) process.exitCode = 1;

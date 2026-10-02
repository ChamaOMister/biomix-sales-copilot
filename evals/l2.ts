/**
 * L2: the copilot loop with a scripted model, against the real MCP server over stdio, graded by
 * the same deterministic checks as L3. Proves the loop, limits, placeholder validation, rendering
 * and statuses without an API key.
 */
import { listToolSpecs, runCopilot, type CopilotRun } from "../src/copilot/loop.ts";
import { ScriptedModelClient } from "../src/copilot/scripted.ts";
import type { ToolPort } from "../src/copilot/types.ts";
import { CASES } from "./cases.ts";
import type { EvalContext } from "./context.ts";
import { gradeRun, type Grade } from "./grade.ts";
import { scriptFor } from "./scripted.ts";

export interface ScriptedReport {
  id: string;
  title: string;
  passed: boolean;
  grade: Grade;
  run: CopilotRun;
}

export async function runScriptedEvals(tools: ToolPort, ctx: EvalContext, only?: readonly string[]): Promise<ScriptedReport[]> {
  const toolSpecs = await listToolSpecs(tools);
  const reports: ScriptedReport[] = [];
  for (const evalCase of CASES) {
    if (only && only.length > 0 && !only.includes(evalCase.id)) continue;
    const model = new ScriptedModelClient(await scriptFor(evalCase, ctx));
    const run = await runCopilot(evalCase.question(ctx), { model, tools, toolSpecs });
    const grade = await gradeRun(evalCase, ctx, run);
    reports.push({ id: evalCase.id, title: evalCase.title, passed: grade.passed, grade, run });
  }
  return reports;
}

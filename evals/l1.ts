/**
 * L1, tool-level evaluations: each case's reference tool plan runs against the real MCP server
 * over stdio, and the results are checked against AK and RC. Also checks each case's validity
 * (its AK facts agree with RC; its question contains no expected value) and that no tool output
 * contains a string found only in the answer key.
 */
import type { ToolClient } from "../src/mcp-client/client.ts";
import { answerKeyOnlyStrings } from "./answer-key.ts";
import { CASES, type Check, type EvalCase, type Fact, type ToolResult } from "./cases.ts";
import type { EvalContext } from "./context.ts";
import { questionProblems } from "./validate.ts";

export interface CaseReport {
  id: string;
  title: string;
  question: string;
  passed: boolean;
  checks: Check[];
  calls: { tool: string; ok: boolean; errorCode?: string }[];
  durationMs: number;
}

export async function factsOf(evalCase: EvalCase, ctx: EvalContext): Promise<Fact[]> {
  return evalCase.facts(ctx);
}

export async function runPlan(client: ToolClient, evalCase: EvalCase, ctx: EvalContext): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of evalCase.plan(ctx)) {
    const result = await client.callTool(call.tool, call.args);
    results.push({ call, isError: result.isError, value: result.value as Record<string, any> });
  }
  return results;
}

export async function runCase(client: ToolClient, evalCase: EvalCase, ctx: EvalContext, toolNames: readonly string[]): Promise<CaseReport> {
  const started = performance.now();
  const question = evalCase.question(ctx);
  const checks: Check[] = (await questionProblems(evalCase, ctx)).map((problem) => ({ name: "question reveals no expected value", ok: false, detail: problem }));
  const results = await runPlan(client, evalCase, ctx);
  for (const result of results) {
    const code = (result.value.error as { code?: string } | undefined)?.code;
    if (result.call.expectError) {
      checks.push({ name: `${result.call.tool} fails with ${result.call.expectError}`, ok: result.isError && code === result.call.expectError, ...(code ? { detail: code } : {}) });
    } else {
      checks.push({ name: `${result.call.tool} succeeds`, ok: !result.isError, ...(code ? { detail: code } : {}) });
    }
  }
  checks.push(...(await evalCase.check({ ctx, results, toolNames })));
  checks.push(...(evalCase.consistency?.(ctx) ?? []));
  const output = JSON.stringify(results.map((result) => result.value));
  const leaked = answerKeyOnlyStrings(ctx.ak).filter((text) => output.includes(text));
  checks.push({ name: "no answer-key string in tool outputs", ok: leaked.length === 0, ...(leaked.length ? { detail: `${leaked.length} found` } : {}) });
  return {
    id: evalCase.id,
    title: evalCase.title,
    question,
    passed: checks.every((check) => check.ok),
    checks,
    calls: results.map((result) => ({
      tool: result.call.tool,
      ok: !result.isError,
      ...(result.isError ? { errorCode: (result.value.error as { code?: string } | undefined)?.code ?? "unknown" } : {}),
    })),
    durationMs: Math.round(performance.now() - started),
  };
}

export async function runToolEvals(client: ToolClient, ctx: EvalContext, only?: readonly string[]): Promise<CaseReport[]> {
  const toolNames = (await client.listTools()).map((tool) => tool.name);
  const reports: CaseReport[] = [];
  for (const evalCase of CASES) {
    if (only && only.length > 0 && !only.includes(evalCase.id)) continue;
    reports.push(await runCase(client, evalCase, ctx, toolNames));
  }
  return reports;
}

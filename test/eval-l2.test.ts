import { afterAll, beforeAll, expect, test } from "vitest";
import { answerKeyOnlyStrings, SCENARIO_KINDS } from "../evals/answer-key.ts";
import { CASES } from "../evals/cases.ts";
import { defaultAnswerKeyPath, loadEvalContext, type EvalContext } from "../evals/context.ts";
import { runScriptedEvals, type ScriptedReport } from "../evals/l2.ts";
import { SYSTEM_PROMPT } from "../src/copilot/prompt.ts";
import { connectToolServer, type ToolClient } from "../src/mcp-client/client.ts";
import { describeDatabase } from "./support/database.ts";
import { CHECKOUT_DIR, readerUrl } from "./support/tools.ts";

describeDatabase("L2: the copilot loop with a scripted model", () => {
  let ctx: EvalContext;
  let client: ToolClient;
  let reports: ScriptedReport[];

  beforeAll(async () => {
    ctx = await loadEvalContext(defaultAnswerKeyPath(CHECKOUT_DIR), CHECKOUT_DIR);
    client = await connectToolServer(readerUrl(), { stderr: "pipe" });
    reports = await runScriptedEvals(client, ctx);
  }, 120_000);
  afterAll(() => client.close());

  test("every case passes the deterministic grading", () => {
    expect(reports.filter((report) => !report.passed).map((report) => ({ id: report.id, failed: report.grade.checks.filter((check) => !check.ok) }))).toEqual([]);
    expect(reports).toHaveLength(20);
  });

  test("statuses match the cases, and every answered case cites sources", () => {
    for (const report of reports) {
      const evalCase = CASES.find((entry) => entry.id === report.id)!;
      expect(evalCase.statuses).toContain(report.run.status);
      if (report.run.status === "answered") expect(report.run.sources.length).toBeGreaterThan(0);
    }
  });

  test("the system prompt contains no case question, scenario kind or answer-key value", () => {
    for (const evalCase of CASES) expect(SYSTEM_PROMPT).not.toContain(evalCase.question(ctx));
    for (const kind of SCENARIO_KINDS) expect(SYSTEM_PROMPT).not.toContain(kind);
    for (const text of answerKeyOnlyStrings(ctx.ak)) expect(SYSTEM_PROMPT.toLowerCase()).not.toContain(text.toLowerCase());
    const values = ctx.ak.scenarios.flatMap((scenario) => [scenario.customerId, ...("invoiceNumbers" in scenario ? scenario.invoiceNumbers : []), ...("invoiceNumber" in scenario ? [scenario.invoiceNumber] : [])]);
    for (const value of values) expect(SYSTEM_PROMPT).not.toContain(value);
    expect(SYSTEM_PROMPT).not.toMatch(/\bC\d{4}\b|\b\d{6}\b|R\$/);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type pg from "pg";
import { CASES, type EvalCase } from "../evals/cases.ts";
import { defaultAnswerKeyPath, loadEvalContext, type EvalContext } from "../evals/context.ts";
import { runToolEvals, type CaseReport } from "../evals/l1.ts";
import { containsValue, questionProblems } from "../evals/validate.ts";
import { connectToolServer, type ToolClient } from "../src/mcp-client/client.ts";
import { adminPool, describeDatabase, fingerprint } from "./support/database.ts";
import { CHECKOUT_DIR, readerUrl } from "./support/tools.ts";

describe("case validity", () => {
  test("cases E01–E20 exist with unique IDs", () => {
    expect(CASES.map((evalCase) => evalCase.id)).toEqual(Array.from({ length: 20 }, (_, index) => `E${String(index + 1).padStart(2, "0")}`));
  });

  test("containsValue matches whole tokens only", () => {
    expect(containsValue("in June 2025", "202")).toBe(false);
    expect(containsValue("invoice 003441 please", "003441")).toBe(true);
    expect(containsValue("total R$ 1,234.56.", "R$ 1,234.56")).toBe(true);
    expect(containsValue("C00123", "C0012")).toBe(false);
  });
});

describeDatabase("L1 tool-level evaluations", () => {
  let ctx: EvalContext;
  let client: ToolClient;
  let admin: pg.Pool;
  let reports: CaseReport[];
  let before: Record<string, string>;

  beforeAll(async () => {
    ctx = await loadEvalContext(defaultAnswerKeyPath(CHECKOUT_DIR), CHECKOUT_DIR);
    admin = adminPool();
    before = await fingerprint(admin);
    client = await connectToolServer(readerUrl(), { stderr: "pipe" });
    reports = await runToolEvals(client, ctx);
  }, 120_000);
  afterAll(async () => {
    await client.close();
    await admin.end();
  });

  test("every case passes, including AK-versus-RC consistency and the answer-key leak check", () => {
    const failures = reports.filter((report) => !report.passed).map((report) => ({ id: report.id, failed: report.checks.filter((check) => !check.ok) }));
    expect(failures).toEqual([]);
    expect(reports).toHaveLength(20);
    for (const report of reports) expect(report.checks.map((check) => check.name)).toContain("no answer-key string in tool outputs");
  });

  test("stored data is identical before and after the evaluation suite", async () => {
    expect(await fingerprint(admin)).toEqual(before);
  });

  test("every question contains none of its expected values", async () => {
    for (const evalCase of CASES) expect([evalCase.id, await questionProblems(evalCase, ctx)]).toEqual([evalCase.id, []]);
  });

  test("a case whose question contains an expected value is rejected", async () => {
    const e05 = CASES.find((evalCase) => evalCase.id === "E05")!;
    const leaky: EvalCase = { ...e05, question: (context) => `Was ${e05.ids!(context).values[0]!} the largest customer in 2025?` };
    expect(await questionProblems(leaky, ctx)).toHaveLength(1);
    const e02 = CASES.find((evalCase) => evalCase.id === "E02")!;
    const facts = await e02.facts(ctx);
    const withAmount: EvalCase = { ...e02, question: () => `Were 2024 sales ${facts[0]!.display}?` };
    expect(await questionProblems(withAmount, ctx)).toEqual([`the question contains the expected value ${facts[0]!.display}`]);
  });
});

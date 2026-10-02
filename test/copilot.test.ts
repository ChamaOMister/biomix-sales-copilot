import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeInput, parseAnswer, renderScalar, resolveAnswer, type ToolResultRecord } from "../src/copilot/answer.ts";
import { runCopilot } from "../src/copilot/loop.ts";
import { LIMITATION_CODES, SYSTEM_PROMPT } from "../src/copilot/prompt.ts";
import { answerTurn, ScriptedModelClient, type ScriptTurn } from "../src/copilot/scripted.ts";
import type { ToolPort } from "../src/copilot/types.ts";
import { REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { connectToolServer } from "../src/mcp-client/client.ts";
import { RUNS_DIR, writeRunRecord } from "../src/runs/transcripts.ts";
import { LIMITATION_CODES as EVAL_LIMITATION_CODES } from "../evals/cases.ts";

const SOURCE = { repository: "https://example.invalid/repo", tag: "v1.0.0", commit: "a".repeat(40), seed: 7 };

/** A fake tool port: `sales_totals` succeeds, `broken` fails with a tool error, every call is recorded. */
function fakeTools(): ToolPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listTools: () =>
      Promise.resolve([
        { name: "sales_totals", description: "Sales", inputSchema: { type: "object" } },
        { name: "broken", description: "Always fails", inputSchema: { type: "object" } },
      ]),
    callTool(name) {
      calls.push(name);
      if (name === "broken") return Promise.resolve({ isError: true, value: { error: { code: "PERIOD_INVALID", message: "x", asOf: "2030-01-31" } } });
      return Promise.resolve({
        isError: false,
        value: { asOf: "2030-01-31", source: SOURCE, notes: [], totals: { salesCents: 123456, salesBrl: "R$ 1,234.56", invoiceCount: 1234 }, groups: [{ label: "North" }], ok: true, missing: null },
      });
    },
  };
}

const call = (name = "sales_totals", input: Record<string, unknown> = { period: "year-to-date" }) => ({ name, input });
const run = (turns: ScriptTurn[], tools = fakeTools(), budgets = {}) =>
  runCopilot("A question?", { model: new ScriptedModelClient(turns), tools, budgets });

describe("placeholder resolution and rendering", () => {
  const results: ToolResultRecord[] = [
    { id: "r1", tool: "sales_totals", input: {}, isError: false, value: { totals: { salesBrl: "R$ 9.00", invoiceCount: 6468 }, groups: [{ label: "Agro" }], flag: true, none: null } },
    { id: "r2", tool: "sales_totals", input: {}, isError: true, value: { error: { code: "PERIOD_INVALID", asOf: "2026-09-25" } } },
  ];

  test("placeholders resolve to scalars by dotted path, with list positions and error fields", () => {
    const resolution = resolveAnswer(
      { status: "answered", text: "Sales {{r1.totals.salesBrl}} in {{ r1.totals.invoiceCount }} invoices, {{r1.groups.0.label}}, {{r1.flag}}, as of {{r2.error.asOf}}.", limitations: [] },
      results,
    );
    expect(resolution.problems).toEqual([]);
    expect(resolution.rendered).toBe("Sales R$ 9.00 in 6,468 invoices, Agro, yes, as of 2026-09-25.");
    expect(resolution.cited).toEqual(["r1", "r2"]);
  });

  test("unresolved, non-scalar and malformed placeholders are rejected", () => {
    const problems = resolveAnswer(
      { status: "answered", text: "{{r3.totals.salesBrl}} {{r1.totals}} {{r1.none}} {{r1.groups.5.label}} {{r1.totals.nope}} {{oops}}", limitations: [] },
      results,
    ).problems.map((problem) => problem.code);
    expect(problems).toEqual(["PLACEHOLDER_UNRESOLVED", "PLACEHOLDER_NOT_SCALAR", "PLACEHOLDER_NOT_SCALAR", "PLACEHOLDER_UNRESOLVED", "PLACEHOLDER_UNRESOLVED", "MALFORMED_PLACEHOLDER"]);
  });

  test("the digit guard rejects digits and spelled-out quantities outside placeholders", () => {
    const check = (text: string) => resolveAnswer({ status: "answered", text, limitations: [] }, results).problems.map((problem) => problem.code);
    expect(check("Sales were {{r1.totals.salesBrl}} in 2024.")).toEqual(["DIGITS_OUTSIDE_PLACEHOLDERS"]);
    expect(check("Sales were {{r1.totals.salesBrl}}, twice the previous year.")).toEqual(["SPELLED_OUT_QUANTITY"]);
    expect(check("The ten largest customers: {{r1.groups.0.label}}.")).toEqual(["SPELLED_OUT_QUANTITY"]);
    expect(check("Sales of {{r1.totals.salesBrl}} came from one region, {{r1.groups.0.label}}.")).toEqual([]);
  });

  test("answered needs a placeholder; other statuses do not", () => {
    expect(resolveAnswer({ status: "answered", text: "No figures here.", limitations: [] }, results).problems.map((p) => p.code)).toEqual(["ANSWERED_WITHOUT_PLACEHOLDER"]);
    expect(resolveAnswer({ status: "out_of_scope", text: "I cannot do that.", limitations: [] }, results).problems).toEqual([]);
  });

  test("answers parse from JSON alone or one code fence, and the shape is strict", () => {
    expect(parseAnswer('```json\n{"status":"answered","text":"{{r1.flag}}","limitations":[]}\n```')).toMatchObject({ ok: true });
    expect(parseAnswer('Here you go: {"status":"answered"}')).toEqual({ ok: false, problems: [{ code: "ANSWER_NOT_JSON" }] });
    expect(parseAnswer('{"status":"done","text":"x"}')).toEqual({ ok: false, problems: [{ code: "ANSWER_SHAPE", field: "status" }] });
    expect(parseAnswer('{"status":"answered","text":"x","limitations":["MADE_UP"]}')).toEqual({ ok: false, problems: [{ code: "UNKNOWN_LIMITATION" }] });
    expect(parseAnswer('{"status":"answered","text":"x","extra":1}')).toMatchObject({ ok: false });
  });

  test("scalars render in display form, and inputs normalize with sorted keys", () => {
    expect(renderScalar(1234567)).toBe("1,234,567");
    expect(renderScalar(false)).toBe("no");
    expect(normalizeInput({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":2},"b":1}');
  });
});

describe("the bounded loop", () => {
  test("an answer is validated, rendered, and cites only the results it uses as sources", async () => {
    const tools = fakeTools();
    const result = await run(
      [
        { toolCalls: [call(), call("broken")] },
        { toolCalls: [call()] },
        answerTurn({ status: "answered", text: "Sales were {{r3.totals.salesBrl}} ({{r1.totals.invoiceCount}} invoices).", limitations: ["NO_PAYMENT_DATA"] }),
      ],
      tools,
    );
    expect(result.status).toBe("answered");
    expect(result.results.map((record) => record.id)).toEqual(["r1", "r2", "r3"]);
    expect(tools.calls).toEqual(["sales_totals", "broken", "sales_totals"]);
    expect(result.renderedText).toBe("Sales were R$ 1,234.56 (1,234 invoices).");
    expect(result.sources.map((source) => source.resultId)).toEqual(["r3", "r1"]);
    expect(result.sources[0]).toEqual({
      resultId: "r3",
      tool: "sales_totals",
      input: '{"period":"year-to-date"}',
      asOf: "2030-01-31",
      sourceCommit: SOURCE.commit,
      seed: 7,
      errorCode: null,
    });
    expect(result.rendered).toContain("Limitations:\n- NO_PAYMENT_DATA:");
    expect(result.rendered).toContain(`Sources:\n[r3] sales_totals {"period":"year-to-date"} (as of 2030-01-31, source ${"a".repeat(12)} seed 7)`);
    expect(result.modelRequests).toBe(3);
  });

  test("tool errors reach the model as error results carrying their code and result ID", async () => {
    const model = new ScriptedModelClient([{ toolCalls: [call("broken")] }, answerTurn({ status: "insufficient_data", text: "Not available after {{r1.error.asOf}}.", limitations: ["AFTER_AS_OF"] })]);
    const result = await runCopilot("Q?", { model, tools: fakeTools() });
    const lastMessage = model.requests[1]!.messages.at(-1)!;
    expect(lastMessage.role).toBe("user");
    const block = lastMessage.content[0]!;
    expect(block).toMatchObject({ type: "tool_result", isError: true });
    expect(JSON.parse((block as { content: string }).content)).toEqual({ resultId: "r1", error: { code: "PERIOD_INVALID", message: "x", asOf: "2030-01-31" } });
    expect(result.status).toBe("insufficient_data");
    expect(result.sources[0]!.errorCode).toBe("PERIOD_INVALID");
  });

  test("successful results reach the model with their result ID", async () => {
    const model = new ScriptedModelClient([{ toolCalls: [call()] }, answerTurn({ status: "answered", text: "{{r1.totals.salesBrl}}" })]);
    await runCopilot("Q?", { model, tools: fakeTools() });
    const block = model.requests[1]!.messages.at(-1)!.content[0] as { content: string };
    expect(JSON.parse(block.content)).toMatchObject({ resultId: "r1", result: { totals: { salesBrl: "R$ 1,234.56" } } });
    expect(model.requests[0]!.system).toBe(SYSTEM_PROMPT);
    expect(model.requests[0]!.tools.map((tool) => tool.name)).toEqual(["sales_totals", "broken"]);
  });

  test("one format retry, then format_error", async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [call()] },
      answerTurn({ status: "answered", text: "Sales were {{r1.totals.salesBrl}} in 2030." }),
      answerTurn({ status: "answered", text: "Sales were {{r9.totals.salesBrl}}." }),
      answerTurn({ status: "answered", text: "never reached {{r1.totals.salesBrl}}" }),
    ]);
    const result = await runCopilot("Q?", { model, tools: fakeTools() });
    expect(result.status).toBe("format_error");
    expect(result.formatRetries).toBe(1);
    expect(result.modelRequests).toBe(3);
    expect(result.formatProblems?.map((problem) => problem.code)).toEqual(["PLACEHOLDER_UNRESOLVED"]);
    expect(result.rendered).toBeNull();
    const retry = model.requests[2]!.messages.at(-1)!.content[0] as { text: string };
    expect(retry.text).toContain("DIGITS_OUTSIDE_PLACEHOLDERS");
  });

  test("a corrected answer after one retry is accepted", async () => {
    const result = await run([{ text: "Sure! The answer is below." }, answerTurn({ status: "out_of_scope", text: "I cannot do that." })]);
    expect(result).toMatchObject({ status: "out_of_scope", formatRetries: 1, renderedText: "I cannot do that." });
  });

  test("an exhausted tool-call budget ends as incomplete", async () => {
    const result = await run([{ toolCalls: Array.from({ length: 9 }, () => call()) }, answerTurn({ status: "answered", text: "{{r1.totals.salesBrl}}" })]);
    expect(result).toMatchObject({ status: "incomplete", incompleteReason: "TOOL_CALL_BUDGET", rendered: null });
    expect(result.results).toHaveLength(8);
  });

  test("an exhausted model-request budget ends as incomplete", async () => {
    const turns: ScriptTurn[] = Array.from({ length: 12 }, () => ({ toolCalls: [call("broken")] }));
    const result = await run(turns, fakeTools(), { maxToolCalls: 100 });
    expect(result).toMatchObject({ status: "incomplete", incompleteReason: "MODEL_REQUEST_BUDGET", modelRequests: 10 });
  });

  test("an exhausted token budget ends as incomplete", async () => {
    const result = await run([{ toolCalls: [call()] }, { toolCalls: [call()] }, answerTurn({ status: "answered", text: "{{r1.totals.salesBrl}}" })], fakeTools(), { maxTokens: 150 });
    expect(result).toMatchObject({ status: "incomplete", incompleteReason: "TOKEN_BUDGET" });
  });

  test("model errors, truncation and refusals end as incomplete", async () => {
    const failing = new Error("boom");
    failing.name = "APIConnectionError";
    expect((await run([{ error: failing }])).incompleteReason).toBe("MODEL_ERROR");
    expect((await run([{ stopReason: "max_tokens" }])).incompleteReason).toBe("MAX_TOKENS");
    expect((await run([{ stopReason: "refusal" }])).incompleteReason).toBe("MODEL_REFUSAL");
  });

  test("logs carry names, codes, usage and durations, never values", async () => {
    const events: unknown[] = [];
    await runCopilot("Secret question about R$ 99?", {
      model: new ScriptedModelClient([{ toolCalls: [call(), call("broken")] }, answerTurn({ status: "answered", text: "{{r1.totals.salesBrl}}" })]),
      tools: fakeTools(),
      log: (event) => events.push(event),
    });
    const text = JSON.stringify(events);
    expect(text).not.toContain("R$");
    expect(text).not.toContain("Secret");
    expect(text).toContain('"errorCode":"PERIOD_INVALID"');
  });
});

describe("system prompt", () => {
  test("lists exactly the fixed limitation codes, shared with the evaluations", () => {
    expect([...LIMITATION_CODES].sort()).toEqual([...EVAL_LIMITATION_CODES].sort());
    for (const code of LIMITATION_CODES) expect(SYSTEM_PROMPT).toContain(code);
  });

  test("contains no date, so the cached prefix is byte-stable", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_PROMPT).not.toMatch(/\b(19|20)\d{2}\b/);
  });
});

describe("environment and transcripts", () => {
  test("the MCP server's environment contains only the allowlist, even when the parent holds secrets", async () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-ant-canary-0000";
    process.env.COPILOT_READER_PASSWORD = "canary-password";
    process.env.DATABASE_URL = "postgres://admin:canary@localhost/db";
    try {
      const client = await connectToolServer("postgres://copilot_reader:x@localhost/db", {
        serverEntry: path.join(REPOSITORY_ROOT, "test", "support", "env-probe.ts"),
        stderr: "pipe",
      });
      try {
        const { value } = await client.callTool("env", {});
        const names = value.names as string[];
        expect(names).toContain("COPILOT_DATABASE_URL");
        const allowed = new Set(["COPILOT_DATABASE_URL", "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]);
        expect(names.filter((name) => !allowed.has(name))).toEqual([]);
      } finally {
        await client.close();
      }
    } finally {
      process.env = saved;
    }
  });

  test("run records are written only under .cache/runs/", () => {
    const name = `test-${process.pid}-${Date.now()}`;
    const file = writeRunRecord(name, { ok: true });
    try {
      expect(path.dirname(file)).toBe(RUNS_DIR);
      expect(path.relative(REPOSITORY_ROOT, file).startsWith(".cache/runs/")).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: true });
    } finally {
      rmSync(file, { force: true });
    }
    expect(() => writeRunRecord("../escape", {})).toThrow();
    expect(() => writeRunRecord("a/b", {})).toThrow();
    expect(() => writeRunRecord("fine", {}, path.join(REPOSITORY_ROOT, "docs"))).toThrow(/only under .cache/);
    expect(existsSync(path.join(REPOSITORY_ROOT, "docs", "fine.json"))).toBe(false);
  });
});

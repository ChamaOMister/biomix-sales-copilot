import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AnthropicModelClient, usageOf } from "../src/copilot/anthropic.ts";
import { costNanodollars, formatUsd } from "../src/copilot/cost.ts";
import { runCopilot } from "../src/copilot/loop.ts";
import { SYSTEM_PROMPT } from "../src/copilot/prompt.ts";
import type { ToolPort } from "../src/copilot/types.ts";
import { REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { describeDatabase } from "./support/database.ts";
import { message, startFakeAnthropic, type FakeAnthropic } from "./support/fake-anthropic.ts";

const CANARY = "sk-ant-api03-CANARY-0123456789abcdefCANARY";

const tools: ToolPort = {
  listTools: () => Promise.resolve([{ name: "dataset_overview", description: "Overview", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]),
  callTool: () => Promise.resolve({ isError: false, value: { asOf: "2030-01-31", source: { commit: "b".repeat(40), seed: 1 }, notes: [] } }),
};

const thinking = { type: "thinking", thinking: "", signature: "sig-opaque-123" };
const toolUse = { type: "tool_use", id: "toolu_01", name: "dataset_overview", input: {}, caller: { type: "direct" } };
const finalText = (text: string) => ({ type: "text", text, citations: null });
const answer = JSON.stringify({ status: "answered", text: "The data is as of {{r1.asOf}}.", limitations: ["NO_PAYMENT_DATA"] });

let fake: FakeAnthropic | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("Anthropic model client (keyless, against a local stand-in)", () => {
  test("requests use the configured model and effort, cache the static prefix, auto tool choice and default fallbacks", async () => {
    fake = await startFakeAnthropic([
      { body: message([thinking, toolUse], "tool_use") },
      { body: message([thinking, finalText(answer)], "end_turn", { cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }) },
    ]);
    const model = new AnthropicModelClient({ apiKey: CANARY, model: "claude-opus-5-5", effort: "high", baseURL: fake.url });
    const run = await runCopilot("When is the data from?", { model, tools });
    expect(run.status).toBe("answered");
    expect(run.renderedText).toBe("The data is as of 2030-01-31.");

    const [first, second] = fake.requests;
    expect(first!.path).toContain("/v1/messages");
    expect(first!.headers["x-api-key"]).toBe(CANARY);
    expect(first!.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(first!.body).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "high" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      tool_choice: { type: "auto" },
      fallbacks: "default",
      tools: [{ name: "dataset_overview", description: "Overview", input_schema: { type: "object" } }],
    });
    expect(first!.body).not.toHaveProperty("thinking");
    expect(first!.body).not.toHaveProperty("temperature");

    // The assistant turn is sent back exactly as received, thinking block and all; the history only grows.
    expect(second!.body.messages[1]).toEqual({ role: "assistant", content: [thinking, toolUse] });
    expect(second!.body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_01", is_error: false });
    expect(second!.body.messages.slice(0, 1)).toEqual(first!.body.messages);
    expect(run.usage).toEqual({ inputTokens: 2400, outputTokens: 600, cacheReadTokens: 4000, cacheWriteTokens: 4000 });
    expect(run.usageByModel).toEqual({ "claude-opus-5-5": run.usage });
  });

  test("fallbacks can be turned off", async () => {
    fake = await startFakeAnthropic([{ body: message([finalText(JSON.stringify({ status: "out_of_scope", text: "No.", limitations: [] }))], "end_turn") }]);
    await runCopilot("Q", { model: new AnthropicModelClient({ apiKey: CANARY, fallbacks: false, baseURL: fake.url }), tools });
    expect(fake.requests[0]!.body).not.toHaveProperty("fallbacks");
    expect(fake.requests[0]!.body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "medium" } });
  });

  test("an API error ends the question as incomplete, logging only type, status and request ID", async () => {
    fake = await startFakeAnthropic([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${CANARY}` } } }]);
    const events: unknown[] = [];
    const run = await runCopilot("Q", { model: new AnthropicModelClient({ apiKey: CANARY, baseURL: fake.url }), tools, log: (event) => events.push(event) });
    expect(run).toMatchObject({ status: "incomplete", incompleteReason: "MODEL_ERROR" });
    expect(events).toEqual([{ type: "model_error", errorType: "AuthenticationError", status: 401, requestId: "req_fake_1" }]);
    expect(JSON.stringify(run)).not.toContain(CANARY);
  });
});

describe("cost accounting", () => {
  test("cost is computed from a recorded usage fixture", () => {
    const fixture = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "test", "fixtures", "usage-response.json"), "utf8")) as { model: string; usage: any };
    const usage = usageOf(fixture.usage);
    expect(usage).toEqual({ inputTokens: 1830, outputTokens: 2410, cacheReadTokens: 6120, cacheWriteTokens: 512 });
    // 1830 × $4 + 2410 × $20 + 6120 × $0.20 + 512 × $5, per million tokens.
    expect(costNanodollars(fixture.model, usage)).toBe(1830 * 4000 + 2410 * 20000 + 6120 * 200 + 512 * 5000);
    expect(formatUsd(costNanodollars(fixture.model, usage)!)).toBe("$0.0593");
    expect(costNanodollars("claude-sonnet-5-5", usage)).toBe(1830 * 2000 + 2410 * 10000 + 6120 * 200 + 512 * 2500);
    expect(costNanodollars("unknown-model", usage)).toBeNull();
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(12_345_678_900)).toBe("$12.3457");
  });
});

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPOSITORY_ROOT, "scripts", script), ...args], { env, cwd: REPOSITORY_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("missing key", () => {
  test.each([["ask.ts", ["A question?"]], ["eval-live.ts", ["--answer-key", "unused.json"]]])(
    "%s gives a clear skip message and exit code 3",
    async (script, args) => {
      const result = await runScript(script, args, { ...process.env, ANTHROPIC_API_KEY: "" });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set, so the live model is skipped (L3 not run)");
    },
  );
});

describeDatabase("canary key", () => {
  test("npm run ask never writes the key to stdout, stderr or the run file", async () => {
    fake = await startFakeAnthropic([
      { body: message([thinking, toolUse], "tool_use") },
      { body: message([finalText(answer)], "end_turn") },
    ]);
    const result = await runScript("ask.ts", ["When is the data from?"], { ...process.env, ANTHROPIC_API_KEY: CANARY, ANTHROPIC_BASE_URL: fake.url });
    expect(result.code).toBe(0);
    expect(fake.requests[0]!.headers["x-api-key"]).toBe(CANARY);
    expect(result.stdout).toContain("The data is as of 2026-09-25.");
    const transcript = /Transcript: (\S+)/.exec(result.stderr)?.[1];
    expect(transcript).toMatch(/^\.cache\/runs\/ask-/);
    const file = path.join(REPOSITORY_ROOT, transcript!);
    try {
      for (const output of [result.stdout, result.stderr, readFileSync(file, "utf8")]) expect(output).not.toContain(CANARY);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("an authentication failure does not echo the key either", async () => {
    fake = await startFakeAnthropic([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
    const result = await runScript("ask.ts", ["Q?"], { ...process.env, ANTHROPIC_API_KEY: CANARY, ANTHROPIC_BASE_URL: fake.url });
    expect(result.stdout).toContain("No answer (incomplete: MODEL_ERROR)");
    const transcript = /Transcript: (\S+)/.exec(result.stderr)?.[1];
    const file = path.join(REPOSITORY_ROOT, transcript!);
    try {
      for (const output of [result.stdout, result.stderr, readFileSync(file, "utf8")]) expect(output).not.toContain(CANARY);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

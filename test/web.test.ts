import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { answerTurn, ScriptedModelClient } from "../src/copilot/scripted.ts";
import type { ModelClient, ToolPort } from "../src/copilot/types.ts";
import { REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { createWebServer, MAX_BODY_BYTES } from "../src/web/server.ts";
import { escapeHtml, renderSnapshot } from "../src/web/snapshot.ts";

const PAGE = readFileSync(path.join(REPOSITORY_ROOT, "src", "web", "page.html"), "utf8");
const tools: ToolPort = {
  listTools: () => Promise.resolve([]),
  callTool: (name, args) => Promise.resolve({ isError: false, value: { asOf: "2030-01-31", echo: { name, args }, totals: { salesBrl: "R$ 1.00" } } }),
};
const toolSpecs = [{ name: "sales_totals", description: "Sales", inputSchema: { type: "object" } }];

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(model: ModelClient | null): Promise<string> {
  server = createWebServer({ page: PAGE, tools, toolSpecs, model });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown, contentType = "application/json") =>
  fetch(url, { method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("web server", () => {
  test("serves the page with a restrictive content security policy", async () => {
    const base = await start(null);
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await response.text()).toContain("<title>Biomix Sales Copilot</title>");
  });

  test("keyless mode reports itself, runs tools and refuses questions", async () => {
    const base = await start(null);
    expect(await (await fetch(`${base}/api/info`)).json()).toEqual({ mode: "keyless", model: null, tools: toolSpecs });
    const tool = await post(`${base}/api/tool`, { name: "sales_totals", args: { period: "year-to-date" } });
    expect(await tool.json()).toMatchObject({ isError: false, value: { echo: { name: "sales_totals", args: { period: "year-to-date" } } } });
    const ask = await post(`${base}/api/ask`, { question: "How were sales?" });
    expect(ask.status).toBe(503);
    expect(((await ask.json()) as { error: string }).error).toContain("Keyless mode");
  });

  test("live mode answers through the copilot loop and returns the answer, limitations and tool calls", async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: "sales_totals", input: { period: "year-to-date" } }] },
      answerTurn({ status: "answered", text: "Sales were {{r1.totals.salesBrl}}.", limitations: ["NO_PAYMENT_DATA"] }),
    ]);
    const base = await start(model);
    expect(((await (await fetch(`${base}/api/info`)).json()) as { mode: string }).mode).toBe("live");
    const view = (await (await post(`${base}/api/ask`, { question: "How were sales?" })).json()) as Record<string, any>;
    expect(view).toMatchObject({
      question: "How were sales?",
      status: "answered",
      answer: "Sales were R$ 1.00.",
      limitations: [{ code: "NO_PAYMENT_DATA" }],
      toolCalls: [{ id: "r1", tool: "sales_totals", isError: false }],
    });
  });

  test("rejects bad requests", async () => {
    const base = await start(new ScriptedModelClient([]));
    expect((await post(`${base}/api/ask`, { question: "x".repeat(501) })).status).toBe(400);
    expect((await post(`${base}/api/ask`, { question: "" })).status).toBe(400);
    expect((await post(`${base}/api/ask`, "question=hi", "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await post(`${base}/api/ask`, "{not json")).status).toBe(400);
    expect((await post(`${base}/api/ask`, { question: "x".repeat(MAX_BODY_BYTES) })).status).toBe(413);
    expect((await post(`${base}/api/tool`, { name: "run_sql", args: {} })).status).toBe(400);
    expect((await post(`${base}/api/tool`, { name: "sales_totals", args: [1] })).status).toBe(400);
    expect((await fetch(`${base}/etc/passwd`)).status).toBe(404);
  });

  test("the page loads nothing from other origins and writes text, not HTML", () => {
    expect(PAGE).not.toMatch(/(src|href)\s*=\s*["']https?:/);
    expect(PAGE).not.toContain("innerHTML");
  });
});

describe("snapshot", () => {
  test("escapes every value and runs no script", () => {
    const html = renderSnapshot({
      level: "L2",
      model: "scripted",
      generatedAt: "2030-01-31T00:00:00.000Z",
      dataset: { asOf: "2030-01-31", repository: "https://example.invalid", tag: "v1", commit: "c".repeat(40), seed: 1 },
      entries: [
        {
          id: "E01",
          title: "A <b>title</b>",
          question: "Is <script>alert(1)</script> escaped?",
          status: "answered",
          answer: `Yes & "quoted" 'text'`,
          limitations: [{ code: "NO_PAYMENT_DATA", description: "No <i>payments</i>." }],
          toolCalls: [{ id: "r1", tool: "sales_totals", input: { q: "<x>" }, isError: false, value: { name: "</pre><script>" }, cited: true }],
          passed: false,
        },
      ],
      codeUrl: `https://example.invalid/"><script>`,
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Is &lt;script&gt;alert(1)&lt;/script&gt; escaped?");
    expect(html).toContain("Yes &amp; &quot;quoted&quot; &#39;text&#39;");
    expect(html).toContain("scripted model (evaluation level L2)");
    expect(html).toContain("commit cccccccccccc, seed 1");
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
    expect(html).toContain(`href="https://example.invalid/&quot;&gt;&lt;script&gt;"`);
  });

  test("shows each answer's grading result and the overall count", () => {
    const entry = { title: "t", question: "q", status: "answered", answer: "a", limitations: [], toolCalls: [] };
    const base = { level: "L3" as const, model: "m", generatedAt: "2030-01-31T00:00:00.000Z", dataset: null };
    const html = renderSnapshot({ ...base, entries: [{ ...entry, id: "E01", passed: true }, { ...entry, id: "E02", passed: false }] });
    expect(html).toContain("1 of 2 answers passed the deterministic checks");
    expect(html).toContain("passed the checks");
    expect(html).toContain("failed the checks");
    const ungraded = renderSnapshot({ ...base, entries: [{ ...entry, id: "E01" }] });
    expect(ungraded).not.toContain("the checks");
    expect(ungraded).not.toContain("Source code");
  });

  test("links each cited figure to its source, renders lists and offers status filters", () => {
    const html = renderSnapshot({
      level: "L3",
      model: "anthropic:claude-opus-5-5:medium",
      generatedAt: "2030-01-31T00:00:00.000Z",
      dataset: null,
      run: { costUsd: "$0.8943", medianLatencyMs: 12_000 },
      entries: [
        {
          id: "E01",
          title: "t",
          question: "q",
          status: "answered",
          answer: "ignored when segments exist",
          segments: [{ text: "Sales:\n- total " }, { text: "R$ 1.00", resultId: "r1", tool: "sales_totals", path: "totals.salesBrl" }, { text: "\n- <b>no</b>" }],
          limitations: [],
          toolCalls: [{ id: "r1", tool: "sales_totals", input: {}, isError: false, value: {}, cited: true }],
          passed: true,
        },
        { id: "E02", title: "t", question: "q", status: "out_of_scope", answer: "No.", limitations: [], toolCalls: [], passed: true },
      ],
    });
    expect(html).toContain(`<a class="cite" href="#E01-r1" title="From r1 (sales_totals): totals.salesBrl">R$ 1.00</a>`);
    expect(html).toContain(`<details id="E01-r1">`);
    expect(html).toContain("<p>Sales:</p><ul><li>total <a");
    expect(html).toContain("<li>&lt;b&gt;no&lt;/b&gt;</li>");
    expect(html).toContain(`id="f-answered"`);
    expect(html).toContain(`id="f-declined"`);
    expect(html).not.toContain(`id="f-failed"`);
    expect(html).toContain(">$0.89<");
    expect(html).toContain("claude-opus-5-5, effort medium");
    expect(html).not.toMatch(/<script/i);
  });
});

/**
 * The local web interface: one static page and a small JSON API over the copilot and its tools,
 * on Node's built-in HTTP server (no framework). It binds to 127.0.0.1 and has no authentication,
 * so it must not be exposed publicly: a public port would let anyone spend the API key.
 *
 *   GET  /            the page
 *   GET  /api/info    mode (live or keyless), model, tools
 *   POST /api/ask     { question } → the copilot's answer (live mode only)
 *   POST /api/tool    { name, args } → one tool result (keyless)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { runCopilot, type CopilotRun, type LogEvent } from "../copilot/loop.ts";
import { LIMITATIONS } from "../copilot/prompt.ts";
import type { ModelClient, ToolPort, ToolSpec } from "../copilot/types.ts";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_QUESTION_LENGTH = 500;

export interface WebOptions {
  page: string;
  tools: ToolPort;
  toolSpecs: readonly ToolSpec[];
  /** Null in keyless mode: questions are refused, the tool console still works. */
  model: ModelClient | null;
  onRun?: (run: CopilotRun) => void;
  log?: (event: LogEvent) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(request.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The body must be a JSON object.");
  }
}

/** What the page shows for a run: the answer, its limitations and sources, and the tool results. */
export function runView(run: CopilotRun) {
  return {
    question: run.question,
    status: run.status,
    incompleteReason: run.incompleteReason ?? null,
    answer: run.renderedText,
    limitations: run.limitations.map((code) => ({ code, description: LIMITATIONS[code] })),
    sources: run.sources,
    toolCalls: run.results.map((result) => ({ id: result.id, tool: result.tool, input: result.input, isError: result.isError, value: result.value })),
    modelRequests: run.modelRequests,
    usage: run.usage,
    durationMs: run.durationMs,
  };
}

export function createWebServer(options: WebOptions): Server {
  let busy = false;
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
      });
      response.end(options.page);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/info") {
      send(response, 200, {
        mode: options.model ? "live" : "keyless",
        model: options.model?.name ?? null,
        tools: options.toolSpecs.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tool") {
      const body = await readJson(request);
      const name = body.name;
      const args = body.args ?? {};
      if (typeof name !== "string" || !options.toolSpecs.some((tool) => tool.name === name)) throw new HttpError(400, "Unknown tool.");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new HttpError(400, "args must be a JSON object.");
      const result = await options.tools.callTool(name, args as Record<string, unknown>);
      send(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ask") {
      const body = await readJson(request);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (question === "" || question.length > MAX_QUESTION_LENGTH) throw new HttpError(400, `Ask a question of 1 to ${MAX_QUESTION_LENGTH} characters.`);
      if (!options.model) throw new HttpError(503, "Keyless mode: no ANTHROPIC_API_KEY is set, so questions are not answered. The tool console works.");
      if (busy) throw new HttpError(429, "Another question is being answered; try again shortly.");
      busy = true;
      try {
        const run = await runCopilot(question, { model: options.model, tools: options.tools, toolSpecs: options.toolSpecs, ...(options.log ? { log: options.log } : {}) });
        options.onRun?.(run);
        send(response, 200, runView(run));
      } finally {
        busy = false;
      }
      return;
    }
    throw new HttpError(404, "Not found.");
  };

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) send(response, error.status, { error: error.message });
      else send(response, 500, { error: "The request failed." });
    });
  });
}

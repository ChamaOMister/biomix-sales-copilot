/**
 * The bounded copilot loop (decision 001, section 3). Per question: at most 8 tool calls, 10 model
 * requests, one answer-format retry and a token ceiling; exceeding a limit ends with status
 * `incomplete`, never a guessed answer. Each tool result gets an ID (r1, r2, …) in call order, and
 * a tool error goes back to the model as an error result carrying its code.
 *
 * The model chooses tools and words; every number in the answer is copied from a tool result.
 * Logs carry tool names, error codes, token usage and durations only.
 */
import {
  describeProblems,
  parseAnswer,
  renderAnswer,
  resolveAnswer,
  sourceOf,
  type Answer,
  type AnswerProblem,
  type Source,
  type ToolResultRecord,
} from "./answer.ts";
import { SYSTEM_PROMPT, type LimitationCode } from "./prompt.ts";
import { addUsage, totalTokens, ZERO_USAGE, type ContentBlock, type Message, type ModelClient, type ToolPort, type ToolSpec, type Usage } from "./types.ts";

export interface Budgets {
  maxToolCalls: number;
  maxModelRequests: number;
  maxFormatRetries: number;
  /** Input, output and cache tokens summed over the question's model requests. */
  maxTokens: number;
}

export const DEFAULT_BUDGETS: Budgets = { maxToolCalls: 8, maxModelRequests: 10, maxFormatRetries: 1, maxTokens: 300_000 };

export type RunStatus = "answered" | "insufficient_data" | "out_of_scope" | "incomplete" | "format_error";

export type IncompleteReason = "TOOL_CALL_BUDGET" | "MODEL_REQUEST_BUDGET" | "TOKEN_BUDGET" | "MAX_TOKENS" | "MODEL_REFUSAL" | "MODEL_ERROR";

export type LogEvent =
  | { type: "model"; request: number; stopReason: string; usage: Usage; durationMs: number }
  | { type: "tool"; resultId: string; tool: string; ok: boolean; errorCode?: string; durationMs: number }
  | { type: "format"; problems: string[] }
  | { type: "model_error"; errorType: string; status?: number; requestId?: string };

export interface CopilotRun {
  question: string;
  status: RunStatus;
  /** The rendered answer with limitations and sources, when the model gave a valid answer. */
  rendered: string | null;
  /** The answer text alone, placeholders replaced: what graders search for values. */
  renderedText: string | null;
  answer: Answer | null;
  limitations: LimitationCode[];
  sources: Source[];
  results: ToolResultRecord[];
  modelRequests: number;
  formatRetries: number;
  usage: Usage;
  /** Usage per model that served a response; more than one only after a refusal fallback. */
  usageByModel: Record<string, Usage>;
  incompleteReason?: IncompleteReason;
  formatProblems?: AnswerProblem[];
  transcript: Message[];
  durationMs: number;
}

export interface CopilotOptions {
  model: ModelClient;
  tools: ToolPort;
  budgets?: Partial<Budgets>;
  log?: (event: LogEvent) => void;
  /** The tool definitions, when the caller has listed them already (they are static). */
  toolSpecs?: readonly ToolSpec[];
}

export async function listToolSpecs(tools: ToolPort): Promise<ToolSpec[]> {
  return (await tools.listTools()).map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
}

/** What the model sees for one tool result: its ID, and the result or the error. */
export function toolResultContent(record: ToolResultRecord): string {
  return JSON.stringify(record.isError ? { resultId: record.id, ...record.value } : { resultId: record.id, result: record.value });
}

function errorDiagnostics(error: unknown): { errorType: string; status?: number; requestId?: string } {
  const record = (error ?? {}) as { name?: unknown; status?: unknown; requestID?: unknown; request_id?: unknown };
  // SDK error classes keep `name` as "Error"; the class name says which error it was.
  const className = error instanceof Error ? error.constructor.name : undefined;
  const errorType = className && className !== "Error" ? className : typeof record.name === "string" ? record.name : "Error";
  const status = typeof record.status === "number" ? record.status : undefined;
  const requestId = typeof record.requestID === "string" ? record.requestID : typeof record.request_id === "string" ? record.request_id : undefined;
  return { errorType, ...(status !== undefined ? { status } : {}), ...(requestId !== undefined ? { requestId } : {}) };
}

export async function runCopilot(question: string, options: CopilotOptions): Promise<CopilotRun> {
  const started = performance.now();
  const budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  const log = options.log ?? (() => undefined);
  const toolSpecs = options.toolSpecs ?? (await listToolSpecs(options.tools));
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: question }] }];
  const results: ToolResultRecord[] = [];
  let usage = ZERO_USAGE;
  const usageByModel: Record<string, Usage> = {};
  let modelRequests = 0;
  let formatRetries = 0;

  const finish = (status: RunStatus, extra: Partial<CopilotRun> = {}): CopilotRun => ({
    question,
    status,
    rendered: null,
    renderedText: null,
    answer: null,
    limitations: [],
    sources: [],
    results,
    modelRequests,
    formatRetries,
    usage,
    usageByModel,
    transcript: messages,
    durationMs: Math.round(performance.now() - started),
    ...extra,
  });

  for (;;) {
    if (modelRequests >= budgets.maxModelRequests) return finish("incomplete", { incompleteReason: "MODEL_REQUEST_BUDGET" });
    if (totalTokens(usage) >= budgets.maxTokens) return finish("incomplete", { incompleteReason: "TOKEN_BUDGET" });
    modelRequests += 1;
    const requestStarted = performance.now();
    let response;
    try {
      response = await options.model.complete({ system: SYSTEM_PROMPT, tools: toolSpecs, messages });
    } catch (error) {
      log({ type: "model_error", ...errorDiagnostics(error) });
      return finish("incomplete", { incompleteReason: "MODEL_ERROR" });
    }
    usage = addUsage(usage, response.usage);
    const served = response.servedModel ?? options.model.name;
    usageByModel[served] = addUsage(usageByModel[served] ?? ZERO_USAGE, response.usage);
    log({ type: "model", request: modelRequests, stopReason: response.stopReason, usage: response.usage, durationMs: Math.round(performance.now() - requestStarted) });
    messages.push({ role: "assistant", content: response.content });
    if (totalTokens(usage) > budgets.maxTokens) return finish("incomplete", { incompleteReason: "TOKEN_BUDGET" });

    const toolUses = response.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
    if (toolUses.length > 0) {
      const replies: ContentBlock[] = [];
      for (const use of toolUses) {
        if (results.length >= budgets.maxToolCalls) return finish("incomplete", { incompleteReason: "TOOL_CALL_BUDGET" });
        const id = `r${results.length + 1}`;
        const callStarted = performance.now();
        let record: ToolResultRecord;
        try {
          const outcome = await options.tools.callTool(use.name, use.input);
          record = { id, tool: use.name, input: use.input, isError: outcome.isError, value: outcome.value };
        } catch {
          record = { id, tool: use.name, input: use.input, isError: true, value: { error: { code: "TOOL_UNAVAILABLE", message: "The tool call failed." } } };
        }
        results.push(record);
        const errorCode = record.isError ? (record.value.error as { code?: string } | undefined)?.code : undefined;
        log({ type: "tool", resultId: id, tool: use.name, ok: !record.isError, ...(errorCode ? { errorCode } : {}), durationMs: Math.round(performance.now() - callStarted) });
        replies.push({ type: "tool_result", toolUseId: use.id, content: toolResultContent(record), isError: record.isError });
      }
      messages.push({ role: "user", content: replies });
      continue;
    }

    if (response.stopReason === "max_tokens") return finish("incomplete", { incompleteReason: "MAX_TOKENS" });
    if (response.stopReason === "refusal") return finish("incomplete", { incompleteReason: "MODEL_REFUSAL" });

    const text = response.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    const parsed = parseAnswer(text);
    const problems = parsed.ok ? resolveAnswer(parsed.answer, results).problems : parsed.problems;
    if (parsed.ok && problems.length === 0) {
      const resolution = resolveAnswer(parsed.answer, results);
      const sources = resolution.cited.map((id) => sourceOf(results.find((result) => result.id === id)!));
      return finish(parsed.answer.status, {
        answer: parsed.answer,
        limitations: parsed.answer.limitations,
        sources,
        rendered: renderAnswer(resolution.rendered, parsed.answer.limitations, sources),
        renderedText: resolution.rendered,
      });
    }
    log({ type: "format", problems: problems.map((problem) => problem.code) });
    if (formatRetries >= budgets.maxFormatRetries) return finish("format_error", { formatProblems: problems });
    formatRetries += 1;
    messages.push({
      role: "user",
      content: [{ type: "text", text: `Your final answer was rejected:\n${describeProblems(problems)}\nReply with the corrected JSON answer only.` }],
    });
  }
}

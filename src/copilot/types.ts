/**
 * The copilot's model-facing types. The model sits behind the small `ModelClient` interface;
 * the Anthropic and scripted clients implement it. The copilot reaches data only through a
 * `ToolPort` (the MCP client over stdio): no file system and no database here.
 */

/**
 * `raw` keeps the provider's original block, which is sent back unchanged: providers may bind
 * later reasoning to the exact earlier content, so the history is append-only and never rebuilt.
 */
export type ContentBlock =
  | { type: "text"; text: string; raw?: unknown }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; raw?: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  /** A provider block (for example extended thinking) passed back to the provider verbatim. */
  | { type: "opaque"; block: unknown };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const totalTokens = (usage: Usage): number => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

export interface ModelRequest {
  system: string;
  tools: readonly ToolSpec[];
  messages: readonly Message[];
}

export interface ModelResponse {
  content: ContentBlock[];
  /** The model that produced the response, when the provider reports it (for example after a fallback). */
  servedModel?: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: Usage;
}

export interface ModelClient {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** The tools as the copilot sees them: listed and called over MCP. */
export interface ToolPort {
  listTools(): Promise<{ name: string; description?: string; inputSchema: Record<string, unknown> }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: Record<string, unknown> }>;
}

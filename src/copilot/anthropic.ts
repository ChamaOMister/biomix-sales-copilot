/**
 * The Anthropic model client (decision 001, section 5), on the Messages API with client-side
 * tools. Only this client receives the API key, from its caller; it never logs headers, keys or
 * the environment, and the SDK's own logging is off.
 *
 * - Model and effort are configuration. Thinking is left at the model's default (always on for
 *   Claude Opus 5.5); effort is set explicitly. Tool choice stays automatic.
 * - The static prefix (tool definitions and system prompt) carries an explicit cache breakpoint;
 *   top-level automatic caching covers the growing conversation.
 * - Assistant blocks are sent back exactly as received (append-only history).
 * - Server-side refusal fallbacks are on by default (`fallbacks: "default"`), and can be turned off.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Message, ModelClient, ModelRequest, ModelResponse, Usage } from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = "medium";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicClientOptions {
  apiKey: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Server-side refusal fallbacks; on by default. */
  fallbacks?: boolean;
  /** For tests: a local stand-in for the API. */
  baseURL?: string;
}

type BetaBlockParam = Anthropic.Beta.BetaContentBlockParam;

function toParam(block: ContentBlock): BetaBlockParam {
  switch (block.type) {
    case "text":
      return (block.raw as BetaBlockParam | undefined) ?? { type: "text", text: block.text };
    case "tool_use":
      return (block.raw as BetaBlockParam | undefined) ?? { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: block.toolUseId, content: block.content, is_error: block.isError };
    case "opaque":
      return block.block as BetaBlockParam;
  }
}

export function toMessageParams(messages: readonly Message[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content.map(toParam) }));
}

export function fromResponseContent(content: readonly Anthropic.Beta.BetaContentBlock[]): ContentBlock[] {
  return content.map((block): ContentBlock => {
    if (block.type === "text") return { type: "text", text: block.text, raw: block };
    if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown>, raw: block };
    return { type: "opaque", block };
  });
}

export function usageOf(usage: Anthropic.Beta.BetaUsage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function stopReasonOf(reason: string | null): ModelResponse["stopReason"] {
  if (reason === "end_turn" || reason === "stop_sequence") return "end_turn";
  if (reason === "tool_use" || reason === "max_tokens" || reason === "refusal") return reason;
  return "other";
}

export class AnthropicModelClient implements ModelClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxTokens: number;
  private readonly fallbacks: boolean;

  constructor(options: AnthropicClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    this.maxTokens = options.maxTokens ?? 16_000;
    this.fallbacks = options.fallbacks ?? true;
    this.name = `anthropic:${this.model}:${this.effort}`;
    this.client = new Anthropic({ apiKey: options.apiKey, logLevel: "off", maxRetries: 2, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      output_config: { effort: this.effort },
      // Tools render before the system prompt, so this breakpoint caches both.
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      })),
      tool_choice: { type: "auto" },
      messages: toMessageParams(request.messages),
      // Automatic caching of the conversation tail.
      cache_control: { type: "ephemeral" },
      ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    });
    return {
      content: fromResponseContent(response.content),
      stopReason: stopReasonOf(response.stop_reason),
      usage: usageOf(response.usage),
      servedModel: response.model,
    };
  }
}

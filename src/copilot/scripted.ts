/**
 * A model client that replays a fixed script: each turn either calls tools or gives a final
 * answer. Used by L2 and the tests, so the whole loop runs without an API key. Answers in a
 * script use placeholders only, never literal values.
 */
import { ZERO_USAGE, type ContentBlock, type ModelClient, type ModelRequest, type ModelResponse, type Usage } from "./types.ts";

export type ScriptTurn =
  | { toolCalls: { name: string; input: Record<string, unknown> }[] }
  | { text: string }
  | { error: Error }
  | { stopReason: "max_tokens" | "refusal" };

export class ScriptedModelClient implements ModelClient {
  readonly name = "scripted";
  readonly requests: ModelRequest[] = [];
  private turn = 0;
  private readonly turns: readonly ScriptTurn[];
  private readonly usagePerTurn: Usage;

  constructor(turns: readonly ScriptTurn[], usagePerTurn: Usage = { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20 }) {
    this.turns = turns;
    this.usagePerTurn = usagePerTurn;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const turn = this.turns[this.turn];
    this.turn += 1;
    if (!turn) return Promise.reject(new Error("The script has no more turns"));
    if ("error" in turn) return Promise.reject(turn.error);
    if ("stopReason" in turn) return Promise.resolve({ content: [], stopReason: turn.stopReason, usage: this.usagePerTurn });
    if ("text" in turn) return Promise.resolve({ content: [{ type: "text", text: turn.text }], stopReason: "end_turn", usage: this.usagePerTurn });
    const content: ContentBlock[] = turn.toolCalls.map((call, index) => ({
      type: "tool_use",
      id: `toolu_${this.turn}_${index}`,
      name: call.name,
      input: call.input,
    }));
    return Promise.resolve({ content, stopReason: "tool_use", usage: this.usagePerTurn });
  }
}

export const answerTurn = (answer: { status: string; text: string; limitations?: string[] }): ScriptTurn => ({
  text: JSON.stringify({ status: answer.status, text: answer.text, limitations: answer.limitations ?? [] }),
});

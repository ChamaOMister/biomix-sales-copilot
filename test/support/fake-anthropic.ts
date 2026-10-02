/**
 * A local stand-in for the Messages API, for keyless tests of the Anthropic client: it records
 * each request's headers and body and answers from a script.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

export type FakeReply = { status?: number; body: object };

export interface FakeAnthropic {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export function message(content: object[], stopReason: string, usage: Partial<Record<string, number>> = {}): object {
  return {
    id: `msg_fake_${Math.random().toString(16).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0, ...usage },
  };
}

export async function startFakeAnthropic(replies: readonly FakeReply[]): Promise<FakeAnthropic> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any> });
      const reply = replies[requests.length - 1] ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "script exhausted" } } };
      response.writeHead(reply.status ?? 200, { "content-type": "application/json", "request-id": `req_fake_${requests.length}` });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

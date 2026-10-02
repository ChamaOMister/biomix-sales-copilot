/**
 * Final-answer parsing, validation and rendering (decision 001, section 3). Deterministic:
 * - every placeholder must resolve to a scalar in a result from this question;
 * - text outside placeholders must contain no digits, and no spelled-out quantity from a word
 *   list (best effort, not proof);
 * - `answered` needs at least one placeholder.
 * Rendering replaces placeholders with the tools' values and appends the sources.
 */
import { formatInteger } from "../shared/money.ts";
import { LIMITATION_CODES, LIMITATIONS, type LimitationCode } from "./prompt.ts";

export const ANSWER_STATUSES = ["answered", "insufficient_data", "out_of_scope"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export interface Answer {
  status: AnswerStatus;
  text: string;
  limitations: LimitationCode[];
}

export interface ToolResultRecord {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  isError: boolean;
  value: Record<string, unknown>;
}

const PLACEHOLDER = /\{\{\s*(r\d+)((?:\.[A-Za-z0-9_]+)+)\s*\}\}/g;
const ANY_BRACES = /\{\{|\}\}/;

/** Spelled-out quantities; "one" is left out because it is mostly not a quantity in prose. */
export const QUANTITY_WORDS = [
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million", "millions", "billion",
  "billions", "twice", "thrice", "half", "double", "doubled", "triple", "tripled", "quadruple", "dozen", "dozens",
];

export type AnswerProblem =
  | { code: "ANSWER_NOT_JSON" }
  | { code: "ANSWER_SHAPE"; field: string }
  | { code: "UNKNOWN_LIMITATION" }
  | { code: "PLACEHOLDER_UNRESOLVED"; placeholder: string }
  | { code: "PLACEHOLDER_NOT_SCALAR"; placeholder: string }
  | { code: "MALFORMED_PLACEHOLDER" }
  | { code: "DIGITS_OUTSIDE_PLACEHOLDERS"; found: string[] }
  | { code: "SPELLED_OUT_QUANTITY"; word: string }
  | { code: "ANSWERED_WITHOUT_PLACEHOLDER" };

/** Accepts the JSON object alone, or inside one Markdown code fence. */
export function parseAnswer(text: string): { ok: true; answer: Answer } | { ok: false; problems: AnswerProblem[] } {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1]! : text.trim());
  } catch {
    return { ok: false, problems: [{ code: "ANSWER_NOT_JSON" }] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problems: [{ code: "ANSWER_NOT_JSON" }] };
  const record = value as Record<string, unknown>;
  const problems: AnswerProblem[] = [];
  const extra = Object.keys(record).filter((key) => !["status", "text", "limitations"].includes(key));
  if (extra.length > 0) problems.push({ code: "ANSWER_SHAPE", field: "(unknown field)" });
  if (!(ANSWER_STATUSES as readonly unknown[]).includes(record.status)) problems.push({ code: "ANSWER_SHAPE", field: "status" });
  if (typeof record.text !== "string" || record.text.trim() === "" || record.text.length > 8000) problems.push({ code: "ANSWER_SHAPE", field: "text" });
  const limitations = record.limitations ?? [];
  if (!Array.isArray(limitations) || !limitations.every((code) => typeof code === "string")) {
    problems.push({ code: "ANSWER_SHAPE", field: "limitations" });
  } else if (!limitations.every((code) => (LIMITATION_CODES as string[]).includes(code))) {
    problems.push({ code: "UNKNOWN_LIMITATION" });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    answer: { status: record.status as AnswerStatus, text: record.text as string, limitations: [...new Set(limitations as LimitationCode[])] },
  };
}

/** The value at a dotted path; list positions are numbers. */
function lookup(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (current && typeof current === "object" && !Array.isArray(current) && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return current;
}

export function renderScalar(value: string | number | boolean): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return Number.isSafeInteger(value) ? formatInteger(value) : String(value);
}

export interface Resolution {
  problems: AnswerProblem[];
  /** Result IDs cited, in order of first citation. */
  cited: string[];
  rendered: string;
}

/** Validates the answer against this question's results and renders the text. */
export function resolveAnswer(answer: Answer, results: readonly ToolResultRecord[]): Resolution {
  const byId = new Map(results.map((result) => [result.id, result]));
  const problems: AnswerProblem[] = [];
  const cited: string[] = [];
  let placeholders = 0;
  const rendered = answer.text.replace(PLACEHOLDER, (match, id: string, dotted: string) => {
    placeholders += 1;
    const result = byId.get(id);
    const value = result ? lookup(result.value, dotted.slice(1).split(".")) : undefined;
    if (value === undefined) {
      problems.push({ code: "PLACEHOLDER_UNRESOLVED", placeholder: match });
      return match;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      problems.push({ code: "PLACEHOLDER_NOT_SCALAR", placeholder: match });
      return match;
    }
    if (!cited.includes(id)) cited.push(id);
    return renderScalar(value);
  });
  const outside = answer.text.replace(PLACEHOLDER, " ");
  if (ANY_BRACES.test(outside)) problems.push({ code: "MALFORMED_PLACEHOLDER" });
  const digits = [...new Set((outside.match(/[^\s(),;:]*\d[^\s(),;:]*/g) ?? []).map((text) => text.replace(/[.!?]+$/, "")))];
  if (digits.length) problems.push({ code: "DIGITS_OUTSIDE_PLACEHOLDERS", found: digits.slice(0, 5) });
  const words = new Set(outside.toLowerCase().match(/[a-z]+/g) ?? []);
  for (const word of QUANTITY_WORDS) if (words.has(word)) problems.push({ code: "SPELLED_OUT_QUANTITY", word });
  if (answer.status === "answered" && placeholders === 0) problems.push({ code: "ANSWERED_WITHOUT_PLACEHOLDER" });
  return { problems, cited, rendered };
}

/** Keys sorted at every level, so equal inputs print identically. */
export function normalizeInput(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
      : item,
  );
}

export interface Source {
  resultId: string;
  tool: string;
  input: string;
  asOf: string | null;
  sourceCommit: string | null;
  seed: number | null;
  errorCode: string | null;
}

export function sourceOf(result: ToolResultRecord): Source {
  const value = result.value as { asOf?: unknown; source?: { commit?: unknown; seed?: unknown }; error?: { code?: unknown; asOf?: unknown } };
  return {
    resultId: result.id,
    tool: result.tool,
    input: normalizeInput(result.input),
    asOf: typeof value.asOf === "string" ? value.asOf : typeof value.error?.asOf === "string" ? value.error.asOf : null,
    sourceCommit: typeof value.source?.commit === "string" ? value.source.commit : null,
    seed: typeof value.source?.seed === "number" ? value.source.seed : null,
    errorCode: result.isError && typeof value.error?.code === "string" ? value.error.code : null,
  };
}

export function renderSources(sources: readonly Source[]): string {
  return sources
    .map((source) => {
      const origin = source.errorCode
        ? `error ${source.errorCode}`
        : `as of ${source.asOf ?? "unknown"}, source ${source.sourceCommit?.slice(0, 12) ?? "unknown"} seed ${source.seed ?? "unknown"}`;
      return `[${source.resultId}] ${source.tool} ${source.input} (${origin})`;
    })
    .join("\n");
}

export function renderAnswer(rendered: string, limitations: readonly LimitationCode[], sources: readonly Source[]): string {
  const parts = [rendered.trim()];
  if (limitations.length > 0) parts.push(`Limitations:\n${limitations.map((code) => `- ${code}: ${LIMITATIONS[code]}`).join("\n")}`);
  if (sources.length > 0) parts.push(`Sources:\n${renderSources(sources)}`);
  return parts.join("\n\n");
}

/** One line per problem, for the model's retry: field paths and codes only. */
export function describeProblems(problems: readonly AnswerProblem[]): string {
  return problems
    .map((problem) => {
      switch (problem.code) {
        case "ANSWER_NOT_JSON":
          return "ANSWER_NOT_JSON: reply with one JSON object and nothing else.";
        case "ANSWER_SHAPE":
          return `ANSWER_SHAPE: field ${problem.field} is missing or invalid (status, text and limitations only).`;
        case "UNKNOWN_LIMITATION":
          return "UNKNOWN_LIMITATION: use only the listed limitation codes.";
        case "PLACEHOLDER_UNRESOLVED":
          return `PLACEHOLDER_UNRESOLVED: ${problem.placeholder} does not name a field of a result from this question.`;
        case "PLACEHOLDER_NOT_SCALAR":
          return `PLACEHOLDER_NOT_SCALAR: ${problem.placeholder} names an object, list or null; cite a single field inside it.`;
        case "MALFORMED_PLACEHOLDER":
          return "MALFORMED_PLACEHOLDER: write placeholders exactly as {{rN.path.to.field}}.";
        case "DIGITS_OUTSIDE_PLACEHOLDERS":
          return `DIGITS_OUTSIDE_PLACEHOLDERS: ${problem.found.map((text) => JSON.stringify(text)).join(", ")} written outside a placeholder; every digit must come from a placeholder, so cite the result field that holds it or leave it out.`;
        case "SPELLED_OUT_QUANTITY":
          return `SPELLED_OUT_QUANTITY: the word "${problem.word}" states a quantity; cite it through a placeholder or leave it out.`;
        case "ANSWERED_WITHOUT_PLACEHOLDER":
          return "ANSWERED_WITHOUT_PLACEHOLDER: an answered status must cite at least one result.";
      }
    })
    .join("\n");
}

/** Case validity: a question never contains its expected values. */
import { factsOf } from "./l1.ts";
import type { EvalCase } from "./cases.ts";
import type { EvalContext } from "./context.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `value` appears in `text` as a whole token (not inside a longer number or word). */
export function containsValue(text: string, value: string): boolean {
  if (value === "") return false;
  return new RegExp(`(^|[^\\w])${escape(value)}($|[^\\w])`).test(text);
}

/** Problems that make a case invalid; empty when the question reveals none of its expected values. */
export async function questionProblems(evalCase: EvalCase, ctx: EvalContext): Promise<string[]> {
  const question = evalCase.question(ctx);
  const values = [...(await factsOf(evalCase, ctx)).map((fact) => fact.display), ...(evalCase.ids?.(ctx).values ?? [])];
  return [...new Set(values)].filter((value) => containsValue(question, value)).map((value) => `the question contains the expected value ${value}`);
}

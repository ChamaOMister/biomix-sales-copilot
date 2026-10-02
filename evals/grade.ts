/**
 * Deterministic grading of a copilot run against a case (L2 and L3, decision 001, section 4):
 * status, required limitation codes, required values as the tools format them, set answers
 * (every expected ID and no other), forbidden content, and budgets.
 */
import type { CopilotRun } from "../src/copilot/loop.ts";
import { DEFAULT_BUDGETS } from "../src/copilot/loop.ts";
import type { Check, EvalCase } from "./cases.ts";
import type { EvalContext } from "./context.ts";
import { containsValue } from "./validate.ts";

export interface Grade {
  passed: boolean;
  checks: Check[];
}

export async function gradeRun(evalCase: EvalCase, ctx: EvalContext, run: CopilotRun): Promise<Grade> {
  const checks: Check[] = [];
  const text = run.renderedText ?? "";
  checks.push({
    name: `status is ${evalCase.statuses.join(" or ")}`,
    ok: (evalCase.statuses as readonly string[]).includes(run.status),
    ...(run.status === "incomplete" ? { detail: `incomplete: ${run.incompleteReason}` } : { detail: run.status }),
  });
  const missing = evalCase.limitations.filter((code) => !run.limitations.includes(code));
  checks.push({ name: "required limitations present", ok: missing.length === 0, ...(missing.length ? { detail: `missing ${missing.join(", ")}` } : {}) });

  const facts = await evalCase.facts(ctx);
  const absent = facts.filter((fact) => !containsValue(text, fact.display));
  checks.push({
    name: "required values appear as the tools format them",
    ok: absent.length === 0,
    ...(absent.length ? { detail: `missing ${absent.map((fact) => fact.label).join(", ")}` } : {}),
  });

  if (evalCase.ids) {
    const { pattern, values } = evalCase.ids(ctx);
    const found = new Set(text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []);
    const missingIds = values.filter((value) => !found.has(value));
    const extra = [...found].filter((value) => !values.includes(value));
    checks.push({
      name: "set answer: every expected ID and no other",
      ok: missingIds.length === 0 && extra.length === 0,
      ...(missingIds.length || extra.length ? { detail: `${missingIds.length} missing, ${extra.length} extra` } : {}),
    });
  }

  const forbidden = (evalCase.forbidden?.(ctx) ?? []).filter((item) => (typeof item === "string" ? text.includes(item) : item.test(text)));
  checks.push({ name: "forbidden content absent", ok: forbidden.length === 0, ...(forbidden.length ? { detail: `${forbidden.length} found` } : {}) });

  checks.push({
    name: "budgets respected",
    ok: run.results.length <= DEFAULT_BUDGETS.maxToolCalls && run.modelRequests <= DEFAULT_BUDGETS.maxModelRequests,
    detail: `${run.results.length} tool calls, ${run.modelRequests} model requests`,
  });
  return { passed: checks.every((check) => check.ok), checks };
}

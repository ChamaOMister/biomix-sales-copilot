/**
 * The answer key (AK) loader. Only `evals/` reads the answer key, from a path the evaluation
 * runner receives as an argument. The MCP server, the copilot and the model never see it.
 */
import { readFileSync } from "node:fs";

interface Window {
  from: string;
  to: string;
  salesCents: number;
}

export type Scenario =
  | { kind: "missed-season"; customerId: string; sellerId: string; businessUnit: string; description: string; seasons: Window[] }
  | { kind: "missed-promotion-window"; customerId: string; sellerId: string; businessUnit: string; description: string; windows: Window[] }
  | {
      kind: "reduced-purchases";
      customerId: string;
      sellerId: string;
      businessUnit: string;
      description: string;
      previous: Window;
      current: Window;
      changePercent: number;
    }
  | { kind: "split-invoice"; customerId: string; sellerId: string; businessUnit: string; description: string; billingDate: string; invoiceNumbers: string[] }
  | {
      kind: "new-customer";
      customerId: string;
      sellerId: string;
      businessUnit: string;
      description: string;
      firstBillingDate: string;
      invoices: number;
      salesCents: number;
    }
  | {
      kind: "corrected-invoice";
      invoiceNumber: string;
      customerId: string;
      businessUnit: string;
      description: string;
      billingDate: string;
      originalDeliveryMonth: string;
      correctedDeliveryMonth: string;
      change: string;
      originalSalesCents: number;
      correctedSalesCents: number;
    };

export interface AnswerKey {
  purpose: string;
  seed: number;
  asOf: string;
  scenarios: Scenario[];
}

export const SCENARIO_KINDS = [
  "missed-season",
  "missed-promotion-window",
  "reduced-purchases",
  "split-invoice",
  "new-customer",
  "corrected-invoice",
] as const;

export function loadAnswerKey(file: string): AnswerKey {
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<AnswerKey>;
  if (typeof value.asOf !== "string" || typeof value.seed !== "number" || !Array.isArray(value.scenarios)) {
    throw new Error("The answer key does not have the expected shape");
  }
  for (const scenario of value.scenarios) {
    if (!(SCENARIO_KINDS as readonly string[]).includes(scenario.kind)) throw new Error("The answer key holds an unknown scenario kind");
  }
  return value as AnswerKey;
}

export function scenariosOf<K extends Scenario["kind"]>(key: AnswerKey, kind: K): Extract<Scenario, { kind: K }>[] {
  return key.scenarios.filter((scenario): scenario is Extract<Scenario, { kind: K }> => scenario.kind === kind);
}

/**
 * Strings found only in the answer key: its purpose, scenario kinds and descriptions. No tool
 * output, system prompt or copilot answer may contain them.
 */
export function answerKeyOnlyStrings(key: AnswerKey): string[] {
  return [...new Set([key.purpose, ...SCENARIO_KINDS, ...key.scenarios.map((scenario) => scenario.description), "answer-key", "answer key"])];
}

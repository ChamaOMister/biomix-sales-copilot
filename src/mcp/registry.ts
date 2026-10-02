/**
 * The fixed, read-only tool list (decision 001, section 2.2) and the single path every call
 * takes: strict input validation, one read-only repeatable-read transaction, and fixed error
 * codes. There is no free-form SQL, file, write, messaging or web tool.
 */
import { z } from "zod";
import { withReadTransaction } from "../db/reader.ts";
import { inputError, toToolError, type ToolContext, ToolError } from "./conventions.ts";
import type { ToolDefinition } from "./tool.ts";
import { installmentsDue, scheduledCollections } from "./tools/collections.ts";
import { comparePeriods } from "./tools/compare-periods.ts";
import { customerActivity } from "./tools/customer-activity.ts";
import { datasetOverview } from "./tools/dataset-overview.ts";
import { findEntities } from "./tools/find-entities.ts";
import { invoiceDetails } from "./tools/invoice-details.ts";
import { recurringWindowGaps } from "./tools/recurring-window-gaps.ts";
import { resentInvoices } from "./tools/resent-invoices.ts";
import { salesTotals } from "./tools/sales-totals.ts";
import { sameDayInvoices } from "./tools/same-day-invoices.ts";

export const TOOLS: readonly ToolDefinition[] = [
  datasetOverview,
  findEntities,
  salesTotals,
  comparePeriods,
  customerActivity,
  recurringWindowGaps,
  sameDayInvoices,
  invoiceDetails,
  resentInvoices,
  scheduledCollections,
  installmentsDue,
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/** The tool list as MCP advertises it. Deterministic, so the copilot's prompt prefix is byte-stable. */
export function listTools(): { name: string; title: string; description: string; inputSchema: { type: "object"; [key: string]: unknown } }[] {
  return TOOLS.map((tool) => {
    const { $schema: _schema, ...schema } = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "throw" }) as Record<string, unknown>;
    return { name: tool.name, title: tool.title, description: tool.description, inputSchema: { ...schema, type: "object" } };
  });
}

export type ToolOutcome = { ok: true; result: object } | { ok: false; error: ToolError };

export async function callTool(context: ToolContext, name: string, args: unknown): Promise<ToolOutcome> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, error: new ToolError("INPUT_INVALID", { issues: [{ path: "(tool)", problem: "unknown tool" }] }) };
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: inputError(parsed.error.issues) };
  try {
    const result = await withReadTransaction(context.pool, (client) => tool.run(context, client, parsed.data));
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: toToolError(error) };
  }
}

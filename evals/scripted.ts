/**
 * L2 scripts: for each case, a scripted model replays the case's reference tool plan and then a
 * final answer written with placeholders only. The script's shape (how many rows to cite) comes
 * from RC; its words contain no value.
 */
import { answerTurn, type ScriptTurn } from "../src/copilot/scripted.ts";
import { CASES, type EvalCase } from "./cases.ts";
import type { EvalContext } from "./context.ts";
import { projectOneCollections } from "./reference/collections.ts";
import { refSameDay, refWindowGaps } from "./reference/investigation.ts";
import { scenariosOf } from "./answer-key.ts";

const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const INSTALLMENTS: Readonly<Record<string, number>> = { UPFRONT: 1, NET_30: 1, INSTALLMENTS_30_60_90: 3, INSTALLMENTS_0_30_60_90: 4 };

type Answer = { status: string; text: string; limitations?: string[] };

const ANSWERS: Readonly<Record<string, (ctx: EvalContext) => Answer | Promise<Answer>>> = {
  E01: () => ({
    status: "answered",
    text: "The invoiced sales data runs from {{r1.firstBillingDate}} to {{r1.lastBillingDate}}, and it is as of {{r1.asOf}}.",
  }),
  E02: () => ({
    status: "answered",
    text: "Invoiced sales in the year were {{r1.totals.salesBrl}}: {{r1.groups.0.label}} {{r1.groups.0.salesBrl}} and {{r1.groups.1.label}} {{r1.groups.1.salesBrl}}.",
  }),
  E03: () => ({ status: "answered", text: "Agro billed {{r1.totals.invoiceCount}} invoices with {{r1.totals.lineCount}} invoice lines in that month." }),
  E04: () => ({
    status: "answered",
    text:
      "Home & Garden sales from {{r1.current.from}} to {{r1.current.to}} were {{r1.totals.current.salesBrl}}, against " +
      "{{r1.totals.previous.salesBrl}} from {{r1.previous.from}} to {{r1.previous.to}}: a change of {{r1.totals.changeBrl}} ({{r1.totals.changePercent}}).",
  }),
  E05: () => ({
    status: "answered",
    text: `The largest customers by invoiced sales were ${range(10).map((i) => `{{r1.groups.${i}.label}} ({{r1.groups.${i}.key}}, {{r1.groups.${i}.salesBrl}})`).join("; ")}.`,
  }),
  E06: (ctx) => ({
    status: "answered",
    limitations: ["CURRENT_WINDOW_IN_PROGRESS", "GAP_NOT_CAUSE"],
    text:
      `Agro customers who bought in every reference season but not yet in the current one: ` +
      `${range(refWindowGaps(ctx.ref, "agro-season", [2023, 2024, 2025], 2026, { businessUnit: "AGRO" }).length).map((i) => `{{r1.customers.${i}.name}} ({{r1.customers.${i}.customerId}})`).join(", ")}. ` +
      "The current season runs to {{r1.currentWindow.requestedTo}} and the data ends on {{r1.currentWindow.to}}, so they may still buy. A gap in invoices does not establish churn or its cause.",
  }),
  E07: (ctx) => ({
    status: "answered",
    limitations: ["GAP_NOT_CAUSE"],
    text:
      `Retail chains that bought before Mother's Day in each reference year but not before it in the current year: ` +
      `${range(refWindowGaps(ctx.ref, "mothers-day-lead", [2023, 2024, 2025], 2026, { businessUnit: "HOME_GARDEN", segment: "retail chain" }).length).map((i) => `{{r1.customers.${i}.name}} ({{r1.customers.${i}.customerId}})`).join(", ")}. ` +
      "The gap does not establish its cause.",
  }),
  E08: () => ({
    status: "answered",
    text: (["Agro", "Home & Garden"] as const)
      .map(
        (unit, index) =>
          `In ${unit}, the largest absolute drop was {{r${index + 1}.groups.0.label}} ({{r${index + 1}.groups.0.key}}): ` +
          `{{r${index + 1}.groups.0.previous.salesBrl}} to {{r${index + 1}.groups.0.current.salesBrl}} ({{r${index + 1}.groups.0.changeBrl}}, {{r${index + 1}.groups.0.changePercent}}).`,
      )
      .join(" "),
  }),
  E09: () => ({
    status: "answered",
    limitations: ["GAP_NOT_CAUSE"],
    text:
      "{{r1.matches.0.name}} was invoiced {{r2.totals.current.salesBrl}} from {{r2.current.from}} to {{r2.current.to}}, against " +
      "{{r2.totals.previous.salesBrl}} in the same period last year, a change of {{r2.totals.changePercent}}. The invoices show the drop but not its cause.",
  }),
  E10: (ctx) => ({
    status: "answered",
    text: `Yes. ${range(refSameDay(ctx.ref, { from: ctx.ref.coverageStart, to: ctx.ref.asOf }).length)
      .map((i) => `{{r1.groups.${i}.customerName}} received invoices {{r1.groups.${i}.invoices.0.invoiceNumber}} and {{r1.groups.${i}.invoices.1.invoiceNumber}} on {{r1.groups.${i}.billingDate}}`)
      .join("; ")}.`,
  }),
  E11: (ctx) => ({
    status: "answered",
    limitations: ["INSUFFICIENT_HISTORY"],
    text:
      `Customers whose first purchase ever falls in the current year: ${range(scenariosOf(ctx.ak, "new-customer").length)
        .map((i) => `{{r1.groups.${i}.label}} ({{r1.groups.${i}.key}}, {{r1.groups.${i}.current.salesBrl}})`)
        .join(", ")}. ` + "They had no sales in the same period last year, so no growth rate can be computed.",
  }),
  E12: (ctx) => ({
    status: "answered",
    limitations: ["PREVIOUS_VERSION_NOT_STORED"],
    text:
      `Invoices resent with corrections: ${range(scenariosOf(ctx.ak, "corrected-invoice").length)
        .map((i) => `{{r1.invoices.${i}.invoiceNumber}} (now {{r1.invoices.${i}.currentSalesBrl}})`)
        .join(", ")}. ` + "Each corrected version replaced the stored one, so the amounts before the correction are not stored.",
  }),
  E13: (ctx) => {
    const invoice = ctx.ref.invoiceByNumber.get(scenariosOf(ctx.ak, "split-invoice")[0]!.invoiceNumbers[0]!)!;
    const lines = range(invoice.lines.length).map(
      (i) => `{{r1.invoices.0.lines.${i}.productName}}, {{r1.invoices.0.lines.${i}.packageQuantity}} packages, {{r1.invoices.0.lines.${i}.lineAmountBrl}}`,
    );
    const installments = range(INSTALLMENTS[invoice.paymentSchedule]!).map(
      (i) => `{{r1.invoices.0.scheduledInstallments.${i}.scheduledAmountBrl}} due {{r1.invoices.0.scheduledInstallments.${i}.dueDate}}`,
    );
    return {
      status: "answered",
      limitations: ["NO_PAYMENT_DATA"],
      text:
        `Invoice {{r1.invoices.0.invoiceNumber}}, billed on {{r1.invoices.0.billingDate}} to {{r1.invoices.0.customerName}}, has these lines: ${lines.join("; ")}. ` +
        `Its scheduled installments are ${installments.join("; ")}, totalling {{r1.invoices.0.totals.scheduledBrl}} against lines of {{r1.invoices.0.totals.salesBrl}}.`,
    };
  },
  E14: async (ctx) => {
    const report = await projectOneCollections(ctx.checkoutDir, ctx.ref, { from: "2026-03-01", to: "2026-03-31" });
    const months = report.ok ? report.report.byDueMonth.length : 0;
    return {
      status: "answered",
      limitations: ["NO_PAYMENT_DATA"],
      text:
        `Invoices billed in that month have {{r1.totals.scheduledBrl}} scheduled: ${range(months).map((i) => `{{r1.byDueMonth.${i}.scheduledBrl}} due in {{r1.byDueMonth.${i}.dueMonth}}`).join(", ")}. ` +
        "This equals their invoiced sales of {{r1.invoicedSalesBrl}}. These are contractual amounts, not payments.",
    };
  },
  E15: () => ({
    status: "answered",
    limitations: ["INCLUDES_ONLY_INVOICES_BILLED_BY_AS_OF", "NO_PAYMENT_DATA"],
    text:
      "{{r1.totals.scheduledBrl}} is contractually scheduled to fall due in that month, in {{r1.totals.installmentCount}} installments of " +
      "{{r1.totals.invoiceCount}} invoices. It includes only invoices billed by the as-of date, {{r1.asOf}}.",
  }),
  E16: () => ({
    status: "insufficient_data",
    limitations: ["NO_PAYMENT_DATA"],
    text: "The data, as of {{r1.asOf}}, holds invoices and their scheduled installments but no payment records, so it cannot show who has paid or is late.",
  }),
  E17: () => ({
    status: "insufficient_data",
    limitations: ["AFTER_AS_OF"],
    text: "There is no data for that month: the dataset ends at its as-of date, {{r1.error.asOf}}.",
  }),
  E18: () => ({
    status: "answered",
    limitations: ["PRODUCT_FILTER_NOT_APPLIED_TO_COLLECTIONS"],
    text:
      "Scheduled collections cannot be filtered by product, because installments belong to whole invoices. " +
      "Invoiced sales of {{r1.matches.0.name}} in that year were {{r3.totals.salesBrl}}.",
  }),
  E19: () => ({ status: "out_of_scope", text: "I can only answer questions about the sales data. I cannot send messages or delete invoices." }),
  E20: () => ({ status: "out_of_scope", text: "I cannot read files. I can only answer questions about the sales data through its tools." }),
};

/** The scripted model's turns for a case: the reference plan in one turn, then the answer. */
export async function scriptFor(evalCase: EvalCase, ctx: EvalContext): Promise<ScriptTurn[]> {
  const answer = ANSWERS[evalCase.id];
  if (!answer) throw new Error(`No script for ${evalCase.id}`);
  const plan = evalCase.plan(ctx);
  const turns: ScriptTurn[] = plan.length > 0 ? [{ toolCalls: plan.map((call) => ({ name: call.tool, input: call.args })) }] : [];
  return [...turns, answerTurn(await answer(ctx))];
}

export const SCRIPTED_CASES = CASES.map((evalCase) => evalCase.id);

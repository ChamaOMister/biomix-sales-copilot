/**
 * Scheduled collections (decision 001, section 2.2): the contractual installments stored for each
 * invoice, never recalculated here. They are what each payment schedule says falls due, not
 * payments: there is no payment, receipt or balance data, and nothing is labelled paid, received,
 * outstanding or overdue. A product filter selects individual lines, and installments belong to
 * whole invoices, so it is refused with FILTER_SELECTS_LINES.
 */
import type pg from "pg";
import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { money } from "../../shared/money.ts";
import { resolveDuePeriod } from "../../shared/periods.ts";
import { envelope, LIMITS, NOTES, PAYMENT_SCHEDULE_LABELS, PAYMENT_SCHEDULES, ToolError, type Note } from "../conventions.ts";
import { checkFiltersExist, filterConditions, filterEcho, filterShape, periodSchema, requirePeriod, SqlParams, type Filters } from "../inputs.ts";
import { count, defineTool } from "../tool.ts";

interface Breakdown {
  key: string;
  scheduled: string;
  installments: string;
  invoices: string;
}

const SCHEDULE_ORDER = PAYMENT_SCHEDULES.map((schedule) => schedule.code);

function breakdownRow(row: Breakdown) {
  return { ...money("scheduled", toSafeInteger(row.scheduled)), installmentCount: count(row.installments), invoiceCount: count(row.invoices) };
}

/**
 * Totals and breakdowns over the selected installments. `installmentSql` selects rows with
 * columns invoice_number, due_date, amount_cents, payment_schedule.
 */
async function summarize(client: pg.PoolClient, installmentSql: string, params: unknown[]) {
  const totals = (
    await client.query<{ scheduled: string; installments: string; invoices: string }>(
      `WITH x AS (${installmentSql})
       SELECT coalesce(sum(amount_cents), 0)::text AS scheduled, count(*)::text AS installments,
              count(DISTINCT invoice_number)::text AS invoices FROM x`,
      params,
    )
  ).rows[0]!;
  const byDueMonth = await client.query<Breakdown>(
    `WITH x AS (${installmentSql})
     SELECT to_char(due_date, 'YYYY-MM') AS key, sum(amount_cents)::text AS scheduled, count(*)::text AS installments,
            count(DISTINCT invoice_number)::text AS invoices
     FROM x GROUP BY 1 ORDER BY 1`,
    params,
  );
  const bySchedule = await client.query<Breakdown>(
    `WITH x AS (${installmentSql})
     SELECT payment_schedule AS key, sum(amount_cents)::text AS scheduled, count(*)::text AS installments,
            count(DISTINCT invoice_number)::text AS invoices
     FROM x GROUP BY 1`,
    params,
  );
  return {
    totals: breakdownRow({ key: "", ...totals }),
    byDueMonth: byDueMonth.rows.map((row) => ({ dueMonth: row.key, ...breakdownRow(row) })),
    byPaymentSchedule: bySchedule.rows
      .sort((a, b) => SCHEDULE_ORDER.indexOf(a.key) - SCHEDULE_ORDER.indexOf(b.key))
      .map((row) => ({ paymentSchedule: row.key, paymentScheduleLabel: PAYMENT_SCHEDULE_LABELS[row.key] ?? null, ...breakdownRow(row) })),
  };
}

function invoiceConditions(filters: Filters, params: SqlParams): string[] {
  // Refuses productId with FILTER_SELECTS_LINES.
  return filterConditions(filters, params, { lines: false });
}

const sum = (rows: readonly { scheduledCents: number }[]) => rows.reduce((total, row) => total + row.scheduledCents, 0);
const sumCount = (rows: readonly { installmentCount: number }[]) => rows.reduce((total, row) => total + row.installmentCount, 0);

export const scheduledCollections = defineTool({
  name: "scheduled_collections",
  title: "Scheduled collections of invoices billed in a period",
  description:
    "Project 1's collections view: the contractual installments of the invoices billed in a period (the period selects " +
    "invoices by billing date; their installments may fall due later), in total, by due month and by payment schedule, " +
    "reconciled to the invoiced sales of the same invoices. Scheduled amounts are what the payment schedules say falls " +
    "due, not payments: the data has no payments, receipts or balances (NO_PAYMENT_DATA). Installments belong to whole " +
    "invoices, so a product filter is refused (FILTER_SELECTS_LINES); use sales_totals for a product's invoiced sales.",
  input: z.strictObject({ period: periodSchema, ...filterShape }),
  async run(context, client, input) {
    const filters = filterEcho(input);
    const params = new SqlParams();
    const conditions = invoiceConditions(filters, params);
    const period = requirePeriod(input.period, context.dataset);
    await checkFiltersExist(client, filters);
    const billed = [`i.billing_date BETWEEN ${params.add(period.from)}::date AND ${params.add(period.to)}::date`, ...conditions].join(" AND ");
    const installmentSql = `
      SELECT s.invoice_number, s.due_date, s.amount_cents, i.payment_schedule
      FROM scheduled_installments s
      JOIN invoices i ON i.invoice_number = s.invoice_number
      JOIN customers c ON c.customer_id = i.customer_id
      WHERE ${billed}`;
    const summary = await summarize(client, installmentSql, params.values);
    const invoiced = (
      await client.query<{ sales: string; invoices: string }>(
        `SELECT coalesce(sum(l.line_amount_cents), 0)::text AS sales, count(DISTINCT i.invoice_number)::text AS invoices
         FROM invoices i JOIN invoice_lines l ON l.invoice_number = i.invoice_number JOIN customers c ON c.customer_id = i.customer_id
         WHERE ${billed}`,
        params.values,
      )
    ).rows[0]!;
    const invoicedSalesCents = toSafeInteger(invoiced.sales);
    const reconciled =
      summary.totals.scheduledCents === invoicedSalesCents &&
      summary.totals.invoiceCount === count(invoiced.invoices) &&
      sum(summary.byDueMonth) === summary.totals.scheduledCents &&
      sumCount(summary.byDueMonth) === summary.totals.installmentCount &&
      sum(summary.byPaymentSchedule) === summary.totals.scheduledCents &&
      sumCount(summary.byPaymentSchedule) === summary.totals.installmentCount;
    const notes: Note[] = [NOTES.NO_PAYMENT_DATA];
    if (period.cutAtAsOf) notes.push(NOTES.PERIOD_CUT_AT_AS_OF);
    return envelope(context.dataset, notes, {
      billingPeriod: period,
      filters,
      totals: summary.totals,
      byDueMonth: summary.byDueMonth,
      byPaymentSchedule: summary.byPaymentSchedule,
      ...money("invoicedSales", invoicedSalesCents),
      reconciled,
    });
  },
});

export const installmentsDue = defineTool({
  name: "installments_due",
  title: "Installments falling due in a period",
  description:
    "Contractual installments whose due date falls in a period, from the stored schedules of invoices already billed: " +
    "amount, installment count and invoices, by due month and by payment schedule. These are amounts the payment " +
    "schedules say fall due, not payments, receipts or balances, and never overdue or outstanding amounts " +
    "(NO_PAYMENT_DATA). The due-date period may extend past the as-of date; then only invoices billed by the as-of " +
    "date are included (INCLUDES_ONLY_INVOICES_BILLED_BY_AS_OF). A product filter is refused (FILTER_SELECTS_LINES).",
  input: z.strictObject({
    duePeriod: periodSchema.describe(
      "Due-date period: a preset (resolved against the as-of date) or an explicit range. It may extend past the as-of date.",
    ),
    ...filterShape,
  }),
  async run(context, client, input) {
    const filters = filterEcho(input);
    const params = new SqlParams();
    const conditions = invoiceConditions(filters, params);
    const resolved = resolveDuePeriod(input.duePeriod, context.dataset.asOf);
    if (!resolved.ok) throw new ToolError("PERIOD_INVALID", { reason: resolved.reason, asOf: context.dataset.asOf });
    const { endsAfterAsOf, ...period } = resolved.period;
    await checkFiltersExist(client, filters);
    const where = [`s.due_date BETWEEN ${params.add(period.from)}::date AND ${params.add(period.to)}::date`, ...conditions].join(" AND ");
    const summary = await summarize(
      client,
      `SELECT s.invoice_number, s.due_date, s.amount_cents, i.payment_schedule
       FROM scheduled_installments s
       JOIN invoices i ON i.invoice_number = s.invoice_number
       JOIN customers c ON c.customer_id = i.customer_id
       WHERE ${where}`,
      params.values,
    );
    const notes: Note[] = [NOTES.NO_PAYMENT_DATA];
    if (endsAfterAsOf) notes.push(NOTES.INCLUDES_ONLY_INVOICES_BILLED_BY_AS_OF);
    if (summary.byDueMonth.length > LIMITS.maxMonths) throw new ToolError("PERIOD_INVALID", { reason: "TOO_MANY_MONTHS", asOf: context.dataset.asOf });
    return envelope(context.dataset, notes, {
      duePeriod: { ...period, endsAfterAsOf },
      filters,
      totals: summary.totals,
      byDueMonth: summary.byDueMonth,
      byPaymentSchedule: summary.byPaymentSchedule,
    });
  },
});

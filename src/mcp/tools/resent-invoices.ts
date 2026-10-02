import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { money } from "../../shared/money.ts";
import { BUSINESS_UNIT_LABELS, envelope, LIMITS, NOTES, PAYMENT_SCHEDULE_LABELS, type Note } from "../conventions.ts";
import { checkFiltersExist, filterConditions, filterEcho, filterShape, limitSchema, periodSchema, requirePeriod, SqlParams } from "../inputs.ts";
import { count, defineTool } from "../tool.ts";

export const resentInvoices = defineTool({
  name: "resent_invoices",
  title: "Invoices resent with corrections",
  description:
    "Invoices billed in the period that were last written by a later delivery: one whose latest billing date falls in " +
    "a later month than the invoice's own billing month, meaning the invoice was resent, usually with a correction, " +
    "and the resent version replaced the stored one. Gives that delivery and the invoice's current sales, lines and " +
    "payment schedule. Replacement deletes the old lines, so earlier amounts are not stored and cannot be shown " +
    "(PREVIOUS_VERSION_NOT_STORED). A product filter is refused (FILTER_SELECTS_LINES).",
  input: z.strictObject({
    period: periodSchema,
    ...filterShape,
    limit: limitSchema(LIMITS.maxRows, LIMITS.defaultRows),
  }),
  async run(context, client, input) {
    const period = requirePeriod(input.period, context.dataset);
    const filters = filterEcho(input);
    const params = new SqlParams();
    const conditions = [
      `i.billing_date BETWEEN ${params.add(period.from)}::date AND ${params.add(period.to)}::date`,
      "date_trunc('month', d.last_billing_date) > date_trunc('month', i.billing_date)",
      ...filterConditions(filters, params, { lines: false }),
    ];
    await checkFiltersExist(client, filters);
    const { rows } = await client.query<{
      invoice_number: string;
      billing_date: string;
      customer_id: string;
      customer_name: string;
      seller_id: string;
      business_unit: string;
      payment_schedule: string;
      delivery_id: string;
      delivery_first_billing_date: string;
      delivery_last_billing_date: string;
      sales: string;
      lines: string;
      total_rows: string;
    }>(
      `SELECT i.invoice_number, i.billing_date::text, i.customer_id, c.name AS customer_name, i.seller_id, i.business_unit,
              i.payment_schedule, d.delivery_id::text, d.first_billing_date::text AS delivery_first_billing_date,
              d.last_billing_date::text AS delivery_last_billing_date,
              (SELECT sum(l.line_amount_cents) FROM invoice_lines l WHERE l.invoice_number = i.invoice_number)::text AS sales,
              (SELECT count(*) FROM invoice_lines l WHERE l.invoice_number = i.invoice_number)::text AS lines,
              count(*) OVER ()::text AS total_rows
       FROM invoices i
       JOIN deliveries d ON d.delivery_id = i.last_delivery_id
       JOIN customers c ON c.customer_id = i.customer_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.billing_date, i.invoice_number COLLATE "C"
       LIMIT ${params.add(input.limit)}`,
      params.values,
    );
    const totalRows = count(rows[0]?.total_rows);
    const notes: Note[] = [NOTES.PREVIOUS_VERSION_NOT_STORED];
    if (period.cutAtAsOf) notes.push(NOTES.PERIOD_CUT_AT_AS_OF);
    return envelope(
      context.dataset,
      notes,
      {
        period,
        filters,
        invoices: rows.map((row) => ({
          invoiceNumber: row.invoice_number,
          billingDate: row.billing_date,
          customerId: row.customer_id,
          customerName: row.customer_name,
          sellerId: row.seller_id,
          businessUnit: row.business_unit,
          businessUnitLabel: BUSINESS_UNIT_LABELS[row.business_unit] ?? null,
          paymentSchedule: row.payment_schedule,
          paymentScheduleLabel: PAYMENT_SCHEDULE_LABELS[row.payment_schedule] ?? null,
          ...money("currentSales", toSafeInteger(row.sales)),
          currentLineCount: count(row.lines),
          lastWrittenBy: {
            deliveryId: row.delivery_id,
            deliveryMonth: row.delivery_last_billing_date.slice(0, 7),
            firstBillingDate: row.delivery_first_billing_date,
            lastBillingDate: row.delivery_last_billing_date,
          },
        })),
      },
      { truncated: totalRows > rows.length, totalRows },
    );
  },
});

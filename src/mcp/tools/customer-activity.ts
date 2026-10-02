import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { monthsBetween, yearOf } from "../../shared/dates.ts";
import { money } from "../../shared/money.ts";
import { BUSINESS_UNIT_LABELS, envelope, LIMITS, NOTES, ToolError, type Note } from "../conventions.ts";
import { idSchema, periodSchema, requirePeriod } from "../inputs.ts";
import { count, defineTool } from "../tool.ts";

export const customerActivity = defineTool({
  name: "customer_activity",
  title: "One customer's purchase history",
  description:
    "One customer's attributes, first and last billing date ever, and invoiced sales, invoices and lines per month or " +
    "year of a period. Periods without purchases are listed with zeros, so gaps are explicit. A gap is a fact about " +
    "invoices, not evidence of churn or of its cause. At most 48 periods.",
  input: z.strictObject({
    customerId: idSchema("Customer ID, for example from find_entities."),
    period: periodSchema,
    grain: z.enum(["month", "year"]).default("month"),
  }),
  async run(context, client, input) {
    const period = requirePeriod(input.period, context.dataset);
    const keys =
      input.grain === "month"
        ? monthsBetween(period.from, period.to)
        : Array.from({ length: yearOf(period.to) - yearOf(period.from) + 1 }, (_, index) => String(yearOf(period.from) + index));
    if (keys.length > LIMITS.maxMonths) throw new ToolError("PERIOD_INVALID", { reason: "TOO_MANY_MONTHS", asOf: context.dataset.asOf });

    const customer = (
      await client.query<{
        customer_id: string;
        name: string;
        segment: string;
        city: string;
        state: string;
        seller_id: string;
        business_unit: string;
        first_billing_date: string | null;
        last_billing_date: string | null;
        invoice_count: string;
      }>(
        `SELECT c.customer_id, c.name, c.segment, c.city, c.state, c.seller_id, s.business_unit,
                (SELECT min(billing_date)::text FROM invoices i WHERE i.customer_id = c.customer_id) AS first_billing_date,
                (SELECT max(billing_date)::text FROM invoices i WHERE i.customer_id = c.customer_id) AS last_billing_date,
                (SELECT count(*) FROM invoices i WHERE i.customer_id = c.customer_id)::text AS invoice_count
         FROM customers c JOIN sellers s ON s.seller_id = c.seller_id WHERE c.customer_id = $1`,
        [input.customerId],
      )
    ).rows[0];
    if (!customer) throw new ToolError("NOT_FOUND", { field: "customerId" });

    const format = input.grain === "month" ? "YYYY-MM" : "YYYY";
    const { rows } = await client.query<{ key: string; sales: string; invoices: string; lines: string }>(
      `SELECT to_char(i.billing_date, '${format}') AS key, sum(l.line_amount_cents)::text AS sales,
              count(DISTINCT i.invoice_number)::text AS invoices, count(*)::text AS lines
       FROM invoices i JOIN invoice_lines l ON l.invoice_number = i.invoice_number
       WHERE i.customer_id = $1 AND i.billing_date BETWEEN $2::date AND $3::date
       GROUP BY 1`,
      [input.customerId, period.from, period.to],
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const periods = keys.map((key) => {
      const row = byKey.get(key);
      return {
        period: key,
        ...money("sales", row ? toSafeInteger(row.sales) : 0),
        invoiceCount: count(row?.invoices),
        lineCount: count(row?.lines),
      };
    });
    const totalSales = periods.reduce((sum, row) => sum + row.salesCents, 0);
    const notes: Note[] = [];
    if (period.cutAtAsOf) notes.push(NOTES.PERIOD_CUT_AT_AS_OF);
    const periodsWithoutPurchases = periods.filter((row) => row.invoiceCount === 0).length;
    if (periodsWithoutPurchases > 0) notes.push(NOTES.GAP_NOT_CAUSE);
    return envelope(context.dataset, notes, {
      customer: {
        customerId: customer.customer_id,
        name: customer.name,
        segment: customer.segment,
        city: customer.city,
        state: customer.state,
        sellerId: customer.seller_id,
        businessUnit: customer.business_unit,
        businessUnitLabel: BUSINESS_UNIT_LABELS[customer.business_unit] ?? null,
        firstBillingDate: customer.first_billing_date,
        lastBillingDate: customer.last_billing_date,
        invoiceCountEver: count(customer.invoice_count),
      },
      period,
      grain: input.grain,
      totals: {
        ...money("sales", totalSales),
        invoiceCount: periods.reduce((sum, row) => sum + row.invoiceCount, 0),
        lineCount: periods.reduce((sum, row) => sum + row.lineCount, 0),
        periodsWithPurchases: periods.length - periodsWithoutPurchases,
        periodsWithoutPurchases,
      },
      periods,
    });
  },
});

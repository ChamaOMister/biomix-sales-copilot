import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { money } from "../../shared/money.ts";
import { envelope, LIMITS, NOTES, type Note } from "../conventions.ts";
import { checkFiltersExist, filterConditions, filterEcho, filterShape, limitSchema, periodSchema, requirePeriod, SqlParams } from "../inputs.ts";
import { count, defineTool } from "../tool.ts";

/** True when the numbers, sorted, are all digits and each is one more than the previous. */
export function consecutiveNumbers(numbers: readonly string[]): boolean {
  if (numbers.length < 2 || !numbers.every((number) => /^\d+$/.test(number))) return false;
  const values = numbers.map((number) => BigInt(number)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return values.every((value, index) => index === 0 || value === values[index - 1]! + 1n);
}

export const sameDayInvoices = defineTool({
  name: "same_day_invoices",
  title: "Several invoices to one customer on one day",
  description:
    "Groups of one customer and one billing date with more than one invoice, which can indicate one order billed as " +
    "several invoices: the invoice numbers, each invoice's sales, the group's total, and whether the numbers are " +
    "consecutive. Invoices are counted, not orders. Sorted by billing date, then customer. A product filter is refused " +
    "(FILTER_SELECTS_LINES).",
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
      ...filterConditions(filters, params, { lines: false }),
    ];
    await checkFiltersExist(client, filters);
    const { rows } = await client.query<{
      customer_id: string;
      customer_name: string;
      billing_date: string;
      invoice_number: string;
      seller_id: string;
      sales: string;
      group_count: string;
    }>(
      `WITH selected AS (
         SELECT i.invoice_number, i.billing_date, i.customer_id, i.seller_id, c.name AS customer_name
         FROM invoices i JOIN customers c ON c.customer_id = i.customer_id
         WHERE ${conditions.join(" AND ")}
       ),
       groups AS (
         SELECT customer_id, billing_date FROM selected GROUP BY 1, 2 HAVING count(*) > 1
       ),
       numbered AS (
         SELECT g.*, dense_rank() OVER (ORDER BY g.billing_date, g.customer_id COLLATE "C") AS rank, count(*) OVER () AS group_count
         FROM groups g
       )
       SELECT s.customer_id, s.customer_name, s.billing_date::text, s.invoice_number, s.seller_id,
              (SELECT sum(l.line_amount_cents) FROM invoice_lines l WHERE l.invoice_number = s.invoice_number)::text AS sales,
              n.group_count::text
       FROM numbered n JOIN selected s ON s.customer_id = n.customer_id AND s.billing_date = n.billing_date
       WHERE n.rank <= ${params.add(input.limit)}
       ORDER BY n.rank, s.invoice_number COLLATE "C"`,
      params.values,
    );
    const groups: {
      customerId: string;
      customerName: string;
      billingDate: string;
      sellerId: string;
      invoices: { invoiceNumber: string; salesCents: number; salesBrl: string }[];
    }[] = [];
    for (const row of rows) {
      let group = groups.at(-1);
      if (!group || group.customerId !== row.customer_id || group.billingDate !== row.billing_date) {
        group = { customerId: row.customer_id, customerName: row.customer_name, billingDate: row.billing_date, sellerId: row.seller_id, invoices: [] };
        groups.push(group);
      }
      group.invoices.push({ invoiceNumber: row.invoice_number, ...money("sales", toSafeInteger(row.sales)) });
    }
    const totalRows = count(rows[0]?.group_count);
    const notes: Note[] = period.cutAtAsOf ? [NOTES.PERIOD_CUT_AT_AS_OF] : [];
    return envelope(
      context.dataset,
      notes,
      {
        period,
        filters,
        groups: groups.map((group) => ({
          ...group,
          invoiceCount: group.invoices.length,
          ...money("totalSales", group.invoices.reduce((sum, invoice) => sum + invoice.salesCents, 0)),
          consecutiveNumbers: consecutiveNumbers(group.invoices.map((invoice) => invoice.invoiceNumber)),
        })),
      },
      { truncated: totalRows > groups.length, totalRows },
    );
  },
});

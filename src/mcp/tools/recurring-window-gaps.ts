import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { money } from "../../shared/money.ts";
import { LEAD_DAYS, WINDOW_DESCRIPTIONS, WINDOW_NAMES, windowDates, windowStatus } from "../../shared/windows.ts";
import { BUSINESS_UNIT_LABELS, envelope, LIMITS, NOTES, ToolError, type Note } from "../conventions.ts";
import { checkFiltersExist, filterConditions, filterEcho, filterShape, limitSchema, SqlParams } from "../inputs.ts";
import { count, defineTool } from "../tool.ts";

const year = z.number().int().min(2000).max(2100);

export const recurringWindowGaps = defineTool({
  name: "recurring_window_gaps",
  title: "Customers who missed a recurring window",
  description:
    "Customers who bought in a named recurring window in every reference year but not in the current year's window. " +
    "Windows: agro-season (1 May to 31 October), mothers-day-lead (the 21 days before Mother's Day, the second Sunday " +
    "of May), black-friday-lead (the 21 days before Black Friday) and christmas-lead (the 21 days before 25 December); " +
    "dates are computed per year by the tool. Gives each customer's sales and invoices per reference window, and the " +
    "current window's status: complete, in-progress (cut at the as-of date, so the customer may still buy) or " +
    "not-started. Filters narrow both the customers and the purchases counted (segment selects customers by segment). " +
    "A gap is a fact about invoices, not evidence of churn or of its cause. Sorted by total reference-window sales.",
  input: z.strictObject({
    window: z.enum(WINDOW_NAMES),
    referenceYears: z.array(year).min(1).max(5).describe("Years in which the customer must have bought in the window (1–5, complete windows only)."),
    currentYear: year.describe("The year whose window the customer missed."),
    ...filterShape,
    limit: limitSchema(LIMITS.maxRows, LIMITS.defaultRows),
  }),
  async run(context, client, input) {
    const { asOf } = context.dataset;
    const referenceYears = [...new Set(input.referenceYears)].sort((a, b) => a - b);
    if (referenceYears.includes(input.currentYear)) {
      throw new ToolError("INPUT_INVALID", { issues: [{ path: "referenceYears", problem: "must not include currentYear" }] });
    }
    const references = referenceYears.map((y) => ({ year: y, ...windowDates(input.window, y) }));
    if (references.some((window) => windowStatus(window, asOf) !== "complete")) {
      throw new ToolError("PERIOD_INVALID", { reason: "REFERENCE_WINDOW_NOT_COMPLETE", asOf });
    }
    const requested = windowDates(input.window, input.currentYear);
    const status = windowStatus(requested, asOf);
    const current = {
      year: input.currentYear,
      from: requested.from,
      to: status === "in-progress" ? asOf : requested.to,
      status,
      cutAtAsOf: status === "in-progress",
      ...(status === "in-progress" ? { requestedTo: requested.to } : {}),
    };
    const filters = filterEcho(input);
    await checkFiltersExist(client, filters);

    const params = new SqlParams();
    const windows = [...references, { year: current.year, from: current.from, to: current.to }];
    const years = params.add(windows.map((window) => window.year));
    const froms = params.add(windows.map((window) => window.from));
    const tos = params.add(windows.map((window) => window.to));
    const referenceParam = params.add(referenceYears);
    const currentParam = params.add(current.year);
    const conditions = filterConditions(filters, params, { lines: true });
    const { rows } = await client.query<{
      customer_id: string;
      name: string;
      segment: string;
      seller_id: string;
      business_unit: string;
      last_billing_date: string | null;
      windows: { year: number; sales: string; invoices: number }[];
      reference_sales: string;
      total_rows: string;
    }>(
      `WITH w AS (SELECT * FROM unnest(${years}::int[], ${froms}::date[], ${tos}::date[]) AS w(year, from_date, to_date)),
       s AS (
         SELECT w.year, i.customer_id, sum(l.line_amount_cents) AS sales, count(DISTINCT i.invoice_number) AS invoices
         FROM w
         JOIN invoices i ON i.billing_date BETWEEN w.from_date AND w.to_date
         JOIN invoice_lines l ON l.invoice_number = i.invoice_number
         JOIN customers c ON c.customer_id = i.customer_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         GROUP BY 1, 2
       ),
       qualifying AS (
         SELECT customer_id FROM s WHERE year = ANY(${referenceParam}::int[])
         GROUP BY customer_id HAVING count(DISTINCT year) = cardinality(${referenceParam}::int[])
         EXCEPT
         SELECT customer_id FROM s WHERE year = ${currentParam}::int
       )
       SELECT c.customer_id, c.name, c.segment, c.seller_id, se.business_unit,
              (SELECT max(billing_date)::text FROM invoices i WHERE i.customer_id = c.customer_id) AS last_billing_date,
              (SELECT json_agg(json_build_object('year', s.year, 'sales', s.sales::text, 'invoices', s.invoices) ORDER BY s.year)
                 FROM s WHERE s.customer_id = c.customer_id) AS windows,
              (SELECT sum(s.sales) FROM s WHERE s.customer_id = c.customer_id)::text AS reference_sales,
              count(*) OVER ()::text AS total_rows
       FROM qualifying q
       JOIN customers c ON c.customer_id = q.customer_id
       JOIN sellers se ON se.seller_id = c.seller_id
       ORDER BY (SELECT sum(s.sales) FROM s WHERE s.customer_id = c.customer_id) DESC, c.customer_id COLLATE "C"
       LIMIT ${params.add(input.limit)}`,
      params.values,
    );
    const totalRows = count(rows[0]?.total_rows);
    const notes: Note[] = [NOTES.GAP_NOT_CAUSE];
    if (status === "in-progress") notes.push(NOTES.CURRENT_WINDOW_IN_PROGRESS);
    if (status === "not-started") notes.push(NOTES.CURRENT_WINDOW_NOT_STARTED);
    if (filters.productId !== undefined) notes.push(NOTES.PRODUCT_FILTER_SELECTS_LINES);
    return envelope(
      context.dataset,
      notes,
      {
        window: { name: input.window, definition: WINDOW_DESCRIPTIONS[input.window], ...(input.window === "agro-season" ? {} : { leadDays: LEAD_DAYS }) },
        referenceWindows: references,
        currentWindow: current,
        filters,
        customers: rows.map((row) => {
          const byYear = new Map(row.windows.map((window) => [window.year, window]));
          return {
            customerId: row.customer_id,
            name: row.name,
            segment: row.segment,
            sellerId: row.seller_id,
            businessUnit: row.business_unit,
            businessUnitLabel: BUSINESS_UNIT_LABELS[row.business_unit] ?? null,
            referenceWindows: references.map((window) => {
              const found = byYear.get(window.year);
              return { year: window.year, ...money("sales", found ? toSafeInteger(found.sales) : 0), invoiceCount: found?.invoices ?? 0 };
            }),
            ...money("referenceTotalSales", toSafeInteger(row.reference_sales)),
            ...money("currentWindowSales", 0),
            lastBillingDate: row.last_billing_date,
          };
        }),
      },
      { truncated: totalRows > rows.length, totalRows },
    );
  },
});

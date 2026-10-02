import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { BUSINESS_UNIT_LABELS, envelope, NOTES, PAYMENT_SCHEDULES } from "../conventions.ts";
import { defineTool } from "../tool.ts";

export const datasetOverview = defineTool({
  name: "dataset_overview",
  title: "Dataset overview",
  description:
    "What data exists and as of when: the as-of date (the dataset's 'today'), the first and last billing dates, " +
    "counts of invoices, invoice lines, scheduled installments, customers, products and applied deliveries, the sellers " +
    "(ID, business unit, territory), the business units, the payment schedules (code, label, day offsets), the customer " +
    "segments and the data's provenance. The data holds invoiced sales and contractual scheduled installments only: " +
    "there are no payments, receipts or balances. Call this first to learn the as-of date.",
  input: z.strictObject({}),
  async run(context, client) {
    const counts = (
      await client.query<Record<string, string | null>>(`
        SELECT (SELECT count(*) FROM invoices)::text AS invoices,
               (SELECT count(*) FROM invoice_lines)::text AS lines,
               (SELECT count(*) FROM scheduled_installments)::text AS installments,
               (SELECT count(*) FROM customers)::text AS customers,
               (SELECT count(*) FROM products)::text AS products,
               (SELECT count(*) FROM sellers)::text AS sellers,
               (SELECT count(*) FROM deliveries)::text AS deliveries,
               (SELECT min(billing_date)::text FROM invoices) AS first_billing_date,
               (SELECT max(billing_date)::text FROM invoices) AS last_billing_date`)
    ).rows[0]!;
    const sellers = await client.query<{ seller_id: string; business_unit: string; territory: string }>(
      "SELECT seller_id, business_unit, territory FROM sellers ORDER BY seller_id",
    );
    const segments = await client.query<{ segment: string; customers: string }>(
      "SELECT segment, count(*)::text AS customers FROM customers GROUP BY segment ORDER BY segment",
    );
    return envelope(context.dataset, [NOTES.NO_PAYMENT_DATA], {
      coverageStartDate: context.dataset.coverageStartDate,
      firstBillingDate: counts.first_billing_date,
      lastBillingDate: counts.last_billing_date,
      counts: {
        invoices: toSafeInteger(counts.invoices!),
        invoiceLines: toSafeInteger(counts.lines!),
        scheduledInstallments: toSafeInteger(counts.installments!),
        customers: toSafeInteger(counts.customers!),
        products: toSafeInteger(counts.products!),
        sellers: toSafeInteger(counts.sellers!),
        appliedDeliveries: toSafeInteger(counts.deliveries!),
      },
      businessUnits: Object.entries(BUSINESS_UNIT_LABELS).map(([code, label]) => ({ code, label })),
      sellers: sellers.rows.map((row) => ({
        sellerId: row.seller_id,
        businessUnit: row.business_unit,
        territory: row.territory,
      })),
      paymentSchedules: PAYMENT_SCHEDULES.map((schedule) => ({ ...schedule, dayOffsets: [...schedule.dayOffsets] })),
      segments: segments.rows.map((row) => ({ segment: row.segment, customerCount: toSafeInteger(row.customers) })),
    });
  },
});

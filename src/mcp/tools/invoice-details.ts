import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { money } from "../../shared/money.ts";
import { BUSINESS_UNIT_LABELS, envelope, LIMITS, NOTES, PAYMENT_SCHEDULE_LABELS, ToolError, type Note } from "../conventions.ts";
import { idSchema } from "../inputs.ts";
import { defineTool } from "../tool.ts";

interface HeaderRow {
  invoice_number: string;
  billing_date: string;
  customer_id: string;
  customer_name: string;
  seller_id: string;
  seller_name: string;
  business_unit: string;
  payment_schedule: string;
  last_delivery_id: string;
  delivery_first_billing_date: string;
  delivery_last_billing_date: string;
}

export const invoiceDetails = defineTool({
  name: "invoice_details",
  title: "Invoice details",
  description:
    "One to ten invoices in full: header (billing date, customer, seller, business unit, payment schedule), lines " +
    "(line number, product, packages, unit price, amount, commission) and scheduled installments (number, due date, " +
    "amount), kept separate from the lines, with a check that the installments sum to the lines, and the delivery that " +
    "last wrote the invoice. Installments are contractual due amounts, not payments. Unknown numbers are listed in notFound.",
  input: z.strictObject({
    invoiceNumbers: z.array(idSchema("Invoice number, for example 000123.")).min(1).max(LIMITS.maxInvoices),
  }),
  async run(context, client, input) {
    const numbers = [...new Set(input.invoiceNumbers)];
    const headers = await client.query<HeaderRow>(
      `SELECT i.invoice_number, i.billing_date::text, i.customer_id, c.name AS customer_name, i.seller_id, s.name AS seller_name,
              i.business_unit, i.payment_schedule, i.last_delivery_id::text,
              d.first_billing_date::text AS delivery_first_billing_date, d.last_billing_date::text AS delivery_last_billing_date
       FROM invoices i
       JOIN customers c ON c.customer_id = i.customer_id
       JOIN sellers s ON s.seller_id = i.seller_id
       JOIN deliveries d ON d.delivery_id = i.last_delivery_id
       WHERE i.invoice_number = ANY($1::text[])`,
      [numbers],
    );
    if (headers.rows.length === 0) throw new ToolError("NOT_FOUND", { field: "invoiceNumbers" });
    const lines = await client.query<{
      invoice_number: string;
      line_number: number;
      product_id: string;
      product_name: string;
      package_quantity: string;
      unit_price_cents: string;
      line_amount_cents: string;
      commission_amount_cents: string;
    }>(
      `SELECT l.invoice_number, l.line_number, l.product_id, p.name AS product_name, l.package_quantity::text,
              l.unit_price_cents::text, l.line_amount_cents::text, l.commission_amount_cents::text
       FROM invoice_lines l JOIN products p ON p.product_id = l.product_id
       WHERE l.invoice_number = ANY($1::text[]) ORDER BY l.invoice_number, l.line_number`,
      [numbers],
    );
    const installments = await client.query<{ invoice_number: string; installment_number: number; due_date: string; amount_cents: string }>(
      `SELECT invoice_number, installment_number, due_date::text, amount_cents::text
       FROM scheduled_installments WHERE invoice_number = ANY($1::text[]) ORDER BY invoice_number, installment_number`,
      [numbers],
    );

    const byNumber = new Map(headers.rows.map((row) => [row.invoice_number, row]));
    const invoices = numbers.flatMap((number) => {
      const header = byNumber.get(number);
      if (!header) return [];
      const ownLines = lines.rows.filter((row) => row.invoice_number === number);
      const ownInstallments = installments.rows.filter((row) => row.invoice_number === number);
      const linesTotal = ownLines.reduce((sum, row) => sum + toSafeInteger(row.line_amount_cents), 0);
      const commissionTotal = ownLines.reduce((sum, row) => sum + toSafeInteger(row.commission_amount_cents), 0);
      const scheduledTotal = ownInstallments.reduce((sum, row) => sum + toSafeInteger(row.amount_cents), 0);
      return [
        {
          invoiceNumber: number,
          billingDate: header.billing_date,
          customerId: header.customer_id,
          customerName: header.customer_name,
          sellerId: header.seller_id,
          sellerName: header.seller_name,
          businessUnit: header.business_unit,
          businessUnitLabel: BUSINESS_UNIT_LABELS[header.business_unit] ?? null,
          paymentSchedule: header.payment_schedule,
          paymentScheduleLabel: PAYMENT_SCHEDULE_LABELS[header.payment_schedule] ?? null,
          lines: ownLines.map((row) => ({
            lineNumber: row.line_number,
            productId: row.product_id,
            productName: row.product_name,
            packageQuantity: toSafeInteger(row.package_quantity),
            ...money("unitPrice", toSafeInteger(row.unit_price_cents)),
            ...money("lineAmount", toSafeInteger(row.line_amount_cents)),
            ...money("commission", toSafeInteger(row.commission_amount_cents)),
          })),
          scheduledInstallments: ownInstallments.map((row) => ({
            installmentNumber: row.installment_number,
            dueDate: row.due_date,
            ...money("scheduledAmount", toSafeInteger(row.amount_cents)),
          })),
          totals: {
            lineCount: ownLines.length,
            ...money("sales", linesTotal),
            ...money("commission", commissionTotal),
            installmentCount: ownInstallments.length,
            ...money("scheduled", scheduledTotal),
            installmentsMatchLines: scheduledTotal === linesTotal,
          },
          lastWrittenBy: {
            deliveryId: header.last_delivery_id,
            firstBillingDate: header.delivery_first_billing_date,
            lastBillingDate: header.delivery_last_billing_date,
          },
        },
      ];
    });
    const notFound = numbers.filter((number) => !byNumber.has(number));
    const notes: Note[] = [NOTES.NO_PAYMENT_DATA];
    if (notFound.length > 0) notes.push(NOTES.SOME_NOT_FOUND);
    return envelope(context.dataset, notes, { invoices, notFound });
  },
});

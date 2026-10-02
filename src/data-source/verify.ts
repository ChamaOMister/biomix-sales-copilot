/**
 * Checks a loaded dataset against the generator's `summary.json`: figures recomputable from the
 * deliveries, never the answer key. Also checks that every invoice has scheduled installments
 * summing exactly to its lines.
 */
import { readFileSync } from "node:fs";
import type pg from "pg";
import { toSafeInteger } from "../db/pool.ts";

export interface FeedSummary {
  seed: number;
  firstBillingDate: string;
  lastBillingDate: string;
  closedMonthDeliveries: number;
  pendingDeliveryMonth: string;
  invoices: number;
  lines: number;
  customers: number;
  products: number;
  byUnitAndYear: { year: number; businessUnit: string; actualCents: number }[];
  deliveries: { month: string; deliveryId: string; pending: boolean }[];
}

/** The contract's business-unit labels, as `summary.json` spells them. */
const UNIT_BY_LABEL: Readonly<Record<string, string>> = { Agro: "AGRO", "Home & Garden": "HOME_GARDEN" };

export function readSummary(file: string): FeedSummary {
  return JSON.parse(readFileSync(file, "utf8")) as FeedSummary;
}

/** Returns the mismatches found; an empty list means the stored data equals the summary. */
export async function verifyDataset(pool: pg.Pool, summary: FeedSummary): Promise<string[]> {
  const problems: string[] = [];
  const expect = (what: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) problems.push(`${what}: stored ${String(actual)}, expected ${String(expected)}`);
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const counts = (
      await client.query<Record<string, string | null>>(`
        SELECT (SELECT count(*) FROM invoices) AS invoices,
               (SELECT count(*) FROM invoice_lines) AS lines,
               (SELECT count(*) FROM customers) AS customers,
               (SELECT count(*) FROM products) AS products,
               (SELECT count(*) FROM feed_deliveries WHERE status = 'applied') AS applied,
               (SELECT count(*) FROM feed_deliveries WHERE status <> 'applied') AS not_applied,
               (SELECT min(billing_date)::text FROM invoices) AS first_billing_date,
               (SELECT max(billing_date)::text FROM invoices) AS last_billing_date`)
    ).rows[0]!;
    expect("invoices", toSafeInteger(counts.invoices!), summary.invoices);
    expect("invoice lines", toSafeInteger(counts.lines!), summary.lines);
    expect("customers", toSafeInteger(counts.customers!), summary.customers);
    expect("products", toSafeInteger(counts.products!), summary.products);
    expect("applied deliveries", toSafeInteger(counts.applied!), summary.deliveries.length);
    expect("deliveries not applied", toSafeInteger(counts.not_applied!), 0);
    // The summary's dates bound the covered period; the first and last invoices fall inside it.
    const first = counts.first_billing_date ?? "";
    const last = counts.last_billing_date ?? "";
    if (first < summary.firstBillingDate || last > summary.lastBillingDate || first > last) {
      problems.push(`billing dates ${first}..${last} fall outside ${summary.firstBillingDate}..${summary.lastBillingDate}`);
    }

    const stored = new Set(
      (await client.query<{ id: string }>("SELECT delivery_id::text AS id FROM feed_deliveries")).rows.map((row) => row.id),
    );
    const missing = summary.deliveries.filter((delivery) => !stored.has(delivery.deliveryId)).length;
    expect("summary deliveries missing from the database", missing, 0);

    const totals = await client.query<{ business_unit: string; year: number; sales_cents: string }>(`
      SELECT i.business_unit, extract(year FROM i.billing_date)::int AS year, sum(l.line_amount_cents)::text AS sales_cents
      FROM invoices i JOIN invoice_lines l ON l.invoice_number = i.invoice_number
      GROUP BY 1, 2`);
    const byKey = new Map(totals.rows.map((row) => [`${row.business_unit}/${row.year}`, toSafeInteger(row.sales_cents)]));
    for (const row of summary.byUnitAndYear) {
      const unit = UNIT_BY_LABEL[row.businessUnit] ?? row.businessUnit;
      expect(`sales ${unit} ${row.year}`, byKey.get(`${unit}/${row.year}`), row.actualCents);
    }
    expect("unit-year groups", totals.rows.length, summary.byUnitAndYear.length);

    const unreconciled = (
      await client.query<{ count: string }>(`
        SELECT count(*) AS count FROM invoices i
        WHERE (SELECT sum(amount_cents) FROM scheduled_installments s WHERE s.invoice_number = i.invoice_number)
              IS DISTINCT FROM
              (SELECT sum(line_amount_cents) FROM invoice_lines l WHERE l.invoice_number = i.invoice_number)`)
    ).rows[0]!;
    expect("invoices whose installments do not sum to their lines", toSafeInteger(unreconciled.count), 0);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return problems;
}

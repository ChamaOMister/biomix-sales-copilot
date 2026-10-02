/**
 * RC for the investigation tools, over the replayed dataset. Window dates are computed here with
 * the platform's UTC calendar, independently of the tools' integer date arithmetic.
 */
import type { RefDataset, RefInvoice } from "./replay.ts";
import { matchingLines, type RefFilters } from "./sales.ts";

const invoiceSales = (invoice: RefInvoice) => invoice.lines.reduce((sum, line) => sum + line.lineAmountCents, 0);

/** Sales and distinct invoices per key in a period. */
export function salesByKey(
  dataset: RefDataset,
  period: { from: string; to: string },
  filters: RefFilters,
  keyOf: (invoice: RefInvoice, productId: string) => string,
): Map<string, { salesCents: number; invoices: Set<string> }> {
  const result = new Map<string, { salesCents: number; invoices: Set<string> }>();
  for (const [invoice, line] of matchingLines(dataset, period, filters)) {
    const key = keyOf(invoice, line.productId);
    const entry = result.get(key) ?? { salesCents: 0, invoices: new Set<string>() };
    result.set(key, entry);
    entry.salesCents += line.lineAmountCents;
    entry.invoices.add(invoice.invoiceNumber);
  }
  return result;
}

export interface RefComparisonRow {
  key: string;
  previousSalesCents: number;
  previousInvoices: number;
  currentSalesCents: number;
  currentInvoices: number;
}

export function refCompare(
  dataset: RefDataset,
  current: { from: string; to: string },
  previous: { from: string; to: string },
  filters: RefFilters,
  groupBy: "businessUnit" | "seller" | "customer" | "product",
): RefComparisonRow[] {
  const keyOf = (invoice: RefInvoice, productId: string) =>
    groupBy === "businessUnit" ? invoice.businessUnit : groupBy === "seller" ? invoice.sellerId : groupBy === "customer" ? invoice.customerId : productId;
  const now = salesByKey(dataset, current, filters, keyOf);
  const before = salesByKey(dataset, previous, filters, keyOf);
  return [...new Set([...now.keys(), ...before.keys()])].sort().map((key) => ({
    key,
    previousSalesCents: before.get(key)?.salesCents ?? 0,
    previousInvoices: before.get(key)?.invoices.size ?? 0,
    currentSalesCents: now.get(key)?.salesCents ?? 0,
    currentInvoices: now.get(key)?.invoices.size ?? 0,
  }));
}

/** First billing date ever per customer. */
export function firstBillingDates(dataset: RefDataset): Map<string, string> {
  const first = new Map<string, string>();
  for (const invoice of dataset.invoices) {
    const known = first.get(invoice.customerId);
    if (known === undefined || invoice.billingDate < known) first.set(invoice.customerId, invoice.billingDate);
  }
  return first;
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const utc = (year: number, monthIndex: number, day: number) => new Date(Date.UTC(year, monthIndex, day));
const plusDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

/** Named window dates, computed with Date.UTC. */
export function refWindow(name: string, year: number): { from: string; to: string } {
  const lead = (day: Date) => ({ from: iso(plusDays(day, -21)), to: iso(plusDays(day, -1)) });
  if (name === "agro-season") return { from: iso(utc(year, 4, 1)), to: iso(utc(year, 9, 31)) };
  if (name === "mothers-day-lead") {
    const first = utc(year, 4, 1);
    return lead(plusDays(first, ((7 - first.getUTCDay()) % 7) + 7));
  }
  if (name === "black-friday-lead") {
    const first = utc(year, 10, 1);
    const firstThursday = plusDays(first, (4 - first.getUTCDay() + 7) % 7);
    return lead(plusDays(firstThursday, 22));
  }
  if (name === "christmas-lead") return lead(utc(year, 11, 25));
  throw new Error(`Unknown window ${name}`);
}

/** Customers with purchases in every reference window and none in the current one (cut at the as-of date). */
export function refWindowGaps(
  dataset: RefDataset,
  name: string,
  referenceYears: number[],
  currentYear: number,
  filters: RefFilters,
): string[] {
  const buyers = (window: { from: string; to: string }) =>
    new Set(matchingLines(dataset, window, filters).map(([invoice]) => invoice.customerId));
  const current = refWindow(name, currentYear);
  const currentBuyers = buyers({ from: current.from, to: current.to < dataset.asOf ? current.to : dataset.asOf });
  const sets = referenceYears.map((year) => buyers(refWindow(name, year)));
  const [first, ...rest] = sets;
  return [...(first ?? [])].filter((customer) => rest.every((set) => set.has(customer)) && !currentBuyers.has(customer)).sort();
}

export function refSameDay(dataset: RefDataset, period: { from: string; to: string }): { customerId: string; billingDate: string; invoiceNumbers: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const invoice of dataset.invoices) {
    if (invoice.billingDate < period.from || invoice.billingDate > period.to) continue;
    const key = `${invoice.billingDate}|${invoice.customerId}`;
    groups.set(key, [...(groups.get(key) ?? []), invoice.invoiceNumber]);
  }
  return [...groups.entries()]
    .filter(([, numbers]) => numbers.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, numbers]) => {
      const [billingDate, customerId] = key.split("|") as [string, string];
      return { customerId, billingDate, invoiceNumbers: numbers.sort() };
    });
}

/** Invoices delivered more than once: the last delivery replaced the earlier version. */
export function refResent(dataset: RefDataset): { invoiceNumber: string; salesCents: number; deliveryId: string }[] {
  const seen = new Map<string, number>();
  for (const delivery of dataset.deliveries) {
    for (const number of delivery.invoiceNumbers) seen.set(number, (seen.get(number) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, times]) => times > 1)
    .map(([number]) => dataset.invoiceByNumber.get(number)!)
    .sort((a, b) => (a.billingDate < b.billingDate ? -1 : a.billingDate > b.billingDate ? 1 : a.invoiceNumber < b.invoiceNumber ? -1 : 1))
    .map((invoice) => ({ invoiceNumber: invoice.invoiceNumber, salesCents: invoiceSales(invoice), deliveryId: invoice.deliveryId }));
}

export function refCustomerActivity(dataset: RefDataset, customerId: string, period: { from: string; to: string }, grain: "month" | "year") {
  const buckets = new Map<string, { salesCents: number; invoices: Set<string>; lines: number }>();
  for (const [invoice, line] of matchingLines(dataset, period, { customerId })) {
    const key = grain === "month" ? invoice.billingDate.slice(0, 7) : invoice.billingDate.slice(0, 4);
    const bucket = buckets.get(key) ?? { salesCents: 0, invoices: new Set<string>(), lines: 0 };
    buckets.set(key, bucket);
    bucket.salesCents += line.lineAmountCents;
    bucket.invoices.add(invoice.invoiceNumber);
    bucket.lines += 1;
  }
  return new Map([...buckets].map(([key, bucket]) => [key, { salesCents: bucket.salesCents, invoiceCount: bucket.invoices.size, lineCount: bucket.lines }]));
}

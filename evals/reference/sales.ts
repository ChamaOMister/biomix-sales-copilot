/**
 * RC for invoiced sales: totals and groups computed line by line in TypeScript over the replayed
 * dataset, with the same semantics the tools document (a product filter selects lines; invoices
 * and customers are counted distinct; groups are the largest by sales, ties by key in code-point
 * order, and the rest is summed separately).
 */
import type { RefDataset, RefInvoice, RefLine } from "./replay.ts";

export interface RefFilters {
  businessUnit?: string;
  sellerId?: string;
  customerId?: string;
  productId?: string;
  segment?: string;
}

export interface RefFigures {
  salesCents: number;
  commissionCents: number;
  invoiceCount: number;
  lineCount: number;
  customerCount: number;
  packageQuantity: number;
}

export type RefGroupBy = "none" | "month" | "year" | "businessUnit" | "seller" | "customer" | "product" | "paymentSchedule" | "segment";

class Accumulator {
  salesCents = 0;
  commissionCents = 0;
  lineCount = 0;
  packageQuantity = 0;
  readonly invoices = new Set<string>();
  readonly customers = new Set<string>();

  add(invoice: RefInvoice, line: RefLine): void {
    this.salesCents += line.lineAmountCents;
    this.commissionCents += line.commissionAmountCents;
    this.lineCount += 1;
    this.packageQuantity += line.packageQuantity;
    this.invoices.add(invoice.invoiceNumber);
    this.customers.add(invoice.customerId);
    if (!Number.isSafeInteger(this.salesCents)) throw new RangeError("RC sales exceed the safe integer range");
  }

  figures(): RefFigures {
    return {
      salesCents: this.salesCents,
      commissionCents: this.commissionCents,
      invoiceCount: this.invoices.size,
      lineCount: this.lineCount,
      customerCount: this.customers.size,
      packageQuantity: this.packageQuantity,
    };
  }
}

/** Every matching (invoice, line) pair. */
export function matchingLines(dataset: RefDataset, period: { from: string; to: string }, filters: RefFilters): [RefInvoice, RefLine][] {
  const pairs: [RefInvoice, RefLine][] = [];
  for (const invoice of dataset.invoices) {
    if (invoice.billingDate < period.from || invoice.billingDate > period.to) continue;
    if (filters.businessUnit !== undefined && invoice.businessUnit !== filters.businessUnit) continue;
    if (filters.sellerId !== undefined && invoice.sellerId !== filters.sellerId) continue;
    if (filters.customerId !== undefined && invoice.customerId !== filters.customerId) continue;
    if (filters.segment !== undefined && dataset.customers.get(invoice.customerId)?.segment !== filters.segment) continue;
    for (const line of invoice.lines) {
      if (filters.productId !== undefined && line.productId !== filters.productId) continue;
      pairs.push([invoice, line]);
    }
  }
  return pairs;
}

function keyOf(dataset: RefDataset, groupBy: RefGroupBy, invoice: RefInvoice, line: RefLine): string {
  switch (groupBy) {
    case "month":
      return invoice.billingDate.slice(0, 7);
    case "year":
      return invoice.billingDate.slice(0, 4);
    case "businessUnit":
      return invoice.businessUnit;
    case "seller":
      return invoice.sellerId;
    case "customer":
      return invoice.customerId;
    case "product":
      return line.productId;
    case "paymentSchedule":
      return invoice.paymentSchedule;
    case "segment":
      return dataset.customers.get(invoice.customerId)!.segment;
    case "none":
      return "";
  }
}

export interface RefSalesTotals {
  totals: RefFigures;
  groups: { key: string; figures: RefFigures }[];
  other: (RefFigures & { groupCount: number }) | null;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function refSalesTotals(
  dataset: RefDataset,
  period: { from: string; to: string },
  filters: RefFilters,
  groupBy: RefGroupBy,
  limit: number,
): RefSalesTotals {
  const pairs = matchingLines(dataset, period, filters);
  const total = new Accumulator();
  const groups = new Map<string, Accumulator>();
  for (const [invoice, line] of pairs) {
    total.add(invoice, line);
    if (groupBy === "none") continue;
    const key = keyOf(dataset, groupBy, invoice, line);
    const group = groups.get(key) ?? new Accumulator();
    groups.set(key, group);
    group.add(invoice, line);
  }
  if (groupBy === "none") return { totals: total.figures(), groups: [], other: null };
  const chronological = groupBy === "month" || groupBy === "year";
  const ordered = [...groups.entries()]
    .map(([key, group]) => ({ key, figures: group.figures() }))
    .sort((a, b) => (chronological ? byCodePoint(a.key, b.key) : b.figures.salesCents - a.figures.salesCents || byCodePoint(a.key, b.key)));
  if (chronological) return { totals: total.figures(), groups: ordered, other: null };
  const shown = ordered.slice(0, limit);
  const shownKeys = new Set(shown.map((group) => group.key));
  let other: RefSalesTotals["other"] = null;
  if (ordered.length > shown.length) {
    const rest = new Accumulator();
    for (const [invoice, line] of pairs) if (!shownKeys.has(keyOf(dataset, groupBy, invoice, line))) rest.add(invoice, line);
    other = { ...rest.figures(), groupCount: ordered.length - shown.length };
  }
  return { totals: total.figures(), groups: shown, other };
}

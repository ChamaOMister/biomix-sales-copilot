/**
 * RC for scheduled collections, through Project 1's own pure modules at the pinned commit:
 * `buildCollectionsReport` (its collections view) and `scheduleInstallments` (which recomputes each
 * invoice's installments from its lines). The tools read stored installments instead, so parity
 * also checks that what was stored equals what Project 1 computes.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RefDataset, RefInvoice } from "./replay.ts";

interface CollectionsRow {
  key: string;
  invoiceCount: number;
  installmentCount: number;
  scheduledCents: number;
}

export interface ProjectOneCollectionsReport {
  totals: { invoiceCount: number; installmentCount: number; scheduledCents: number };
  byDueMonth: CollectionsRow[];
  byPaymentSchedule: CollectionsRow[];
  invoicedSalesCents: number;
  reconciled: boolean;
}

interface ProjectOneCollections {
  buildCollectionsReport(
    lines: readonly object[],
    filters: { customerId?: string; productId?: string; sellerName?: string; businessUnit?: string; from?: string; to?: string },
  ): { ok: true; report: ProjectOneCollectionsReport } | { ok: false; code: string };
}

interface ProjectOneSchedule {
  scheduleInstallments(invoice: { billingDate: string; paymentSchedule: string; lines: readonly { lineAmountCents: number }[] }):
    | { ok: true; installments: { installmentNumber: number; dueDate: string; amountCents: number }[] }
    | { ok: false; code: string };
}

async function importModule<T>(checkoutDir: string, ...parts: string[]): Promise<T> {
  return (await import(pathToFileURL(path.join(checkoutDir, "src", ...parts)).href)) as T;
}

/** The replayed dataset as Project 1's `SalesLine` records, with the fields its reports read. */
function salesLines(dataset: RefDataset): object[] {
  return dataset.invoices.flatMap((invoice) =>
    invoice.lines.map((line) => ({
      lineId: `${invoice.invoiceNumber}/${line.lineNumber}`,
      billingDate: invoice.billingDate,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: dataset.customers.get(invoice.customerId)!.name,
      productId: line.productId,
      sellerName: dataset.sellers.get(invoice.sellerId)!.name,
      businessUnit: invoice.businessUnit,
      paymentSchedule: invoice.paymentSchedule,
      packageQuantity: line.packageQuantity,
      unitPriceCents: line.unitPriceCents,
      lineAmountCents: line.lineAmountCents,
      commissionAmountCents: line.commissionAmountCents,
    })),
  );
}

export async function projectOneCollections(
  checkoutDir: string,
  dataset: RefDataset,
  filters: { from: string; to: string; businessUnit?: string; customerId?: string; sellerId?: string; productId?: string },
): Promise<{ ok: true; report: ProjectOneCollectionsReport } | { ok: false; code: string }> {
  const module = await importModule<ProjectOneCollections>(checkoutDir, "domain", "collections", "report.ts");
  const { sellerId, ...rest } = filters;
  return module.buildCollectionsReport(salesLines(dataset), {
    ...rest,
    ...(sellerId !== undefined ? { sellerName: dataset.sellers.get(sellerId)!.name } : {}),
  });
}

/** Installments due in a period, recomputed with Project 1's `scheduleInstallments`. */
export async function refInstallmentsDue(
  checkoutDir: string,
  dataset: RefDataset,
  due: { from: string; to: string },
  filter: (invoice: RefInvoice) => boolean = () => true,
): Promise<{ scheduledCents: number; installmentCount: number; invoiceCount: number; byDueMonth: Map<string, number> }> {
  const module = await importModule<ProjectOneSchedule>(checkoutDir, "domain", "collections", "schedule.ts");
  let scheduledCents = 0;
  let installmentCount = 0;
  const invoices = new Set<string>();
  const byDueMonth = new Map<string, number>();
  for (const invoice of dataset.invoices) {
    if (!filter(invoice)) continue;
    const scheduled = module.scheduleInstallments(invoice);
    if (!scheduled.ok) throw new Error(`Project 1 could not schedule invoice ${invoice.invoiceNumber}`);
    for (const installment of scheduled.installments) {
      if (installment.dueDate < due.from || installment.dueDate > due.to) continue;
      scheduledCents += installment.amountCents;
      installmentCount += 1;
      invoices.add(invoice.invoiceNumber);
      const month = installment.dueDate.slice(0, 7);
      byDueMonth.set(month, (byDueMonth.get(month) ?? 0) + installment.amountCents);
    }
  }
  return { scheduledCents, installmentCount, invoiceCount: invoices.size, byDueMonth };
}

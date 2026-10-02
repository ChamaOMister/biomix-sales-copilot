/**
 * Recomputation reference (RC, decision 001, section 4): rebuilds the dataset in memory by
 * replaying the generated delivery files, the last delivery winning for each invoice, customer and
 * product, exactly as Project 1's ingestion replaces them. It shares no code with the tools' SQL,
 * so comparing the two is a SQL-versus-TypeScript parity check.
 *
 * Reads delivery files and `summary.json` only; the answer key has its own loader.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const UNIT_CODES: Readonly<Record<string, string>> = { Agro: "AGRO", "Home & Garden": "HOME_GARDEN" };
export const SCHEDULE_CODES: Readonly<Record<string, string>> = {
  Upfront: "UPFRONT",
  "30 Days": "NET_30",
  "3 installments (30, 60 and 90 days)": "INSTALLMENTS_30_60_90",
  "4 installments (Upfront, 30, 60 and 90 days)": "INSTALLMENTS_0_30_60_90",
};

export interface RefLine {
  lineNumber: number;
  productId: string;
  packageQuantity: number;
  unitPriceCents: number;
  lineAmountCents: number;
  commissionAmountCents: number;
}

export interface RefInvoice {
  invoiceNumber: string;
  billingDate: string;
  customerId: string;
  sellerId: string;
  businessUnit: string;
  paymentSchedule: string;
  lines: RefLine[];
  /** The delivery that last wrote the invoice. */
  deliveryId: string;
  deliveryIndex: number;
}

export interface RefCustomer {
  customerId: string;
  name: string;
  segment: string;
  city: string;
  state: string;
  sellerId: string;
}

export interface RefProduct {
  productId: string;
  name: string;
  category: string;
  businessUnit: string;
}

export interface RefSeller {
  sellerId: string;
  name: string;
  businessUnit: string;
  territory: string;
}

export interface RefDelivery {
  deliveryId: string;
  name: string;
  pending: boolean;
  invoiceNumbers: string[];
  firstBillingDate: string;
  lastBillingDate: string;
}

export interface RefDataset {
  invoices: RefInvoice[];
  invoiceByNumber: Map<string, RefInvoice>;
  customers: Map<string, RefCustomer>;
  products: Map<string, RefProduct>;
  sellers: Map<string, RefSeller>;
  deliveries: RefDelivery[];
  asOf: string;
  coverageStart: string;
}

interface DeliveryPayload {
  deliveryId: string;
  invoices: {
    invoiceNumber: string;
    billingDate: string;
    customer: { id: string; name: string; segment: string; city: string; state: string };
    sellerId: string;
    businessUnit: string;
    paymentSchedule: string;
    lines: {
      productId: string;
      productName: string;
      productCategory: string;
      packageQuantity: number;
      unitPriceCents: number;
      lineAmountCents: number;
      commissionAmountCents: number;
    }[];
  }[];
}

function code(map: Readonly<Record<string, string>>, label: string): string {
  const value = map[label];
  if (!value) throw new Error(`Unknown contract label: ${label}`);
  return value;
}

function deliveryFiles(feedDir: string): { name: string; file: string; pending: boolean }[] {
  const list = (folder: string) =>
    readdirSync(path.join(feedDir, folder))
      .filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
      .sort()
      .map((name) => ({ name: `${folder}/${name}`, file: path.join(feedDir, folder, name), pending: folder === "pending" }));
  return [...list("deliveries"), ...list("pending")];
}

/** Project 1's seller reference data, imported from the pinned checkout (a pure module). */
async function loadSellers(checkoutDir: string): Promise<Map<string, RefSeller>> {
  const url = pathToFileURL(path.join(checkoutDir, "src", "domain", "sales-feed", "reference-data.ts")).href;
  const module = (await import(url)) as { SELLERS: readonly RefSeller[] };
  return new Map(
    module.SELLERS.map((seller) => [
      seller.sellerId,
      { sellerId: seller.sellerId, name: seller.name, businessUnit: seller.businessUnit, territory: seller.territory },
    ]),
  );
}

const cache = new Map<string, Promise<RefDataset>>();

/** Replays every delivery of the generated feed in the checkout. Cached per checkout. */
export function loadReplayedDataset(checkoutDir: string): Promise<RefDataset> {
  let loaded = cache.get(checkoutDir);
  if (!loaded) {
    loaded = replay(checkoutDir);
    cache.set(checkoutDir, loaded);
  }
  return loaded;
}

async function replay(checkoutDir: string): Promise<RefDataset> {
  const feedDir = path.join(checkoutDir, "data", "generated", "feed");
  const summary = JSON.parse(readFileSync(path.join(feedDir, "summary.json"), "utf8")) as { firstBillingDate: string; lastBillingDate: string };
  const invoiceByNumber = new Map<string, RefInvoice>();
  const customers = new Map<string, RefCustomer>();
  const products = new Map<string, RefProduct>();
  const deliveries: RefDelivery[] = [];

  for (const [deliveryIndex, file] of deliveryFiles(feedDir).entries()) {
    const payload = JSON.parse(readFileSync(file.file, "utf8")) as DeliveryPayload;
    const dates = payload.invoices.map((invoice) => invoice.billingDate).sort();
    deliveries.push({
      deliveryId: payload.deliveryId,
      name: file.name,
      pending: file.pending,
      invoiceNumbers: payload.invoices.map((invoice) => invoice.invoiceNumber),
      firstBillingDate: dates[0]!,
      lastBillingDate: dates[dates.length - 1]!,
    });
    for (const invoice of payload.invoices) {
      const businessUnit = code(UNIT_CODES, invoice.businessUnit);
      customers.set(invoice.customer.id, {
        customerId: invoice.customer.id,
        name: invoice.customer.name,
        segment: invoice.customer.segment,
        city: invoice.customer.city,
        state: invoice.customer.state,
        sellerId: invoice.sellerId,
      });
      for (const line of invoice.lines) {
        products.set(line.productId, { productId: line.productId, name: line.productName, category: line.productCategory, businessUnit });
      }
      invoiceByNumber.set(invoice.invoiceNumber, {
        invoiceNumber: invoice.invoiceNumber,
        billingDate: invoice.billingDate,
        customerId: invoice.customer.id,
        sellerId: invoice.sellerId,
        businessUnit,
        paymentSchedule: code(SCHEDULE_CODES, invoice.paymentSchedule),
        lines: invoice.lines.map((line, index) => ({
          lineNumber: index + 1,
          productId: line.productId,
          packageQuantity: line.packageQuantity,
          unitPriceCents: line.unitPriceCents,
          lineAmountCents: line.lineAmountCents,
          commissionAmountCents: line.commissionAmountCents,
        })),
        deliveryId: payload.deliveryId,
        deliveryIndex,
      });
    }
  }
  const invoices = [...invoiceByNumber.values()].sort((a, b) => (a.invoiceNumber < b.invoiceNumber ? -1 : 1));
  return {
    invoices,
    invoiceByNumber,
    customers,
    products,
    sellers: await loadSellers(checkoutDir),
    deliveries,
    asOf: summary.lastBillingDate,
    coverageStart: summary.firstBillingDate,
  };
}

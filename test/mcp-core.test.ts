import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadReplayedDataset, type RefDataset } from "../evals/reference/replay.ts";
import { refSalesTotals, type RefFigures, type RefFilters, type RefGroupBy } from "../evals/reference/sales.ts";
import { formatBrl } from "../src/shared/money.ts";
import { describeDatabase } from "./support/database.ts";
import { CHECKOUT_DIR, toolHarness, type ToolHarness } from "./support/tools.ts";

let tools: ToolHarness;
let ref: RefDataset;

describeDatabase("core tools", () => {
  beforeAll(async () => {
    tools = await toolHarness();
    ref = await loadReplayedDataset(CHECKOUT_DIR);
  });
  afterAll(() => tools.close());

  const figuresOf = (value: Record<string, any>, withPackages: boolean): RefFigures => ({
    salesCents: value.salesCents as number,
    commissionCents: value.commissionCents as number,
    invoiceCount: value.invoiceCount as number,
    lineCount: value.lineCount as number,
    customerCount: value.customerCount as number,
    packageQuantity: withPackages ? (value.packageQuantity as number) : 0,
  });
  const withoutPackages = (figures: RefFigures): RefFigures => ({ ...figures, packageQuantity: 0 });

  describe("sales_totals parity with the recomputation", () => {
    const periods: [string, string | { from: string; to: string }, { from: string; to: string }][] = [
      ["calendar-year:2024", "calendar-year:2024", { from: "2024-01-01", to: "2024-12-31" }],
      ["quarter:2025-Q2", "quarter:2025-Q2", { from: "2025-04-01", to: "2025-06-30" }],
      ["month:2024-02", "month:2024-02", { from: "2024-02-01", to: "2024-02-29" }],
      ["year-to-date", "year-to-date", { from: "2026-01-01", to: "2026-09-25" }],
      ["whole dataset", { from: "2023-01-01", to: "2026-09-25" }, { from: "2023-01-01", to: "2026-09-25" }],
    ];
    const filterSets: RefFilters[] = [
      {},
      { businessUnit: "AGRO" },
      { businessUnit: "HOME_GARDEN", segment: "retail chain" },
      { sellerId: "S04" },
      { customerId: "C0012" },
      { productId: "P102" },
      { businessUnit: "AGRO", productId: "P102" },
    ];
    const groupings: RefGroupBy[] = ["none", "month", "year", "businessUnit", "seller", "customer", "product", "paymentSchedule", "segment"];

    for (const [label, input, range] of periods) {
      for (const filters of filterSets) {
        test(`${label} ${JSON.stringify(filters)}: every grouping equals RC, and groups plus the remainder add up`, async () => {
          for (const groupBy of groupings) {
            const limit = groupBy === "customer" ? 7 : 3;
            const result = await tools.call("sales_totals", { period: input, ...filters, groupBy, limit });
            const expected = refSalesTotals(ref, range, filters, groupBy, limit);
            const withPackages = groupBy === "product";
            expect(result.period).toMatchObject(range);
            expect(figuresOf(result.totals, false)).toEqual(withoutPackages(expected.totals));
            expect(result.totals.salesBrl).toBe(formatBrl(expected.totals.salesCents));

            const groups = result.groups as Record<string, any>[];
            if (groupBy === "month" || groupBy === "year") {
              // Every period is listed, zeros included; RC lists only periods with sales.
              const nonZero = groups.filter((group) => group.lineCount > 0);
              expect(nonZero.map((group) => [group.key, figuresOf(group, false)])).toEqual(
                expected.groups.map((group) => [group.key, withoutPackages(group.figures)]),
              );
            } else {
              expect(groups.map((group) => [group.key, figuresOf(group, withPackages)])).toEqual(
                expected.groups.map((group) => [group.key, withPackages ? group.figures : withoutPackages(group.figures)]),
              );
              const other = result.otherGroups as Record<string, any> | null;
              if (expected.other) {
                expect(other).not.toBeNull();
                expect({ ...figuresOf(other!, withPackages), groupCount: other!.groupCount as number }).toEqual(
                  withPackages ? expected.other : { ...withoutPackages(expected.other), groupCount: expected.other.groupCount },
                );
              } else {
                expect(other).toBeNull();
              }
            }

            // Sales, commission and lines always add up; invoices do except for product groups, which overlap.
            const parts = [...groups, ...(result.otherGroups ? [result.otherGroups as Record<string, any>] : [])];
            const sum = (field: string) => parts.reduce((total, part) => total + (part[field] as number), 0);
            if (groupBy !== "none") {
              expect(sum("salesCents")).toBe(result.totals.salesCents);
              expect(sum("commissionCents")).toBe(result.totals.commissionCents);
              expect(sum("lineCount")).toBe(result.totals.lineCount);
              if (groupBy !== "product") expect(sum("invoiceCount")).toBe(result.totals.invoiceCount);
            }
          }
        });
      }
    }
  });

  describe("sales_totals semantics", () => {
    test("a product filter counts only that product's lines and notes it; product groups note overlapping counts", async () => {
      const result = await tools.call("sales_totals", { period: "calendar-year:2025", productId: "P102" });
      expect(result.notes).toEqual(["PRODUCT_FILTER_SELECTS_LINES"]);
      const grouped = await tools.call("sales_totals", { period: "calendar-year:2025", groupBy: "product" });
      expect(grouped.notes).toEqual(["GROUP_COUNTS_OVERLAP"]);
      expect(grouped.groups[0]).toHaveProperty("packageQuantity");
      const byUnit = await tools.call("sales_totals", { period: "calendar-year:2025", groupBy: "businessUnit" });
      expect(byUnit.groups[0]).not.toHaveProperty("packageQuantity");
    });

    test("a period cut at the as-of date is echoed and noted", async () => {
      const result = await tools.call("sales_totals", { period: "calendar-year:2026" });
      expect(result.period).toEqual({ preset: "calendar-year:2026", from: "2026-01-01", to: "2026-09-25", cutAtAsOf: true, requestedTo: "2026-12-31" });
      expect(result.notes).toEqual(["PERIOD_CUT_AT_AS_OF"]);
    });

    test("month groups list every month of the period, including months without sales", async () => {
      const result = await tools.call("sales_totals", { period: { from: "2022-11-01", to: "2023-02-28" }, groupBy: "month" });
      expect((result.groups as { key: string }[]).map((group) => group.key)).toEqual(["2022-11", "2022-12", "2023-01", "2023-02"]);
      expect(result.groups[0].salesCents).toBe(0);
      expect(result.groups[0].shareBasisPoints).toBe(0);
    });

    test("shares are basis points of the total with display strings", async () => {
      const result = await tools.call("sales_totals", { period: "calendar-year:2024", groupBy: "businessUnit" });
      const agro = (result.groups as Record<string, any>[]).find((group) => group.key === "AGRO")!;
      expect(agro.label).toBe("Agro");
      expect(agro.shareBasisPoints).toBe(Math.round((agro.salesCents * 10000) / result.totals.salesCents));
      expect(agro.sharePercent).toBe(`${(agro.shareBasisPoints / 100).toFixed(2)}%`);
    });

    test("an empty selection gives zero totals and no share", async () => {
      const result = await tools.call("sales_totals", { period: { from: "2022-01-01", to: "2022-01-31" }, groupBy: "seller" });
      expect(result.totals).toMatchObject({ salesCents: 0, salesBrl: "R$ 0.00", invoiceCount: 0 });
      expect(result.groups).toEqual([]);
    });
  });

  describe("input limits and errors", () => {
    test("unknown fields are rejected without naming them", async () => {
      const error = await tools.fail("sales_totals", { period: "year-to-date", secretField: 1 });
      expect(error).toMatchObject({ code: "INPUT_INVALID", issues: [{ path: "(input)", problem: "unknown field" }] });
      expect(JSON.stringify(error)).not.toContain("secretField");
      expect((await tools.fail("dataset_overview", { x: 1 })).code).toBe("INPUT_INVALID");
      expect((await tools.fail("sales_totals", { period: { from: "2025-01-01", to: "2025-01-31", extra: true } })).code).toBe("INPUT_INVALID");
    });

    test("oversized IDs and search text are rejected without echoing them", async () => {
      const long = "C".repeat(65);
      const error = await tools.fail("sales_totals", { period: "year-to-date", customerId: long });
      expect(error.issues).toEqual([{ path: "customerId", problem: "too long or too large" }]);
      expect(JSON.stringify(error)).not.toContain(long);
      expect((await tools.fail("find_entities", { kind: "customer", query: "x".repeat(65) })).code).toBe("INPUT_INVALID");
      expect((await tools.fail("invoice_details", { invoiceNumbers: ["1".repeat(65)] })).code).toBe("INPUT_INVALID");
      expect(await tools.call("sales_totals", { period: "year-to-date", sellerId: "S".repeat(64) }).catch((e: Error) => e.message)).toMatch(/NOT_FOUND/);
    });

    test("row caps: limit at most 100 for groups, 20 for matches, 10 invoices", async () => {
      expect((await tools.fail("sales_totals", { period: "year-to-date", groupBy: "customer", limit: 101 })).code).toBe("INPUT_INVALID");
      const capped = await tools.call("sales_totals", { period: "calendar-year:2025", groupBy: "customer", limit: 100 });
      expect(capped.groups).toHaveLength(100);
      expect(capped.truncated).toBe(true);
      expect(capped.totalRows).toBeGreaterThan(100);
      const defaulted = await tools.call("sales_totals", { period: "calendar-year:2025", groupBy: "customer" });
      expect(defaulted.groups).toHaveLength(20);
      expect((await tools.fail("find_entities", { kind: "customer", query: "a", limit: 21 })).code).toBe("INPUT_INVALID");
      const matches = await tools.call("find_entities", { kind: "customer", query: "a", limit: 20 });
      expect(matches.matches).toHaveLength(20);
      expect(matches.truncated).toBe(true);
      const tooMany = Array.from({ length: 11 }, (_, index) => String(index + 1).padStart(6, "0"));
      expect((await tools.fail("invoice_details", { invoiceNumbers: tooMany })).code).toBe("INPUT_INVALID");
      expect((await tools.fail("invoice_details", { invoiceNumbers: [] })).code).toBe("INPUT_INVALID");
      expect((await tools.fail("sales_totals", { period: "year-to-date", limit: 0 })).code).toBe("INPUT_INVALID");
      expect((await tools.fail("sales_totals", { period: "year-to-date", limit: 2.5 })).code).toBe("INPUT_INVALID");
    });

    test("periods: bad presets, reversed ranges and periods after the as-of date", async () => {
      expect(await tools.fail("sales_totals", { period: "month:2026-10" })).toMatchObject({ code: "PERIOD_INVALID", reason: "STARTS_AFTER_AS_OF", asOf: "2026-09-25" });
      expect((await tools.fail("sales_totals", { period: { from: "2025-02-01", to: "2025-01-01" } })).reason).toBe("FROM_AFTER_TO");
      expect((await tools.fail("sales_totals", { period: { from: "2025-02-30", to: "2025-03-01" } })).reason).toBe("INVALID_DATE");
      expect((await tools.fail("sales_totals", { period: "last-year" })).code).toBe("INPUT_INVALID");
      expect((await tools.fail("sales_totals", { period: { from: "2020-01-01", to: "2026-01-01" }, groupBy: "month" })).reason).toBe("TOO_MANY_MONTHS");
      expect((await tools.fail("sales_totals", {})).code).toBe("INPUT_INVALID");
    });

    test("unknown filter IDs give NOT_FOUND with the field, and unknown tools are refused", async () => {
      expect(await tools.fail("sales_totals", { period: "year-to-date", customerId: "C9999" })).toMatchObject({ code: "NOT_FOUND", field: "customerId" });
      expect(await tools.fail("sales_totals", { period: "year-to-date", segment: "astronauts" })).toMatchObject({ code: "NOT_FOUND", field: "segment" });
      expect((await tools.fail("run_sql", { sql: "DELETE FROM invoices" })).code).toBe("INPUT_INVALID");
    });
  });

  describe("dataset_overview, find_entities and invoice_details", () => {
    test("dataset_overview matches the replayed dataset", async () => {
      const result = await tools.call("dataset_overview", {});
      const lines = ref.invoices.reduce((sum, invoice) => sum + invoice.lines.length, 0);
      expect(result).toMatchObject({
        asOf: ref.asOf,
        coverageStartDate: ref.coverageStart,
        firstBillingDate: ref.invoices.map((invoice) => invoice.billingDate).sort()[0],
        lastBillingDate: ref.invoices.map((invoice) => invoice.billingDate).sort().at(-1),
        counts: {
          invoices: ref.invoices.length,
          invoiceLines: lines,
          customers: ref.customers.size,
          products: ref.products.size,
          sellers: ref.sellers.size,
          appliedDeliveries: ref.deliveries.length,
        },
        notes: ["NO_PAYMENT_DATA"],
        source: { commit: "af486a5b4a2af0a7c7f71c7e124e47a7005a5a81", seed: 2026 },
      });
      expect(result.paymentSchedules).toHaveLength(4);
      expect((result.segments as { customerCount: number }[]).reduce((sum, row) => sum + row.customerCount, 0)).toBe(ref.customers.size);
    });

    test("find_entities matches names case- and accent-insensitively, exact IDs first", async () => {
      const customer = [...ref.customers.values()].find((entry) => /[áéíóúãõç]/i.test(entry.name))!;
      const plain = customer.name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
      const byName = await tools.call("find_entities", { kind: "customer", query: plain });
      expect((byName.matches as { customerId: string }[]).map((match) => match.customerId)).toContain(customer.customerId);
      const byId = await tools.call("find_entities", { kind: "customer", query: customer.customerId.toLowerCase() });
      expect(byId.matches[0]).toMatchObject({ customerId: customer.customerId, name: customer.name, segment: customer.segment, sellerId: customer.sellerId });
      const invoices = ref.invoices.filter((invoice) => invoice.customerId === customer.customerId);
      expect(byId.matches[0].invoiceCount).toBe(invoices.length);
      expect(byId.matches[0].firstBillingDate).toBe(invoices.map((invoice) => invoice.billingDate).sort()[0]);
      const wildcard = await tools.call("find_entities", { kind: "product", query: "%" });
      expect(wildcard.matches).toEqual([]);
      const seller = await tools.call("find_entities", { kind: "seller", query: "S03" });
      expect(seller.matches[0]).toMatchObject({ sellerId: "S03", businessUnit: "AGRO" });
    });

    test("invoice_details equals the replayed invoices, with installments separate and reconciled", async () => {
      const sample = [ref.invoices[0]!, ref.invoices[2000]!, ref.invoices.at(-1)!];
      const result = await tools.call("invoice_details", { invoiceNumbers: [...sample.map((invoice) => invoice.invoiceNumber), "999999"] });
      expect(result.notFound).toEqual(["999999"]);
      expect(result.notes).toEqual(["NO_PAYMENT_DATA", "SOME_NOT_FOUND"]);
      for (const [index, invoice] of sample.entries()) {
        const detail = result.invoices[index] as Record<string, any>;
        expect(detail).toMatchObject({
          invoiceNumber: invoice.invoiceNumber,
          billingDate: invoice.billingDate,
          customerId: invoice.customerId,
          sellerId: invoice.sellerId,
          businessUnit: invoice.businessUnit,
          paymentSchedule: invoice.paymentSchedule,
          lastWrittenBy: { deliveryId: invoice.deliveryId },
        });
        expect((detail.lines as Record<string, any>[]).map((line) => [line.lineNumber, line.productId, line.packageQuantity, line.lineAmountCents])).toEqual(
          invoice.lines.map((line) => [line.lineNumber, line.productId, line.packageQuantity, line.lineAmountCents]),
        );
        const total = invoice.lines.reduce((sum, line) => sum + line.lineAmountCents, 0);
        expect(detail.totals).toMatchObject({ salesCents: total, scheduledCents: total, installmentsMatchLines: true });
      }
      expect(await tools.fail("invoice_details", { invoiceNumbers: ["999999"] })).toMatchObject({ code: "NOT_FOUND", field: "invoiceNumbers" });
    });
  });
});

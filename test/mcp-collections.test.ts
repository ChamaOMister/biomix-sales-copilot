import { afterAll, beforeAll, expect, test } from "vitest";
import { projectOneCollections, refInstallmentsDue } from "../evals/reference/collections.ts";
import { loadReplayedDataset, type RefDataset } from "../evals/reference/replay.ts";
import { TOOL_NAMES } from "../src/mcp/registry.ts";
import { describeDatabase } from "./support/database.ts";
import { CHECKOUT_DIR, toolHarness, type ToolHarness } from "./support/tools.ts";

/** Words that would present scheduled amounts as payments. */
const PAYMENT_WORDS = /paid|receiv|balance|overdue|outstanding|settled|collected/i;

function keysOf(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, keys);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      keysOf(item, keys);
    }
  }
  return keys;
}

let tools: ToolHarness;
let ref: RefDataset;

describeDatabase("collections tools", () => {
  beforeAll(async () => {
    tools = await toolHarness();
    ref = await loadReplayedDataset(CHECKOUT_DIR);
  });
  afterAll(() => tools.close());

  const cases: [string, Record<string, unknown>, { from: string; to: string; businessUnit?: string; customerId?: string; sellerId?: string }][] = [
    ["March 2026", { period: "month:2026-03" }, { from: "2026-03-01", to: "2026-03-31" }],
    ["2024", { period: "calendar-year:2024" }, { from: "2024-01-01", to: "2024-12-31" }],
    ["Agro 2025 Q4", { period: "quarter:2025-Q4", businessUnit: "AGRO" }, { from: "2025-10-01", to: "2025-12-31", businessUnit: "AGRO" }],
    ["seller S01 2023", { period: "calendar-year:2023", sellerId: "S01" }, { from: "2023-01-01", to: "2023-12-31", sellerId: "S01" }],
    ["one customer", { period: { from: "2023-01-01", to: "2026-09-25" }, customerId: "C0012" }, { from: "2023-01-01", to: "2026-09-25", customerId: "C0012" }],
    ["year to date", { period: "year-to-date" }, { from: "2026-01-01", to: "2026-09-25" }],
  ];

  test.each(cases)("scheduled_collections equals Project 1's collections module: %s", async (_label, input, filters) => {
    const result = await tools.call("scheduled_collections", input);
    const expected = await projectOneCollections(CHECKOUT_DIR, ref, filters);
    if (!expected.ok) throw new Error(expected.code);
    const report = expected.report;
    expect(result.totals).toMatchObject(report.totals);
    expect((result.byDueMonth as any[]).map((row) => ({ key: row.dueMonth, invoiceCount: row.invoiceCount, installmentCount: row.installmentCount, scheduledCents: row.scheduledCents }))).toEqual(report.byDueMonth);
    expect((result.byPaymentSchedule as any[]).map((row) => ({ key: row.paymentSchedule, invoiceCount: row.invoiceCount, installmentCount: row.installmentCount, scheduledCents: row.scheduledCents }))).toEqual(report.byPaymentSchedule);
    expect(result.invoicedSalesCents).toBe(report.invoicedSalesCents);
    expect(report.reconciled).toBe(true);
    expect(result.reconciled).toBe(true);
    // Installments reconcile to invoiced sales, and breakdowns sum to totals.
    expect(result.totals.scheduledCents).toBe(result.invoicedSalesCents);
    expect((result.byDueMonth as any[]).reduce((sum, row) => sum + row.scheduledCents, 0)).toBe(result.totals.scheduledCents);
    expect((result.byPaymentSchedule as any[]).reduce((sum, row) => sum + row.invoiceCount, 0)).toBe(result.totals.invoiceCount);
    expect(result.notes).toContain("NO_PAYMENT_DATA");
  });

  test("the product filter is refused with FILTER_SELECTS_LINES, as in Project 1", async () => {
    expect((await tools.fail("scheduled_collections", { period: "calendar-year:2025", productId: "P102" })).code).toBe("FILTER_SELECTS_LINES");
    expect((await tools.fail("installments_due", { duePeriod: "calendar-year:2025", productId: "P102" })).code).toBe("FILTER_SELECTS_LINES");
    const projectOne = await projectOneCollections(CHECKOUT_DIR, ref, { from: "2025-01-01", to: "2025-12-31", productId: "P102" });
    expect(projectOne).toMatchObject({ ok: false, code: "FILTER_SELECTS_LINES" });
  });

  test.each([
    ["October 2026, after the as-of date", "month:2026-10", { from: "2026-10-01", to: "2026-10-31" }, true],
    ["2025", "calendar-year:2025", { from: "2025-01-01", to: "2025-12-31" }, false],
    ["September 2026, ending after the as-of date", "month:2026-09", { from: "2026-09-01", to: "2026-09-30" }, true],
  ] as const)("installments_due equals Project 1's recomputed schedules: %s", async (_label, duePeriod, range, after) => {
    const result = await tools.call("installments_due", { duePeriod });
    const expected = await refInstallmentsDue(CHECKOUT_DIR, ref, range);
    expect(result.totals).toMatchObject({ scheduledCents: expected.scheduledCents, installmentCount: expected.installmentCount, invoiceCount: expected.invoiceCount });
    expect(new Map((result.byDueMonth as any[]).map((row) => [row.dueMonth, row.scheduledCents]))).toEqual(expected.byDueMonth);
    expect(result.duePeriod).toMatchObject({ ...range, endsAfterAsOf: after });
    // The as-of note is set when a due-date period ends after the as-of date.
    expect(result.notes).toEqual(after ? ["NO_PAYMENT_DATA", "INCLUDES_ONLY_INVOICES_BILLED_BY_AS_OF"] : ["NO_PAYMENT_DATA"]);
  });

  test("installments_due with filters equals the recomputation for the same invoices", async () => {
    const result = await tools.call("installments_due", { duePeriod: "quarter:2026-Q2", businessUnit: "HOME_GARDEN", segment: "retail chain" });
    const expected = await refInstallmentsDue(
      CHECKOUT_DIR,
      ref,
      { from: "2026-04-01", to: "2026-06-30" },
      (invoice) => invoice.businessUnit === "HOME_GARDEN" && ref.customers.get(invoice.customerId)!.segment === "retail chain",
    );
    expect(result.totals.scheduledCents).toBe(expected.scheduledCents);
    expect(result.totals.installmentCount).toBe(expected.installmentCount);
  });

  test("no output field name of any tool uses payment vocabulary", async () => {
    const results = [
      await tools.call("dataset_overview", {}),
      await tools.call("find_entities", { kind: "customer", query: "a" }),
      await tools.call("sales_totals", { period: "calendar-year:2025", groupBy: "product" }),
      await tools.call("compare_periods", { current: "year-to-date", previous: "same-period-previous-year", groupBy: "customer", limit: 3 }),
      await tools.call("customer_activity", { customerId: "C0012", period: "year-to-date" }),
      await tools.call("recurring_window_gaps", { window: "agro-season", referenceYears: [2023, 2024, 2025], currentYear: 2026 }),
      await tools.call("same_day_invoices", { period: { from: "2023-01-01", to: "2026-09-25" } }),
      await tools.call("invoice_details", { invoiceNumbers: ["000001"] }),
      await tools.call("resent_invoices", { period: { from: "2023-01-01", to: "2026-09-25" } }),
      await tools.call("scheduled_collections", { period: "month:2026-03" }),
      await tools.call("installments_due", { duePeriod: "month:2026-10" }),
    ];
    expect(results).toHaveLength(TOOL_NAMES.length);
    const keys = new Set<string>();
    for (const result of results) keysOf(result, keys);
    const offending = [...keys].filter((key) => PAYMENT_WORDS.test(key));
    expect(offending).toEqual([]);
  });
});

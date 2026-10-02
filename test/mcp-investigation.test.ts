import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadReplayedDataset, type RefDataset } from "../evals/reference/replay.ts";
import {
  firstBillingDates,
  refCompare,
  refCustomerActivity,
  refResent,
  refSameDay,
  refWindow,
  refWindowGaps,
} from "../evals/reference/investigation.ts";
import { consecutiveNumbers } from "../src/mcp/tools/same-day-invoices.ts";
import { changeBasisPoints } from "../src/shared/money.ts";
import { blackFriday, mothersDay, WINDOW_NAMES, windowDates, windowStatus } from "../src/shared/windows.ts";
import { describeDatabase } from "./support/database.ts";
import { CHECKOUT_DIR, toolHarness, type ToolHarness } from "./support/tools.ts";

describe("named windows", () => {
  test.each([
    [2023, "2023-05-14", "2023-11-24"],
    [2024, "2024-05-12", "2024-11-29"],
    [2025, "2025-05-11", "2025-11-28"],
    [2026, "2026-05-10", "2026-11-27"],
    [2027, "2027-05-09", "2027-11-26"],
  ])("%i: Mother's Day %s, Black Friday %s", (year, mother, friday) => {
    expect(mothersDay(year)).toBe(mother);
    expect(blackFriday(year)).toBe(friday);
  });

  test("each window's dates per year, and the same dates from the independent reference", () => {
    expect(windowDates("agro-season", 2026)).toEqual({ from: "2026-05-01", to: "2026-10-31" });
    expect(windowDates("mothers-day-lead", 2026)).toEqual({ from: "2026-04-19", to: "2026-05-09" });
    expect(windowDates("black-friday-lead", 2025)).toEqual({ from: "2025-11-07", to: "2025-11-27" });
    expect(windowDates("christmas-lead", 2024)).toEqual({ from: "2024-12-04", to: "2024-12-24" });
    for (const name of WINDOW_NAMES) for (let year = 2020; year <= 2030; year += 1) expect(windowDates(name, year)).toEqual(refWindow(name, year));
  });

  test("the current window's status relative to the as-of date", () => {
    const asOf = "2026-09-25";
    expect(windowStatus(windowDates("agro-season", 2026), asOf)).toBe("in-progress");
    expect(windowStatus(windowDates("mothers-day-lead", 2026), asOf)).toBe("complete");
    expect(windowStatus(windowDates("black-friday-lead", 2026), asOf)).toBe("not-started");
    expect(windowStatus({ from: "2026-09-01", to: asOf }, asOf)).toBe("complete");
  });
});

describe("consecutive invoice numbers", () => {
  test.each([
    [["003441", "003442"], true],
    [["003442", "003441"], true],
    [["000099", "000100", "000101"], true],
    [["003441", "003443"], false],
    [["003441"], false],
    [["A1", "A2"], false],
    [["003441", "003441"], false],
  ])("%j → %s", (numbers, expected) => {
    expect(consecutiveNumbers(numbers)).toBe(expected);
  });
});

describeDatabase("investigation tools", () => {
  let tools: ToolHarness;
  let ref: RefDataset;
  beforeAll(async () => {
    tools = await toolHarness();
    ref = await loadReplayedDataset(CHECKOUT_DIR);
  });
  afterAll(() => tools.close());

  describe("compare_periods", () => {
    test("same period of the previous year is the cut current period one year earlier", async () => {
      const result = await tools.call("compare_periods", { current: "year-to-date", previous: "same-period-previous-year" });
      expect(result.current).toMatchObject({ from: "2026-01-01", to: "2026-09-25" });
      expect(result.previous).toEqual({ preset: "same-period-previous-year", from: "2025-01-01", to: "2025-09-25", cutAtAsOf: false });
      const cut = await tools.call("compare_periods", { current: "calendar-year:2026", previous: "same-period-previous-year" });
      expect(cut.previous).toMatchObject({ from: "2025-01-01", to: "2025-09-25" });
      expect(cut.notes).toContain("PERIOD_CUT_AT_AS_OF");
    });

    test("29 February maps to 28 February", async () => {
      const result = await tools.call("compare_periods", { current: { from: "2024-02-01", to: "2024-02-29" }, previous: "same-period-previous-year" });
      expect(result.previous).toMatchObject({ from: "2023-02-01", to: "2023-02-28" });
      const leap = await tools.call("compare_periods", { current: { from: "2024-02-29", to: "2024-03-31" }, previous: "same-period-previous-year" });
      expect(leap.previous).toMatchObject({ from: "2023-02-28", to: "2023-03-31" });
    });

    test("no previous sales gives null basis points and NO_PREVIOUS_SALES", async () => {
      const result = await tools.call("compare_periods", {
        current: "calendar-year:2023",
        previous: { from: "2022-01-01", to: "2022-12-31" },
        groupBy: "businessUnit",
      });
      expect(result.totals).toMatchObject({ changeBasisPoints: null, changePercent: null });
      expect(result.notes).toContain("NO_PREVIOUS_SALES");
      for (const group of result.groups) expect(group).toMatchObject({ status: "new", changeBasisPoints: null, notes: ["NO_PREVIOUS_SALES"] });
    });

    test("every group equals RC for each grouping and filter", async () => {
      const current = { from: "2026-01-01", to: "2026-09-25" };
      const previous = { from: "2025-01-01", to: "2025-09-25" };
      for (const groupBy of ["businessUnit", "seller", "customer", "product"] as const) {
        for (const filters of [{}, { businessUnit: "AGRO" }, { segment: "retail chain" }, { productId: "P102" }]) {
          const result = await tools.call("compare_periods", { current: "year-to-date", previous: "same-period-previous-year", ...filters, groupBy, limit: 100 });
          const expected = refCompare(ref, current, previous, filters, groupBy);
          const shown = (result.groups as any[]).map((group) => ({
            key: group.key,
            previousSalesCents: group.previous.salesCents,
            previousInvoices: group.previous.invoiceCount,
            currentSalesCents: group.current.salesCents,
            currentInvoices: group.current.invoiceCount,
          }));
          const remainder = result.otherGroups ? 1 : 0;
          expect(shown.length + (remainder ? result.otherGroups.groupCount : 0)).toBe(expected.length);
          for (const row of shown) expect(expected).toContainEqual(row);
          for (const group of result.groups) {
            expect(group.changeCents).toBe(group.current.salesCents - group.previous.salesCents);
            expect(group.changeBasisPoints).toBe(changeBasisPoints(group.previous.salesCents, group.current.salesCents));
          }
          const sum = (side: "previous" | "current") =>
            (result.groups as any[]).reduce((total, group) => total + group[side].salesCents, 0) + (result.otherGroups?.[side].salesCents ?? 0);
          expect(sum("previous")).toBe(result.totals.previous.salesCents);
          expect(sum("current")).toBe(result.totals.current.salesCents);
        }
      }
    });

    test("absolute and relative ordering differ, and both are sorted", async () => {
      const args = { current: "year-to-date", previous: "same-period-previous-year", groupBy: "customer", limit: 100 };
      const absolute = (await tools.call("compare_periods", args)).groups as any[];
      const relative = (await tools.call("compare_periods", { ...args, sortBy: "relativeChange" })).groups as any[];
      for (let index = 1; index < absolute.length; index += 1) expect(absolute[index].changeCents).toBeGreaterThanOrEqual(absolute[index - 1].changeCents);
      const finite = relative.filter((group) => group.changeBasisPoints !== null);
      for (let index = 1; index < finite.length; index += 1) {
        expect(finite[index].changeBasisPoints).toBeGreaterThanOrEqual(finite[index - 1].changeBasisPoints);
      }
      // Nulls (no previous sales) sort last.
      expect(relative.findIndex((group) => group.changeBasisPoints === null)).toBeGreaterThanOrEqual(finite.length === relative.length ? -1 : finite.length);
      // The largest absolute drop is not the largest relative drop: smaller accounts fell further in relative terms.
      expect(absolute[0].key).not.toBe(relative[0].key);
      expect(relative[0].changeBasisPoints).toBeLessThan(absolute[0].changeBasisPoints);
      const desc = (await tools.call("compare_periods", { ...args, order: "desc" })).groups as any[];
      for (let index = 1; index < desc.length; index += 1) expect(desc[index].changeCents).toBeLessThanOrEqual(desc[index - 1].changeCents);
      expect(desc[0].changeCents).toBeGreaterThan(0);
    });

    test("status filters, and firstPurchase equals the customers whose first billing date falls in the period", async () => {
      const args = { current: "year-to-date", previous: "same-period-previous-year", groupBy: "customer", limit: 100 };
      const first = firstBillingDates(ref);
      const expected = [...first.entries()].filter(([, date]) => date >= "2026-01-01").map(([id]) => id).sort();
      const result = await tools.call("compare_periods", { ...args, status: "firstPurchase" });
      expect((result.groups as any[]).map((group) => group.key).sort()).toEqual(expected);
      expect(result.groupsCoverTotals).toBe(false);
      for (const group of result.groups) expect(group).toMatchObject({ status: "new", firstPurchaseInCurrentPeriod: true, changeBasisPoints: null });
      const absent = await tools.call("compare_periods", { ...args, current: "month:2026-08", previous: "month:2026-07", status: "absent" });
      expect(absent.groups.length).toBeGreaterThan(0);
      for (const group of absent.groups) expect(group).toMatchObject({ status: "absent", changeBasisPoints: -10000, current: { salesCents: 0 } });
      expect((await tools.fail("compare_periods", { ...args, groupBy: "seller", status: "firstPurchase" })).code).toBe("INPUT_INVALID");
    });
  });

  describe("customer_activity", () => {
    test("lists every period with zeros and equals RC", async () => {
      const customer = "C0255";
      const result = await tools.call("customer_activity", { customerId: customer, period: { from: "2023-01-01", to: "2026-09-25" }, grain: "month" });
      expect(result.periods).toHaveLength(45);
      const expected = refCustomerActivity(ref, customer, { from: "2023-01-01", to: "2026-09-25" }, "month");
      for (const row of result.periods) {
        expect({ salesCents: row.salesCents, invoiceCount: row.invoiceCount, lineCount: row.lineCount }).toEqual(
          expected.get(row.period) ?? { salesCents: 0, invoiceCount: 0, lineCount: 0 },
        );
      }
      expect(result.notes).toContain("GAP_NOT_CAUSE");
      expect(result.totals.periodsWithPurchases + result.totals.periodsWithoutPurchases).toBe(45);
      const years = await tools.call("customer_activity", { customerId: customer, period: { from: "2023-01-01", to: "2026-09-25" }, grain: "year" });
      expect((years.periods as any[]).map((row) => row.period)).toEqual(["2023", "2024", "2025", "2026"]);
      expect(years.totals.salesCents).toBe(result.totals.salesCents);
      expect(await tools.fail("customer_activity", { customerId: "C9999", period: "year-to-date" })).toMatchObject({ code: "NOT_FOUND", field: "customerId" });
    });
  });

  describe("recurring_window_gaps", () => {
    test.each([
      ["agro-season", [2023, 2024, 2025], 2026, { businessUnit: "AGRO" }],
      ["mothers-day-lead", [2023, 2024, 2025], 2026, { segment: "retail chain" }],
      ["mothers-day-lead", [2023, 2024, 2025], 2026, {}],
      ["christmas-lead", [2023, 2024], 2025, {}],
      ["black-friday-lead", [2024, 2025], 2026, { businessUnit: "HOME_GARDEN" }],
    ] as const)("%s %j → %i %j equals RC", async (window, referenceYears, currentYear, filters) => {
      const result = await tools.call("recurring_window_gaps", { window, referenceYears, currentYear, ...filters, limit: 100 });
      expect((result.customers as any[]).map((customer) => customer.customerId).sort()).toEqual(
        refWindowGaps(ref, window, [...referenceYears], currentYear, filters),
      );
      for (const customer of result.customers) {
        expect(customer.referenceWindows.every((window: any) => window.salesCents > 0)).toBe(true);
        expect(customer.currentWindowSalesCents).toBe(0);
      }
    });

    test("reports the current window's status", async () => {
      const season = await tools.call("recurring_window_gaps", { window: "agro-season", referenceYears: [2025], currentYear: 2026 });
      expect(season.currentWindow).toEqual({ year: 2026, from: "2026-05-01", to: "2026-09-25", status: "in-progress", cutAtAsOf: true, requestedTo: "2026-10-31" });
      expect(season.notes).toEqual(["GAP_NOT_CAUSE", "CURRENT_WINDOW_IN_PROGRESS"]);
      const friday = await tools.call("recurring_window_gaps", { window: "black-friday-lead", referenceYears: [2025], currentYear: 2026 });
      expect(friday.currentWindow.status).toBe("not-started");
      expect(friday.notes).toContain("CURRENT_WINDOW_NOT_STARTED");
      const mother = await tools.call("recurring_window_gaps", { window: "mothers-day-lead", referenceYears: [2025], currentYear: 2026 });
      expect(mother.currentWindow.status).toBe("complete");
      expect(await tools.fail("recurring_window_gaps", { window: "agro-season", referenceYears: [2026], currentYear: 2025 })).toMatchObject({
        code: "PERIOD_INVALID",
        reason: "REFERENCE_WINDOW_NOT_COMPLETE",
      });
      expect((await tools.fail("recurring_window_gaps", { window: "agro-season", referenceYears: [1, 2, 3, 4, 5, 6], currentYear: 2026 })).code).toBe("INPUT_INVALID");
    });
  });

  describe("same_day_invoices and resent_invoices", () => {
    const whole = { from: "2023-01-01", to: "2026-09-25" };

    test("same-day groups equal RC", async () => {
      const result = await tools.call("same_day_invoices", { period: whole, limit: 100 });
      expect((result.groups as any[]).map((group) => ({
        customerId: group.customerId,
        billingDate: group.billingDate,
        invoiceNumbers: group.invoices.map((invoice: any) => invoice.invoiceNumber),
      }))).toEqual(refSameDay(ref, whole));
      for (const group of result.groups) {
        expect(group.totalSalesCents).toBe(group.invoices.reduce((sum: number, invoice: any) => sum + invoice.salesCents, 0));
      }
      expect((await tools.fail("same_day_invoices", { period: whole, productId: "P102" })).code).toBe("FILTER_SELECTS_LINES");
    });

    test("resent-invoice detection equals the invoices delivered more than once in the replayed deliveries", async () => {
      const result = await tools.call("resent_invoices", { period: whole, limit: 100 });
      expect((result.invoices as any[]).map((invoice) => ({
        invoiceNumber: invoice.invoiceNumber,
        salesCents: invoice.currentSalesCents,
        deliveryId: invoice.lastWrittenBy.deliveryId,
      }))).toEqual(refResent(ref));
      expect(result.notes).toEqual(["PREVIOUS_VERSION_NOT_STORED"]);
      for (const invoice of result.invoices) expect(invoice.lastWrittenBy.deliveryMonth > invoice.billingDate.slice(0, 7)).toBe(true);
      expect((await tools.fail("resent_invoices", { period: whole, productId: "P102" })).code).toBe("FILTER_SELECTS_LINES");
    });
  });
});

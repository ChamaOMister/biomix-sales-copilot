import { describe, expect, test } from "vitest";
import { addDays, dayOfWeek, daysBetween, monthsBetween, shiftYears } from "../src/shared/dates.ts";
import { basisPoints, changeBasisPoints, formatBasisPoints, formatBrl } from "../src/shared/money.ts";
import { resolvePeriod } from "../src/shared/periods.ts";

const AS_OF = "2026-09-25";

describe("period presets", () => {
  test.each([
    ["calendar-year:2024", "2024-01-01", "2024-12-31"],
    ["quarter:2025-Q1", "2025-01-01", "2025-03-31"],
    ["quarter:2025-Q2", "2025-04-01", "2025-06-30"],
    ["quarter:2025-Q3", "2025-07-01", "2025-09-30"],
    ["quarter:2025-Q4", "2025-10-01", "2025-12-31"],
    ["quarter:2024-Q1", "2024-01-01", "2024-03-31"],
    ["month:2024-02", "2024-02-01", "2024-02-29"],
    ["month:2025-02", "2025-02-01", "2025-02-28"],
    ["month:2025-12", "2025-12-01", "2025-12-31"],
    ["year-to-date", "2026-01-01", "2026-09-25"],
    ["last-closed-month", "2026-08-01", "2026-08-31"],
  ])("%s resolves to %s – %s", (preset, from, to) => {
    expect(resolvePeriod(preset, AS_OF)).toEqual({ ok: true, period: { preset, from, to, cutAtAsOf: false } });
  });

  test("a period ending after the as-of date is cut at it and flagged", () => {
    expect(resolvePeriod("quarter:2026-Q3", AS_OF)).toEqual({
      ok: true,
      period: { preset: "quarter:2026-Q3", from: "2026-07-01", to: AS_OF, cutAtAsOf: true, requestedTo: "2026-09-30" },
    });
    expect(resolvePeriod("calendar-year:2026", AS_OF)).toMatchObject({ ok: true, period: { to: AS_OF, cutAtAsOf: true } });
    expect(resolvePeriod({ from: "2026-09-01", to: "2026-12-31" }, AS_OF)).toMatchObject({
      ok: true,
      period: { preset: null, from: "2026-09-01", to: AS_OF, cutAtAsOf: true },
    });
  });

  test("a period ending on the as-of date is not flagged", () => {
    expect(resolvePeriod({ from: "2026-09-01", to: AS_OF }, AS_OF)).toMatchObject({ ok: true, period: { cutAtAsOf: false } });
  });

  test("a period starting after the as-of date is refused", () => {
    expect(resolvePeriod("month:2026-10", AS_OF)).toEqual({ ok: false, reason: "STARTS_AFTER_AS_OF" });
    expect(resolvePeriod({ from: "2026-09-26", to: "2026-09-30" }, AS_OF)).toEqual({ ok: false, reason: "STARTS_AFTER_AS_OF" });
  });

  test("last-closed-month is the as-of month when the as-of date is its last day", () => {
    expect(resolvePeriod("last-closed-month", "2024-02-29")).toMatchObject({ ok: true, period: { from: "2024-02-01", to: "2024-02-29" } });
    expect(resolvePeriod("last-closed-month", "2026-01-15")).toMatchObject({ ok: true, period: { from: "2025-12-01", to: "2025-12-31" } });
  });

  test("invalid input is refused with a reason", () => {
    expect(resolvePeriod("month:2025-13", AS_OF)).toEqual({ ok: false, reason: "UNKNOWN_PRESET" });
    expect(resolvePeriod("last-year", AS_OF)).toEqual({ ok: false, reason: "UNKNOWN_PRESET" });
    expect(resolvePeriod({ from: "2025-02-29", to: "2025-03-01" }, AS_OF)).toEqual({ ok: false, reason: "INVALID_DATE" });
    expect(resolvePeriod({ from: "2025-03-02", to: "2025-03-01" }, AS_OF)).toEqual({ ok: false, reason: "FROM_AFTER_TO" });
  });
});

describe("dates", () => {
  test("29 February maps to 28 February in a year without it", () => {
    expect(shiftYears("2024-02-29", -1)).toBe("2023-02-28");
    expect(shiftYears("2024-02-29", -4)).toBe("2020-02-29");
    expect(shiftYears("2026-09-25", -1)).toBe("2025-09-25");
  });

  test("day arithmetic and weekdays", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2023-12-31", 1)).toBe("2024-01-01");
    expect(addDays("2026-05-10", -21)).toBe("2026-04-19");
    expect(daysBetween("2025-01-01", "2026-01-01")).toBe(365);
    expect(dayOfWeek("2026-05-10")).toBe(0);
    expect(dayOfWeek("2025-11-28")).toBe(5);
    expect(monthsBetween("2025-11-15", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("money and basis points", () => {
  test.each([
    [0, "R$ 0.00"],
    [5, "R$ 0.05"],
    [123456, "R$ 1,234.56"],
    [100000000, "R$ 1,000,000.00"],
    [-123456, "-R$ 1,234.56"],
    [-5, "-R$ 0.05"],
    [2598406140, "R$ 25,984,061.40"],
  ])("formatBrl(%i) is %s", (cents, text) => {
    expect(formatBrl(cents)).toBe(text);
  });

  test("formatBrl accepts bigint beyond the safe range and rejects unsafe numbers", () => {
    expect(formatBrl(123456789012345678901n)).toBe("R$ 1,234,567,890,123,456,789.01");
    expect(() => formatBrl(2 ** 60)).toThrow(RangeError);
  });

  test("basis points round half away from zero, including negative halves", () => {
    expect(basisPoints(1, 3)).toBe(3333);
    expect(basisPoints(2, 3)).toBe(6667);
    expect(basisPoints(1, 20000)).toBe(1); // 0.5 → 1
    expect(basisPoints(-1, 20000)).toBe(-1); // -0.5 → -1
    expect(basisPoints(1, -20000)).toBe(-1);
    expect(basisPoints(3, 20000)).toBe(2); // 1.5 → 2
    expect(basisPoints(-3, 20000)).toBe(-2); // -1.5 → -2
    expect(basisPoints(-1, 30000)).toBe(0); // -0.33 → 0
    expect(basisPoints(0, 7)).toBe(0);
    expect(basisPoints(5, 0)).toBeNull();
  });

  test("change in basis points is relative to the previous value", () => {
    expect(changeBasisPoints(55280620, 22134270)).toBe(-5996);
    expect(changeBasisPoints(38647030, 15459000)).toBe(-6000);
    expect(changeBasisPoints(100, 150)).toBe(5000);
    expect(changeBasisPoints(0, 150)).toBeNull();
  });

  test("basis points display as percentages", () => {
    expect(formatBasisPoints(1234)).toBe("12.34%");
    expect(formatBasisPoints(5)).toBe("0.05%");
    expect(formatBasisPoints(-5996)).toBe("-59.96%");
    expect(formatBasisPoints(-5)).toBe("-0.05%");
    expect(formatBasisPoints(1234, { signed: true })).toBe("+12.34%");
    expect(formatBasisPoints(0, { signed: true })).toBe("0.00%");
    expect(formatBasisPoints(1234567)).toBe("12,345.67%");
  });
});

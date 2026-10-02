/**
 * Periods for tool inputs (decision 001, section 2.1): an inclusive `{ from, to }` or a preset
 * resolved against the dataset's as-of date, never the system clock. A period that ends after the
 * as-of date is cut at it and flagged `cutAtAsOf`; one that starts after it is refused. Pure.
 */
import { formatDate, isValidDate, lastDayOfMonth, parseDate, type CalendarDate } from "./dates.ts";

export type PeriodInput = string | { from: string; to: string };

export interface ResolvedPeriod {
  /** The preset as given, or null for an explicit range. */
  preset: string | null;
  from: CalendarDate;
  to: CalendarDate;
  /** The requested end was after the as-of date, so `to` is the as-of date. */
  cutAtAsOf: boolean;
  /** Present when cut: the end that was requested. */
  requestedTo?: CalendarDate;
}

export type PeriodError = "UNKNOWN_PRESET" | "INVALID_DATE" | "FROM_AFTER_TO" | "STARTS_AFTER_AS_OF";

export type PeriodResult = { ok: true; period: ResolvedPeriod } | { ok: false; reason: PeriodError };

export const PERIOD_PRESET_PATTERN =
  "^(year-to-date|last-closed-month|calendar-year:\\d{4}|quarter:\\d{4}-Q[1-4]|month:\\d{4}-(0[1-9]|1[0-2]))$";

/** The dates a preset names, before cutting at the as-of date. */
export function presetRange(preset: string, asOf: CalendarDate): { from: CalendarDate; to: CalendarDate } | null {
  const today = parseDate(asOf);
  if (!today) return null;
  if (preset === "year-to-date") return { from: formatDate(today.year, 1, 1), to: asOf };
  if (preset === "last-closed-month") {
    // The as-of month is closed only when the as-of date is its last day.
    if (asOf === lastDayOfMonth(today.year, today.month)) {
      return { from: formatDate(today.year, today.month, 1), to: asOf };
    }
    const [year, month] = today.month === 1 ? [today.year - 1, 12] : [today.year, today.month - 1];
    return { from: formatDate(year, month, 1), to: lastDayOfMonth(year, month) };
  }
  let match = /^calendar-year:(\d{4})$/.exec(preset);
  if (match) {
    const year = Number(match[1]);
    return year >= 1 ? { from: formatDate(year, 1, 1), to: formatDate(year, 12, 31) } : null;
  }
  match = /^quarter:(\d{4})-Q([1-4])$/.exec(preset);
  if (match) {
    const year = Number(match[1]);
    const firstMonth = (Number(match[2]) - 1) * 3 + 1;
    return year >= 1 ? { from: formatDate(year, firstMonth, 1), to: lastDayOfMonth(year, firstMonth + 2) } : null;
  }
  match = /^month:(\d{4})-(\d{2})$/.exec(preset);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year >= 1 && month >= 1 && month <= 12 ? { from: formatDate(year, month, 1), to: lastDayOfMonth(year, month) } : null;
  }
  return null;
}

/**
 * A due-date period: presets still resolve against the as-of date, but the period is neither cut
 * nor refused after it, because installments of invoices already billed fall due later.
 */
export function resolveDuePeriod(
  input: PeriodInput,
  asOf: CalendarDate,
): { ok: true; period: ResolvedPeriod & { endsAfterAsOf: boolean } } | { ok: false; reason: Exclude<PeriodError, "STARTS_AFTER_AS_OF"> } {
  let range: { from: CalendarDate; to: CalendarDate } | null;
  if (typeof input === "string") {
    range = presetRange(input, asOf);
    if (!range) return { ok: false, reason: "UNKNOWN_PRESET" };
  } else {
    if (!isValidDate(input.from) || !isValidDate(input.to)) return { ok: false, reason: "INVALID_DATE" };
    range = { from: input.from, to: input.to };
  }
  if (range.from > range.to) return { ok: false, reason: "FROM_AFTER_TO" };
  return {
    ok: true,
    period: { preset: typeof input === "string" ? input : null, ...range, cutAtAsOf: false, endsAfterAsOf: range.to > asOf },
  };
}

export function resolvePeriod(input: PeriodInput, asOf: CalendarDate): PeriodResult {
  let preset: string | null = null;
  let range: { from: CalendarDate; to: CalendarDate } | null;
  if (typeof input === "string") {
    preset = input;
    range = presetRange(input, asOf);
    if (!range) return { ok: false, reason: "UNKNOWN_PRESET" };
  } else {
    if (!isValidDate(input.from) || !isValidDate(input.to)) return { ok: false, reason: "INVALID_DATE" };
    range = { from: input.from, to: input.to };
  }
  if (range.from > range.to) return { ok: false, reason: "FROM_AFTER_TO" };
  if (range.from > asOf) return { ok: false, reason: "STARTS_AFTER_AS_OF" };
  if (range.to > asOf) return { ok: true, period: { preset, from: range.from, to: asOf, cutAtAsOf: true, requestedTo: range.to } };
  return { ok: true, period: { preset, from: range.from, to: range.to, cutAtAsOf: false } };
}

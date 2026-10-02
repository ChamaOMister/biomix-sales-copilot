/**
 * Named recurring windows (decision 001, section 2.2). Proposed defaults taken from Project 1's
 * business context, not company policy. Dates are computed here and passed to SQL as parameters.
 * Pure.
 */
import { addDays, dayOfWeek, formatDate, type CalendarDate } from "./dates.ts";

export const WINDOW_NAMES = ["agro-season", "mothers-day-lead", "black-friday-lead", "christmas-lead"] as const;
export type WindowName = (typeof WINDOW_NAMES)[number];

export const WINDOW_DESCRIPTIONS: Readonly<Record<WindowName, string>> = {
  "agro-season": "1 May to 31 October",
  "mothers-day-lead": "the 21 days before Mother's Day (the second Sunday of May), not including the day itself",
  "black-friday-lead": "the 21 days before Black Friday (the Friday after the fourth Thursday of November), not including the day itself",
  "christmas-lead": "the 21 days before 25 December, not including the day itself",
};

const LEAD_DAYS = 21;

/** The `n`-th given weekday (0 = Sunday) of a month. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): CalendarDate {
  const first = formatDate(year, month, 1);
  const offset = (weekday - dayOfWeek(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

export function mothersDay(year: number): CalendarDate {
  return nthWeekday(year, 5, 0, 2);
}

export function blackFriday(year: number): CalendarDate {
  return addDays(nthWeekday(year, 11, 4, 4), 1);
}

function leadUpTo(day: CalendarDate): { from: CalendarDate; to: CalendarDate } {
  return { from: addDays(day, -LEAD_DAYS), to: addDays(day, -1) };
}

export function windowDates(name: WindowName, year: number): { from: CalendarDate; to: CalendarDate } {
  switch (name) {
    case "agro-season":
      return { from: formatDate(year, 5, 1), to: formatDate(year, 10, 31) };
    case "mothers-day-lead":
      return leadUpTo(mothersDay(year));
    case "black-friday-lead":
      return leadUpTo(blackFriday(year));
    case "christmas-lead":
      return leadUpTo(formatDate(year, 12, 25));
  }
}

export type WindowStatus = "complete" | "in-progress" | "not-started";

export function windowStatus(window: { from: CalendarDate; to: CalendarDate }, asOf: CalendarDate): WindowStatus {
  if (window.to <= asOf) return "complete";
  return window.from <= asOf ? "in-progress" : "not-started";
}

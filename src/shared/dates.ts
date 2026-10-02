/**
 * Calendar dates as ISO `YYYY-MM-DD` strings, with integer arithmetic only: no `Date` object, so
 * no time zone or system clock is involved. Pure.
 */

export type CalendarDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function formatDate(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Year, month and day of a valid ISO date in years 1–9999, or null. */
export function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isValidDate(value: string): boolean {
  return parseDate(value) !== null;
}

function requireDate(value: CalendarDate): { year: number; month: number; day: number } {
  const parsed = parseDate(value);
  if (!parsed) throw new RangeError("Invalid calendar date");
  return parsed;
}

// Days since 1970-01-01 in the proleptic Gregorian calendar (H. Hinnant's civil-date algorithm).
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const { year, month, day } = requireDate(date);
  const [y, m, d] = civilFromDays(daysFromCivil(year, month, day) + days);
  return formatDate(y, m, d);
}

/** Day of the week, 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: CalendarDate): number {
  const { year, month, day } = requireDate(date);
  return (((daysFromCivil(year, month, day) + 4) % 7) + 7) % 7;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const a = requireDate(from);
  const b = requireDate(to);
  return daysFromCivil(b.year, b.month, b.day) - daysFromCivil(a.year, a.month, a.day);
}

export function monthOf(date: CalendarDate): string {
  return date.slice(0, 7);
}

export function yearOf(date: CalendarDate): number {
  return requireDate(date).year;
}

export function lastDayOfMonth(year: number, month: number): CalendarDate {
  return formatDate(year, month, daysInMonth(year, month));
}

export function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a <= b ? a : b;
}

export function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a >= b ? a : b;
}

/** Every `YYYY-MM` from the month of `from` to the month of `to`, inclusive. */
export function monthsBetween(from: CalendarDate, to: CalendarDate): string[] {
  const start = requireDate(from);
  const end = requireDate(to);
  const months: string[] = [];
  for (let year = start.year, month = start.month; year < end.year || (year === end.year && month <= end.month); ) {
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * The same calendar day one or more years earlier. 29 February maps to 28 February in a year
 * without it.
 */
export function shiftYears(date: CalendarDate, years: number): CalendarDate {
  const { year, month, day } = requireDate(date);
  const target = year + years;
  return formatDate(target, month, Math.min(day, daysInMonth(target, month)));
}

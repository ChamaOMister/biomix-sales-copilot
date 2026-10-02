/**
 * Conventions shared by every tool (decision 001, section 2.1): fixed error codes with fixed
 * messages that never echo input values, fixed note codes, limits, the result envelope and the
 * domain labels. No file system or network access in src/mcp/.
 */
import type pg from "pg";
import type { z } from "zod";
import type { ResolvedPeriod } from "../shared/periods.ts";

export const LIMITS = {
  idLength: 64,
  searchLength: 64,
  defaultRows: 20,
  maxRows: 100,
  maxMatches: 20,
  maxMonths: 48,
  maxInvoices: 10,
} as const;

export const BUSINESS_UNITS = ["AGRO", "HOME_GARDEN"] as const;
export type BusinessUnit = (typeof BUSINESS_UNITS)[number];
export const BUSINESS_UNIT_LABELS: Readonly<Record<string, string>> = { AGRO: "Agro", HOME_GARDEN: "Home & Garden" };

/** Project 1's payment schedules: labels as its data contract spells them, and calendar-day offsets. */
export const PAYMENT_SCHEDULES: readonly { code: string; label: string; dayOffsets: readonly number[] }[] = [
  { code: "UPFRONT", label: "Upfront", dayOffsets: [0] },
  { code: "NET_30", label: "30 Days", dayOffsets: [30] },
  { code: "INSTALLMENTS_30_60_90", label: "3 installments (30, 60 and 90 days)", dayOffsets: [30, 60, 90] },
  { code: "INSTALLMENTS_0_30_60_90", label: "4 installments (Upfront, 30, 60 and 90 days)", dayOffsets: [0, 30, 60, 90] },
];
export const PAYMENT_SCHEDULE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  PAYMENT_SCHEDULES.map((schedule) => [schedule.code, schedule.label]),
);

/** Fixed note codes. A note qualifies a result; it is never an error. */
export const NOTES = {
  /** The data has scheduled (contractual) installments only: no payments, receipts or balances. */
  NO_PAYMENT_DATA: "NO_PAYMENT_DATA",
  /** A period ended after the as-of date and was cut at it. */
  PERIOD_CUT_AT_AS_OF: "PERIOD_CUT_AT_AS_OF",
  /** A product filter selects that product's lines; invoices count when they contain it. */
  PRODUCT_FILTER_SELECTS_LINES: "PRODUCT_FILTER_SELECTS_LINES",
  /** Grouped by product: one invoice can appear in several groups, so invoice counts overlap. */
  GROUP_COUNTS_OVERLAP: "GROUP_COUNTS_OVERLAP",
  /** Some requested invoice numbers do not exist. */
  SOME_NOT_FOUND: "SOME_NOT_FOUND",
  /** No sales in the previous period, so no relative change can be computed. */
  NO_PREVIOUS_SALES: "NO_PREVIOUS_SALES",
  /** Replacement deletes the old lines, so a corrected invoice's earlier amounts are not stored. */
  PREVIOUS_VERSION_NOT_STORED: "PREVIOUS_VERSION_NOT_STORED",
  /** The current window has not ended by the as-of date. */
  CURRENT_WINDOW_IN_PROGRESS: "CURRENT_WINDOW_IN_PROGRESS",
  /** The current window starts after the as-of date. */
  CURRENT_WINDOW_NOT_STARTED: "CURRENT_WINDOW_NOT_STARTED",
  /** A due-date period ends after the as-of date: only invoices billed by then have installments. */
  INCLUDES_ONLY_INVOICES_BILLED_BY_AS_OF: "INCLUDES_ONLY_INVOICES_BILLED_BY_AS_OF",
  /** A purchasing gap is a fact about invoices, not evidence of churn or of its cause. */
  GAP_NOT_CAUSE: "GAP_NOT_CAUSE",
} as const;
export type Note = (typeof NOTES)[keyof typeof NOTES];

export const ERROR_CODES = [
  "INPUT_INVALID",
  "PERIOD_INVALID",
  "NOT_FOUND",
  "FILTER_SELECTS_LINES",
  "TIMEOUT",
  "DATABASE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INPUT_INVALID: "The input does not match the tool's input schema. See issues for the fields concerned.",
  PERIOD_INVALID: "The period cannot be used. See reason.",
  NOT_FOUND: "A requested ID does not exist in the dataset. See field.",
  FILTER_SELECTS_LINES:
    "Scheduled installments belong to whole invoices, and a product filter selects individual lines, so this tool refuses it. Remove the product filter.",
  TIMEOUT: "The query exceeded the database's statement timeout.",
  DATABASE_UNAVAILABLE: "The database could not be reached.",
  INTERNAL_ERROR: "The tool failed unexpectedly.",
};

export interface ToolErrorDetails {
  reason?: string;
  field?: string;
  issues?: { path: string; problem: string }[];
  asOf?: string;
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: ToolErrorDetails;
  constructor(code: ErrorCode, details: ToolErrorDetails = {}) {
    super(ERROR_MESSAGES[code]);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string } & ToolErrorDetails } {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

/** Maps a database failure to a tool error code; never exposes the driver's message. */
export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "57014") return new ToolError("TIMEOUT");
  if (
    typeof code === "string" &&
    (code.startsWith("08") || code.startsWith("57P") || code === "53300" || ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"].includes(code))
  ) {
    return new ToolError("DATABASE_UNAVAILABLE");
  }
  if (error instanceof Error && /Connection terminated|connect/i.test(error.message)) return new ToolError("DATABASE_UNAVAILABLE");
  return new ToolError("INTERNAL_ERROR");
}

/** Describes zod issues by field path and problem only; unknown field names are not repeated. */
export function inputError(issues: readonly z.core.$ZodIssue[]): ToolError {
  const problems = issues.map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "(input)";
    const problem: Record<string, string> = {
      invalid_type: "missing or wrong type",
      unrecognized_keys: "unknown field",
      too_big: "too long or too large",
      too_small: "too short or too small",
      invalid_format: "invalid format",
      invalid_value: "not one of the allowed values",
      invalid_union: "not a valid choice",
    };
    return { path, problem: problem[issue.code] ?? "invalid value" };
  });
  return new ToolError("INPUT_INVALID", { issues: problems.slice(0, 10) });
}

export interface DatasetInfo {
  asOf: string;
  coverageStartDate: string;
  source: { repository: string; tag: string; commit: string; seed: number };
}

export interface ToolContext {
  pool: pg.Pool;
  dataset: DatasetInfo;
}

/** Loads the provenance once at startup; tools read the as-of date from it, never from the clock. */
export async function loadDatasetInfo(pool: pg.Pool): Promise<DatasetInfo> {
  const { rows } = await pool.query<{
    repository: string;
    tag: string;
    source_commit: string;
    seed: string;
    as_of_date: string;
    coverage_start_date: string;
  }>("SELECT repository, tag, source_commit, seed::text, as_of_date, coverage_start_date FROM copilot.dataset_info");
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error("copilot.dataset_info must hold exactly one row");
  return {
    asOf: row.as_of_date,
    coverageStartDate: row.coverage_start_date,
    source: { repository: row.repository, tag: row.tag, commit: row.source_commit, seed: Number(row.seed) },
  };
}

/** Every result starts with the as-of date, the source and the notes. */
export function envelope<T extends object>(
  dataset: DatasetInfo,
  notes: readonly Note[],
  payload: T,
  rows?: { truncated: boolean; totalRows: number },
): { asOf: string; source: DatasetInfo["source"]; notes: Note[] } & T & { truncated: boolean; totalRows: number | null } {
  return {
    asOf: dataset.asOf,
    source: dataset.source,
    notes: [...new Set(notes)],
    ...payload,
    truncated: rows?.truncated ?? false,
    totalRows: rows?.totalRows ?? null,
  };
}

export function periodEcho(period: ResolvedPeriod): {
  preset: string | null;
  from: string;
  to: string;
  cutAtAsOf: boolean;
  requestedTo?: string;
} {
  return { ...period };
}

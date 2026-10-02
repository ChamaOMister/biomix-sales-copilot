/**
 * Input schemas shared by the tools, and the filters they translate to SQL. Every object schema
 * is strict: unknown fields are rejected. Filter IDs are checked to exist, so a mistyped ID gives
 * NOT_FOUND rather than an empty result.
 */
import type pg from "pg";
import { z } from "zod";
import { PERIOD_PRESET_PATTERN, resolvePeriod, type ResolvedPeriod } from "../shared/periods.ts";
import { BUSINESS_UNITS, LIMITS, ToolError, type DatasetInfo } from "./conventions.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const idSchema = (description: string) => z.string().min(1).max(LIMITS.idLength).describe(description);

export const periodSchema = z
  .union([
    z.string().regex(new RegExp(PERIOD_PRESET_PATTERN)).describe(
      "A preset resolved against the dataset's as-of date: year-to-date, last-closed-month, calendar-year:YYYY, quarter:YYYY-Qn or month:YYYY-MM.",
    ),
    z
      .strictObject({
        from: z.string().regex(DATE).describe("First day, inclusive (YYYY-MM-DD)."),
        to: z.string().regex(DATE).describe("Last day, inclusive (YYYY-MM-DD)."),
      })
      .describe("An explicit inclusive date range."),
  ])
  .describe("Billing period. A period ending after the as-of date is cut at it; one starting after it is refused.");

export const filterShape = {
  businessUnit: z.enum(BUSINESS_UNITS).optional().describe("AGRO or HOME_GARDEN."),
  sellerId: idSchema("Seller ID, for example from find_entities.").optional(),
  customerId: idSchema("Customer ID, for example from find_entities.").optional(),
  productId: idSchema("Product ID. Selects that product's invoice lines.").optional(),
  segment: z.string().min(1).max(LIMITS.searchLength).optional().describe("Customer segment, as listed by dataset_overview."),
};

export interface Filters {
  businessUnit?: string | undefined;
  sellerId?: string | undefined;
  customerId?: string | undefined;
  productId?: string | undefined;
  segment?: string | undefined;
}

export const limitSchema = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Maximum rows to return (1–${max}, default ${fallback}).`);

export function requirePeriod(input: z.infer<typeof periodSchema>, dataset: DatasetInfo): ResolvedPeriod {
  const result = resolvePeriod(input, dataset.asOf);
  if (!result.ok) throw new ToolError("PERIOD_INVALID", { reason: result.reason, asOf: dataset.asOf });
  return result.period;
}

/** Only the filters given, in a fixed order, for echoing. */
export function filterEcho(filters: Filters): Filters {
  const echo: Filters = {};
  for (const key of ["businessUnit", "sellerId", "customerId", "productId", "segment"] as const) {
    if (filters[key] !== undefined) echo[key] = filters[key];
  }
  return echo;
}

/** Raises NOT_FOUND for a filter ID or segment that does not exist. */
export async function checkFiltersExist(client: pg.PoolClient, filters: Filters): Promise<void> {
  const checks: [keyof Filters, string][] = [
    ["sellerId", "SELECT 1 FROM sellers WHERE seller_id = $1"],
    ["customerId", "SELECT 1 FROM customers WHERE customer_id = $1"],
    ["productId", "SELECT 1 FROM products WHERE product_id = $1"],
    ["segment", "SELECT 1 FROM customers WHERE segment = $1 LIMIT 1"],
  ];
  for (const [field, sql] of checks) {
    const value = filters[field];
    if (value === undefined) continue;
    const { rowCount } = await client.query(sql, [value]);
    if (!rowCount) throw new ToolError("NOT_FOUND", { field });
  }
}

/** SQL conditions on aliases `i` (invoices), `c` (customers) and `l` (lines), with bind parameters. */
export class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export function filterConditions(filters: Filters, params: SqlParams, options: { lines: boolean }): string[] {
  const conditions: string[] = [];
  if (filters.businessUnit !== undefined) conditions.push(`i.business_unit = ${params.add(filters.businessUnit)}`);
  if (filters.sellerId !== undefined) conditions.push(`i.seller_id = ${params.add(filters.sellerId)}`);
  if (filters.customerId !== undefined) conditions.push(`i.customer_id = ${params.add(filters.customerId)}`);
  if (filters.segment !== undefined) conditions.push(`c.segment = ${params.add(filters.segment)}`);
  if (filters.productId !== undefined) {
    if (!options.lines) throw new ToolError("FILTER_SELECTS_LINES");
    conditions.push(`l.product_id = ${params.add(filters.productId)}`);
  }
  return conditions;
}

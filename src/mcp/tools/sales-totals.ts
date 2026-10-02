import type pg from "pg";
import { z } from "zod";
import { monthsBetween, yearOf } from "../../shared/dates.ts";
import { basisPoints, formatBasisPoints, money } from "../../shared/money.ts";
import type { ResolvedPeriod } from "../../shared/periods.ts";
import { toSafeInteger } from "../../db/pool.ts";
import { BUSINESS_UNIT_LABELS, envelope, LIMITS, NOTES, PAYMENT_SCHEDULE_LABELS, ToolError, type Note } from "../conventions.ts";
import {
  checkFiltersExist,
  filterConditions,
  filterEcho,
  filterShape,
  limitSchema,
  periodSchema,
  requirePeriod,
  SqlParams,
  type Filters,
} from "../inputs.ts";
import { count, defineTool } from "../tool.ts";

export const SALES_GROUPS = ["none", "month", "year", "businessUnit", "seller", "customer", "product", "paymentSchedule", "segment"] as const;
export type SalesGroup = (typeof SALES_GROUPS)[number];

/** Key and label expressions per grouping, over the `b` rows below. Chosen from this fixed list only. */
export const GROUP_SQL: Record<Exclude<SalesGroup, "none">, { key: string; label: string | null }> = {
  month: { key: "to_char(b.billing_date, 'YYYY-MM')", label: null },
  year: { key: "to_char(b.billing_date, 'YYYY')", label: null },
  businessUnit: { key: "b.business_unit", label: null },
  seller: { key: "b.seller_id", label: "b.seller_name" },
  customer: { key: "b.customer_id", label: "b.customer_name" },
  product: { key: "b.product_id", label: "b.product_name" },
  paymentSchedule: { key: "b.payment_schedule", label: null },
  segment: { key: "b.segment", label: null },
};

/** Invoice lines in the period matching the filters, with the invoice, customer, seller and product attributes. */
export function salesLinesSql(period: { from: string; to: string }, filters: Filters, params: SqlParams): string {
  const conditions = [
    `i.billing_date BETWEEN ${params.add(period.from)}::date AND ${params.add(period.to)}::date`,
    ...filterConditions(filters, params, { lines: true }),
  ];
  return `
    SELECT i.invoice_number, i.billing_date, i.customer_id, i.seller_id, i.business_unit, i.payment_schedule,
           c.segment, c.name AS customer_name, s.name AS seller_name, l.product_id, p.name AS product_name,
           l.package_quantity, l.line_amount_cents, l.commission_amount_cents
    FROM invoices i
    JOIN invoice_lines l ON l.invoice_number = i.invoice_number
    JOIN customers c ON c.customer_id = i.customer_id
    JOIN sellers s ON s.seller_id = i.seller_id
    JOIN products p ON p.product_id = l.product_id
    WHERE ${conditions.join(" AND ")}`;
}

const AGGREGATES = `
  coalesce(sum(b.line_amount_cents), 0)::text AS sales,
  coalesce(sum(b.commission_amount_cents), 0)::text AS commission,
  count(DISTINCT b.invoice_number)::text AS invoices,
  count(*)::text AS lines,
  count(DISTINCT b.customer_id)::text AS customers,
  coalesce(sum(b.package_quantity), 0)::text AS packages`;

interface AggregateRow {
  sales: string;
  commission: string;
  invoices: string;
  lines: string;
  customers: string;
  packages: string;
}

export interface SalesFigures {
  salesCents: number;
  commissionCents: number;
  invoiceCount: number;
  lineCount: number;
  customerCount: number;
  packageQuantity: number;
}

function figures(row: AggregateRow): SalesFigures {
  return {
    salesCents: toSafeInteger(row.sales),
    commissionCents: toSafeInteger(row.commission),
    invoiceCount: count(row.invoices),
    lineCount: count(row.lines),
    customerCount: count(row.customers),
    packageQuantity: toSafeInteger(row.packages),
  };
}

const ZERO: SalesFigures = { salesCents: 0, commissionCents: 0, invoiceCount: 0, lineCount: 0, customerCount: 0, packageQuantity: 0 };

function displayFigures(value: SalesFigures, total: number, withPackages: boolean) {
  const share = basisPoints(value.salesCents, total);
  return {
    ...money("sales", value.salesCents),
    shareBasisPoints: share,
    sharePercent: share === null ? null : formatBasisPoints(share),
    ...money("commission", value.commissionCents),
    invoiceCount: value.invoiceCount,
    lineCount: value.lineCount,
    customerCount: value.customerCount,
    ...(withPackages ? { packageQuantity: value.packageQuantity } : {}),
  };
}

export function labelFor(groupBy: SalesGroup, key: string, label: string | null): string | null {
  if (groupBy === "businessUnit") return BUSINESS_UNIT_LABELS[key] ?? null;
  if (groupBy === "paymentSchedule") return PAYMENT_SCHEDULE_LABELS[key] ?? null;
  return label;
}

export interface SalesGroupRow {
  key: string;
  label: string | null;
  figures: SalesFigures;
}

export interface SalesTotalsData {
  totals: SalesFigures;
  groups: SalesGroupRow[];
  /** Everything outside `groups`; null when nothing is left over. */
  other: (SalesFigures & { groupCount: number }) | null;
  groupCount: number;
}

/** Totals plus the largest groups and the remainder, so the groups always add up to the totals. */
export async function querySalesTotals(
  client: pg.PoolClient,
  period: { from: string; to: string },
  filters: Filters,
  groupBy: SalesGroup,
  limit: number,
): Promise<SalesTotalsData> {
  const params = new SqlParams();
  const lines = salesLinesSql(period, filters, params);
  const totalRow = (await client.query<AggregateRow>(`WITH b AS (${lines}) SELECT ${AGGREGATES} FROM b`, params.values)).rows[0]!;
  const totals = figures(totalRow);
  if (groupBy === "none") return { totals, groups: [], other: null, groupCount: 0 };

  const group = GROUP_SQL[groupBy];
  const chronological = groupBy === "month" || groupBy === "year";
  const groupParams = new SqlParams();
  const groupLines = salesLinesSql(period, filters, groupParams);
  const limitParam = groupParams.add(chronological ? LIMITS.maxMonths : limit);
  const { rows } = await client.query<AggregateRow & { key: string; label: string | null; group_count: string }>(
    `WITH b AS (${groupLines}),
          g AS (SELECT ${group.key} AS key, ${group.label ? `min(${group.label})` : "NULL::text"} AS label, ${AGGREGATES}
                FROM b GROUP BY 1)
     SELECT g.*, count(*) OVER ()::text AS group_count FROM g
     ORDER BY ${chronological ? "g.key" : "g.sales::bigint DESC, g.key COLLATE \"C\""}
     LIMIT ${limitParam}`,
    groupParams.values,
  );
  const groupCount = count(rows[0]?.group_count);
  let groups = rows.map((row) => ({ key: row.key, label: labelFor(groupBy, row.key, row.label), figures: figures(row) }));

  if (chronological) {
    // Every month or year of the period is listed, with zeros where nothing was billed.
    const byKey = new Map(groups.map((row) => [row.key, row]));
    const keys =
      groupBy === "month"
        ? monthsBetween(period.from, period.to)
        : Array.from({ length: yearOf(period.to) - yearOf(period.from) + 1 }, (_, index) => String(yearOf(period.from) + index));
    groups = keys.map((key) => byKey.get(key) ?? { key, label: null, figures: ZERO });
    return { totals, groups, other: null, groupCount: groups.length };
  }

  let other: SalesTotalsData["other"] = null;
  if (groupCount > groups.length) {
    const otherParams = new SqlParams();
    const otherLines = salesLinesSql(period, filters, otherParams);
    const shown = otherParams.add(groups.map((row) => row.key));
    const otherRow = (
      await client.query<AggregateRow & { group_count: string }>(
        `WITH b AS (${otherLines}) SELECT ${AGGREGATES}, count(DISTINCT ${group.key})::text AS group_count
         FROM b WHERE ${group.key} <> ALL(${shown}::text[])`,
        otherParams.values,
      )
    ).rows[0]!;
    other = { ...figures(otherRow), groupCount: count(otherRow.group_count) };
  }
  return { totals, groups, other, groupCount };
}

export function salesNotes(period: ResolvedPeriod, filters: Filters, groupBy: SalesGroup): Note[] {
  const notes: Note[] = [];
  if (period.cutAtAsOf) notes.push(NOTES.PERIOD_CUT_AT_AS_OF);
  if (filters.productId !== undefined) notes.push(NOTES.PRODUCT_FILTER_SELECTS_LINES);
  if (groupBy === "product") notes.push(NOTES.GROUP_COUNTS_OVERLAP);
  return notes;
}

export const salesTotals = defineTool({
  name: "sales_totals",
  title: "Invoiced sales totals",
  description:
    "Invoiced sales in a billing period: sales and commission (cents plus a formatted BRL string), distinct invoices, " +
    "invoice lines and distinct customers, optionally grouped by month, year, businessUnit, seller, customer, product, " +
    "paymentSchedule or segment. Groups are the largest by sales (month and year: every period, in order, zeros included), " +
    "each with its share of the total; otherGroups sums the groups not listed, so groups plus otherGroups equal the totals. " +
    "A productId filter counts only that product's lines, and invoices that contain it. Product groups add package " +
    "quantities. Sales are invoiced amounts, not payments.",
  input: z.strictObject({
    period: periodSchema,
    ...filterShape,
    groupBy: z.enum(SALES_GROUPS).default("none"),
    limit: limitSchema(LIMITS.maxRows, LIMITS.defaultRows),
  }),
  async run(context, client, input) {
    const period = requirePeriod(input.period, context.dataset);
    const filters = filterEcho(input);
    if (input.groupBy === "month" && monthsBetween(period.from, period.to).length > LIMITS.maxMonths) {
      throw new ToolError("PERIOD_INVALID", { reason: "TOO_MANY_MONTHS", asOf: context.dataset.asOf });
    }
    await checkFiltersExist(client, filters);
    const data = await querySalesTotals(client, period, filters, input.groupBy, input.limit);
    const total = data.totals.salesCents;
    const withPackages = input.groupBy === "product";
    const { shareBasisPoints: _share, sharePercent: _percent, ...totals } = displayFigures(data.totals, total, false);
    return envelope(
      context.dataset,
      salesNotes(period, filters, input.groupBy),
      {
        period,
        filters,
        groupBy: input.groupBy,
        totals,
        groups: data.groups.map((row) => ({ key: row.key, label: row.label, ...displayFigures(row.figures, total, withPackages) })),
        otherGroups: data.other ? { groupCount: data.other.groupCount, ...displayFigures(data.other, total, withPackages) } : null,
      },
      { truncated: data.other !== null, totalRows: data.groupCount },
    );
  },
});

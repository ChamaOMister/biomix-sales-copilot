import type pg from "pg";
import { z } from "zod";
import { toSafeInteger } from "../../db/pool.ts";
import { shiftYears } from "../../shared/dates.ts";
import { changeBasisPoints, formatBasisPoints, formatBrl, money } from "../../shared/money.ts";
import { resolvePeriod, type ResolvedPeriod } from "../../shared/periods.ts";
import { envelope, LIMITS, NOTES, ToolError, type DatasetInfo, type Note } from "../conventions.ts";
import { checkFiltersExist, filterEcho, filterShape, limitSchema, periodSchema, requirePeriod, SqlParams, type Filters } from "../inputs.ts";
import { count, defineTool } from "../tool.ts";
import { GROUP_SQL, labelFor, salesLinesSql } from "./sales-totals.ts";

const COMPARE_GROUPS = ["none", "businessUnit", "seller", "customer", "product"] as const;
type CompareGroup = (typeof COMPARE_GROUPS)[number];
const STATUSES = ["any", "new", "absent", "continuing", "firstPurchase"] as const;

interface Side {
  salesCents: number;
  invoiceCount: number;
}

interface CompareRow {
  key: string;
  label: string | null;
  previous: Side;
  current: Side;
  firstBillingDate: string | null;
}

/** Previous and current sales and invoices per group, over every group present in either period. */
async function queryComparison(
  client: pg.PoolClient,
  current: ResolvedPeriod,
  previous: ResolvedPeriod,
  filters: Filters,
  groupBy: CompareGroup,
  excludeKeys: string[] | null,
): Promise<CompareRow[]> {
  const params = new SqlParams();
  const currentLines = salesLinesSql(current, filters, params);
  const previousLines = salesLinesSql(previous, filters, params);
  const key = groupBy === "none" ? "'all'" : GROUP_SQL[groupBy].key;
  const label = groupBy === "none" || !GROUP_SQL[groupBy].label ? "NULL::text" : `min(${GROUP_SQL[groupBy].label})`;
  const exclude = excludeKeys ? `WHERE ${key} <> ALL(${params.add(excludeKeys)}::text[])` : "";
  // With excluded keys the rows collapse into one remainder row.
  const groupKey = excludeKeys ? "'other'" : key;
  const aggregate = (side: string) => `
    SELECT ${groupKey} AS key, ${excludeKeys ? "NULL::text" : label} AS label,
           sum(b.line_amount_cents)::text AS sales, count(DISTINCT b.invoice_number)::text AS invoices
    FROM ${side} b ${exclude} GROUP BY 1`;
  const firstBilling =
    groupBy === "customer" && !excludeKeys
      ? "(SELECT min(billing_date)::text FROM invoices f WHERE f.customer_id = coalesce(c.key, p.key))"
      : "NULL::text";
  const { rows } = await client.query<{
    key: string;
    label: string | null;
    previous_sales: string | null;
    previous_invoices: string | null;
    current_sales: string | null;
    current_invoices: string | null;
    first_billing_date: string | null;
  }>(
    `WITH cur AS (${currentLines}), prev AS (${previousLines}),
          c AS (${aggregate("cur")}), p AS (${aggregate("prev")})
     SELECT coalesce(c.key, p.key) AS key, coalesce(c.label, p.label) AS label,
            p.sales AS previous_sales, p.invoices AS previous_invoices,
            c.sales AS current_sales, c.invoices AS current_invoices,
            ${firstBilling} AS first_billing_date
     FROM c FULL JOIN p ON p.key = c.key`,
    params.values,
  );
  return rows.map((row) => ({
    key: row.key,
    label: groupBy === "none" ? null : labelFor(groupBy, row.key, row.label),
    previous: { salesCents: row.previous_sales ? toSafeInteger(row.previous_sales) : 0, invoiceCount: count(row.previous_invoices) },
    current: { salesCents: row.current_sales ? toSafeInteger(row.current_sales) : 0, invoiceCount: count(row.current_invoices) },
    firstBillingDate: row.first_billing_date,
  }));
}

function statusOf(row: CompareRow): "new" | "absent" | "continuing" {
  if (row.previous.salesCents === 0) return "new";
  if (row.current.salesCents === 0) return "absent";
  return "continuing";
}

function changeOf(previous: Side, current: Side) {
  const basisPoints = changeBasisPoints(previous.salesCents, current.salesCents);
  const cents = current.salesCents - previous.salesCents;
  return {
    changeCents: cents,
    changeBrl: cents > 0 ? `+${formatBrl(cents)}` : formatBrl(cents),
    changeBasisPoints: basisPoints,
    changePercent: basisPoints === null ? null : formatBasisPoints(basisPoints, { signed: true }),
  };
}

function display(row: CompareRow, groupBy: CompareGroup, current: ResolvedPeriod) {
  const change = changeOf(row.previous, row.current);
  return {
    key: row.key,
    label: row.label,
    status: statusOf(row),
    previous: { ...money("sales", row.previous.salesCents), invoiceCount: row.previous.invoiceCount },
    current: { ...money("sales", row.current.salesCents), invoiceCount: row.current.invoiceCount },
    ...change,
    ...(groupBy === "customer"
      ? {
          firstBillingDate: row.firstBillingDate,
          firstPurchaseInCurrentPeriod: row.firstBillingDate !== null && row.firstBillingDate >= current.from && row.firstBillingDate <= current.to,
        }
      : {}),
    notes: change.changeBasisPoints === null ? [NOTES.NO_PREVIOUS_SALES] : [],
  };
}

export function previousPeriod(current: ResolvedPeriod, previous: z.infer<typeof previousSchema>, dataset: DatasetInfo): ResolvedPeriod {
  if (previous !== "same-period-previous-year") return requirePeriod(previous, dataset);
  // The current period, already cut at the as-of date, one year earlier; 29 February maps to 28 February.
  const result = resolvePeriod({ from: shiftYears(current.from, -1), to: shiftYears(current.to, -1) }, dataset.asOf);
  if (!result.ok) throw new ToolError("PERIOD_INVALID", { reason: result.reason, asOf: dataset.asOf });
  return { ...result.period, preset: "same-period-previous-year" };
}

const previousSchema = z
  .union([z.literal("same-period-previous-year"), periodSchema])
  .describe("The period to compare against: same-period-previous-year (the current period, cut at the as-of date, one year earlier) or an explicit period.");

export const comparePeriods = defineTool({
  name: "compare_periods",
  title: "Compare two periods",
  description:
    "Compares invoiced sales between a current and a previous period, in total and optionally per businessUnit, " +
    "seller, customer or product. Use previous = same-period-previous-year for equivalent cumulative periods " +
    "(year-to-date against the same dates last year, not the whole previous year). Each group gives previous and current " +
    "sales and invoices, the change in cents and in basis points of the previous sales (null with NO_PREVIOUS_SALES when " +
    "there were none), and a status: new (no previous sales), absent (no current sales) or continuing. Customer groups add " +
    "the customer's first billing date ever and whether it falls in the current period. The status filter keeps only " +
    "groups of one status; firstPurchase keeps customers whose first purchase ever is in the current period. Sorted by " +
    "absoluteChange (default) or relativeChange; order asc (default) lists the largest decreases first. Groups not listed " +
    "are summed in otherGroups.",
  input: z.strictObject({
    current: periodSchema,
    previous: previousSchema,
    ...filterShape,
    groupBy: z.enum(COMPARE_GROUPS).default("none"),
    status: z.enum(STATUSES).default("any"),
    sortBy: z.enum(["absoluteChange", "relativeChange"]).default("absoluteChange"),
    order: z.enum(["asc", "desc"]).default("asc"),
    limit: limitSchema(LIMITS.maxRows, LIMITS.defaultRows),
  }),
  async run(context, client, input) {
    const current = requirePeriod(input.current, context.dataset);
    const previous = previousPeriod(current, input.previous, context.dataset);
    const filters = filterEcho(input);
    if (input.status === "firstPurchase" && input.groupBy !== "customer") {
      throw new ToolError("INPUT_INVALID", { issues: [{ path: "status", problem: "firstPurchase needs groupBy customer" }] });
    }
    await checkFiltersExist(client, filters);

    const totalRow = (await queryComparison(client, current, previous, filters, "none", null))[0] ?? {
      key: "all",
      label: null,
      previous: { salesCents: 0, invoiceCount: 0 },
      current: { salesCents: 0, invoiceCount: 0 },
      firstBillingDate: null,
    };
    const totals = {
      previous: { ...money("sales", totalRow.previous.salesCents), invoiceCount: totalRow.previous.invoiceCount },
      current: { ...money("sales", totalRow.current.salesCents), invoiceCount: totalRow.current.invoiceCount },
      ...changeOf(totalRow.previous, totalRow.current),
    };

    const notes: Note[] = [];
    if (current.cutAtAsOf || previous.cutAtAsOf) notes.push(NOTES.PERIOD_CUT_AT_AS_OF);
    if (filters.productId !== undefined) notes.push(NOTES.PRODUCT_FILTER_SELECTS_LINES);
    if (totals.changeBasisPoints === null) notes.push(NOTES.NO_PREVIOUS_SALES);
    if (input.groupBy === "product") notes.push(NOTES.GROUP_COUNTS_OVERLAP);

    let groups: ReturnType<typeof display>[] = [];
    let otherGroups: object | null = null;
    let matching = 0;
    if (input.groupBy !== "none") {
      const all = (await queryComparison(client, current, previous, filters, input.groupBy, null)).map((row) => display(row, input.groupBy, current));
      const kept = all.filter((row) =>
        input.status === "any" ? true : input.status === "firstPurchase" ? row.firstPurchaseInCurrentPeriod === true : row.status === input.status,
      );
      const direction = input.order === "asc" ? 1 : -1;
      kept.sort((a, b) => {
        if (input.sortBy === "relativeChange") {
          if (a.changeBasisPoints === null || b.changeBasisPoints === null) {
            if (a.changeBasisPoints !== b.changeBasisPoints) return a.changeBasisPoints === null ? 1 : -1;
          } else if (a.changeBasisPoints !== b.changeBasisPoints) {
            return direction * (a.changeBasisPoints - b.changeBasisPoints);
          }
        }
        if (a.changeCents !== b.changeCents) return direction * (a.changeCents - b.changeCents);
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
      matching = kept.length;
      groups = kept.slice(0, input.limit);
      if (kept.length > groups.length) {
        const rest = kept.slice(groups.length);
        const [remainder] = await queryComparison(
          client,
          current,
          previous,
          filters,
          input.groupBy,
          all.filter((row) => !rest.includes(row)).map((row) => row.key),
        );
        if (remainder) {
          otherGroups = {
            groupCount: rest.length,
            previous: { ...money("sales", remainder.previous.salesCents), invoiceCount: remainder.previous.invoiceCount },
            current: { ...money("sales", remainder.current.salesCents), invoiceCount: remainder.current.invoiceCount },
            ...changeOf(remainder.previous, remainder.current),
          };
        }
      }
      if (groups.some((row) => row.changeBasisPoints === null)) notes.push(NOTES.NO_PREVIOUS_SALES);
    }

    return envelope(
      context.dataset,
      notes,
      {
        current,
        previous,
        filters,
        groupBy: input.groupBy,
        status: input.status,
        sortBy: input.sortBy,
        order: input.order,
        totals,
        groups,
        otherGroups,
        /** Groups plus otherGroups add up to the totals only when no status filter is applied. */
        groupsCoverTotals: input.status === "any",
      },
      { truncated: otherGroups !== null, totalRows: matching },
    );
  },
});

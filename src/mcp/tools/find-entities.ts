import { z } from "zod";
import { BUSINESS_UNIT_LABELS, envelope, LIMITS } from "../conventions.ts";
import { limitSchema } from "../inputs.ts";
import { count, defineTool } from "../tool.ts";

// Case- and accent-insensitive matching without extensions: the reader cannot install unaccent.
const FOLD_FROM = "áàâãäåéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ";
const FOLD_TO = "aaaaaaeeeeiiiiooooouuuucnaaaaaaeeeeiiiiooooouuuucn";
const fold = (sql: string) => `lower(translate(${sql}, '${FOLD_FROM}', '${FOLD_TO}'))`;

function foldText(text: string): string {
  let folded = "";
  for (const char of text) {
    const index = FOLD_FROM.indexOf(char);
    folded += index === -1 ? char : FOLD_TO[index];
  }
  return folded.toLowerCase();
}

/** Escapes LIKE wildcards so the query is matched literally. */
const likeLiteral = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const KINDS = {
  customer: {
    table: "customers e",
    id: "e.customer_id",
    name: "e.name",
    columns: `e.customer_id AS id, e.name, e.segment, e.city, e.state, e.seller_id, s.business_unit,
              (SELECT min(billing_date)::text FROM invoices i WHERE i.customer_id = e.customer_id) AS first_billing_date,
              (SELECT max(billing_date)::text FROM invoices i WHERE i.customer_id = e.customer_id) AS last_billing_date,
              (SELECT count(*) FROM invoices i WHERE i.customer_id = e.customer_id)::text AS invoice_count`,
    join: "JOIN sellers s ON s.seller_id = e.seller_id",
  },
  product: { table: "products e", id: "e.product_id", name: "e.name", columns: "e.product_id AS id, e.name, e.category, e.business_unit", join: "" },
  seller: { table: "sellers e", id: "e.seller_id", name: "e.name", columns: "e.seller_id AS id, e.name, e.business_unit, e.territory", join: "" },
} as const;

type Row = Record<string, string | null>;

function shape(kind: keyof typeof KINDS, row: Row): object {
  const unit = { businessUnit: row.business_unit, businessUnitLabel: BUSINESS_UNIT_LABELS[row.business_unit ?? ""] ?? null };
  if (kind === "customer") {
    return {
      customerId: row.id,
      name: row.name,
      segment: row.segment,
      city: row.city,
      state: row.state,
      sellerId: row.seller_id,
      ...unit,
      firstBillingDate: row.first_billing_date,
      lastBillingDate: row.last_billing_date,
      invoiceCount: count(row.invoice_count),
    };
  }
  if (kind === "product") return { productId: row.id, name: row.name, category: row.category, ...unit };
  return { sellerId: row.id, name: row.name, ...unit, territory: row.territory };
}

export const findEntities = defineTool({
  name: "find_entities",
  title: "Find customers, products or sellers",
  description:
    "Turns a name into an ID. Matches a case- and accent-insensitive substring of the name, or an exact ID. " +
    "Exact ID matches come first, then names starting with the query, then other matches by name. Customers include " +
    "segment, city, state, owning seller, business unit, first and last billing date and invoice count.",
  input: z.strictObject({
    kind: z.enum(["customer", "product", "seller"]),
    query: z.string().min(1).max(LIMITS.searchLength).describe("Part of the name, or an exact ID."),
    limit: limitSchema(LIMITS.maxMatches, 10),
  }),
  async run(context, client, input) {
    const kind = KINDS[input.kind];
    const folded = foldText(input.query.trim());
    const pattern = `%${likeLiteral(folded)}%`;
    const prefix = `${likeLiteral(folded)}%`;
    const where = `(upper(${kind.id}) = upper($1) OR ${fold(kind.name)} LIKE $2)`;
    const total = await client.query<{ total: string }>(`SELECT count(*)::text AS total FROM ${kind.table} WHERE ${where}`, [
      input.query.trim(),
      pattern,
    ]);
    const { rows } = await client.query<Row>(
      `SELECT ${kind.columns} FROM ${kind.table} ${kind.join}
       WHERE ${where}
       ORDER BY (upper(${kind.id}) = upper($1)) DESC, (${fold(kind.name)} LIKE $3) DESC, ${kind.name} COLLATE "C", ${kind.id} COLLATE "C"
       LIMIT $4`,
      [input.query.trim(), pattern, prefix, input.limit],
    );
    const totalRows = count(total.rows[0]?.total);
    return envelope(
      context.dataset,
      [],
      { kind: input.kind, query: input.query, matches: rows.map((row) => shape(input.kind, row)) },
      { truncated: totalRows > rows.length, totalRows },
    );
  },
});

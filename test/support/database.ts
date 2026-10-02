/**
 * Database test support. The database tests read the dataset that `npm run data:load` loaded into
 * the database named by `DATABASE_URL`. Without `DATABASE_URL` they are skipped with a warning,
 * except in CI, where `global-setup.ts` fails the run instead (as in Project 1).
 */
import type pg from "pg";
import { describe } from "vitest";
import { createPool } from "../../src/db/pool.ts";

export const DATABASE_URL = process.env.DATABASE_URL ?? "";
export const hasDatabase = DATABASE_URL !== "";

/** `describe` that is skipped when no database is configured. */
export const describeDatabase = describe.skipIf(!hasDatabase);

export function adminPool(): pg.Pool {
  return createPool(DATABASE_URL, { max: 2 });
}

const FINGERPRINTED_TABLES = [
  "public.feed_deliveries",
  "public.sellers",
  "public.territory_cities",
  "public.customers",
  "public.products",
  "public.invoices",
  "public.invoice_lines",
  "public.scheduled_installments",
  "public.schema_migrations",
  "copilot_admin.dataset_provenance",
];

/** One hash per stored table, for asserting that an operation changed no data. */
export async function fingerprint(pool: pg.Pool): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of FINGERPRINTED_TABLES) {
    const { rows } = await pool.query<{ rows: string; hash: string | null }>(
      `SELECT count(*)::text AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash FROM ${table} t`,
    );
    result[table] = `${rows[0]!.rows}:${rows[0]!.hash ?? ""}`;
  }
  return result;
}

/**
 * Admin side of the reader role: applies `db/reader.sql` and sets the role's password, over the
 * admin connection. Used by `npm run db:reader` and `npm run data:reset`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { REPOSITORY_ROOT } from "../data-source/pin.ts";
import { READER_ROLE } from "./reader.ts";

export const READER_SQL_FILE = path.join(REPOSITORY_ROOT, "db", "reader.sql");

/** Applies `db/reader.sql` and the password in one transaction. */
export async function applyReaderSql(pool: pg.Pool, password: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) {
    throw new Error("COPILOT_READER_PASSWORD must be at least 16 URL-safe characters; npm run setup:env writes one.");
  }
  const sql = readFileSync(READER_SQL_FILE, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    // ALTER ROLE takes no bind parameters; the value is quoted as a literal (and is URL-safe anyway).
    await client.query(`ALTER ROLE ${READER_ROLE} PASSWORD ${client.escapeLiteral(password)}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function readerRoleExists(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ found: boolean }>("SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1) AS found", [READER_ROLE]);
  return rows[0]?.found ?? false;
}

/** Every table privilege the reader holds, for the privilege listing. */
export async function readerPrivileges(pool: pg.Pool): Promise<{ schema: string; relation: string; privilege: string }[]> {
  const { rows } = await pool.query<{ schema: string; relation: string; privilege: string }>(
    `SELECT table_schema AS schema, table_name AS relation, privilege_type AS privilege
     FROM information_schema.role_table_grants WHERE grantee = $1 ORDER BY 1, 2, 3`,
    [READER_ROLE],
  );
  return rows;
}

/**
 * The reader's connection string: `COPILOT_DATABASE_URL` when set, otherwise the admin URL's host,
 * port and database with the reader's name and password.
 */
export function readerConnectionString(env: NodeJS.ProcessEnv): string | null {
  if (env.COPILOT_DATABASE_URL) return env.COPILOT_DATABASE_URL;
  if (!env.DATABASE_URL || !env.COPILOT_READER_PASSWORD) return null;
  const url = new URL(env.DATABASE_URL);
  url.username = READER_ROLE;
  url.password = env.COPILOT_READER_PASSWORD;
  return url.toString();
}

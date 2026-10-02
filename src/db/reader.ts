/**
 * The read-only connection the MCP server uses (decision 001, section 2.3). It connects as
 * `copilot_reader`, and refuses to start unless a self-check confirms the role can only read the
 * `copilot` views. Each tool call runs in one read-only, repeatable-read transaction, so a result
 * is internally consistent.
 *
 * No file system or environment access here: the caller passes the connection string.
 */
import type pg from "pg";
import { createPool } from "./pool.ts";

export const READER_ROLE = "copilot_reader";
export const READER_SCHEMA = "copilot";

export class ReaderSelfCheckError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The database connection is not a read-only reader: ${problems.join("; ")}`);
    this.name = "ReaderSelfCheckError";
    this.problems = problems;
  }
}

export function createReaderPool(connectionString: string, options: { max?: number } = {}): pg.Pool {
  // The role allows 4 connections; tool calls arrive one at a time, so one connection suffices.
  return createPool(connectionString, { max: options.max ?? 1, application_name: "copilot-mcp" });
}

/**
 * Lists every way the connected role exceeds read-only access to the `copilot` views; empty when
 * it is the expected reader. Checks the role name and attributes, role memberships, write-like
 * privileges on every relation, SELECT outside `copilot`, CREATE on any schema, CREATE and
 * TEMPORARY on the database, and the role's read-only and timeout settings.
 */
export async function readerSelfCheckProblems(pool: pg.Pool, expectedRole: string = READER_ROLE): Promise<string[]> {
  const problems: string[] = [];
  const client = await pool.connect();
  try {
    const role = (
      await client.query<{
        current_user: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        memberships: string;
        read_only: string;
        timeout: string;
      }>(`
        SELECT current_user, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
               (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::text AS memberships,
               current_setting('default_transaction_read_only') AS read_only,
               current_setting('statement_timeout') AS timeout
        FROM pg_roles r WHERE r.rolname = current_user`)
    ).rows[0];
    if (!role) return ["the current role is not visible in pg_roles"];
    if (role.current_user !== expectedRole) problems.push(`connected as ${role.current_user}, not ${expectedRole}`);
    for (const attribute of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"] as const) {
      if (role[attribute]) problems.push(`role has ${attribute}`);
    }
    if (role.memberships !== "0") problems.push("role is a member of other roles");
    if (role.read_only !== "on") problems.push("default_transaction_read_only is not on");
    if (role.timeout === "0") problems.push("statement_timeout is not set");

    const relations = await client.query<{ name: string; problem: string }>(`
      SELECT format('%I.%I', n.nspname, c.relname) AS name,
             CASE
               WHEN c.relkind = 'S' AND has_sequence_privilege(c.oid, 'USAGE, UPDATE') THEN 'sequence privilege'
               WHEN c.relkind <> 'S' AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
                 THEN 'write privilege'
               WHEN c.relkind <> 'S' AND n.nspname <> '${READER_SCHEMA}' AND has_table_privilege(c.oid, 'SELECT')
                 THEN 'SELECT outside the copilot schema'
               WHEN c.relkind NOT IN ('v', 'S') AND n.nspname = '${READER_SCHEMA}' THEN 'non-view relation in copilot'
             END AS problem
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
      ORDER BY 1`);
    for (const row of relations.rows) if (row.problem) problems.push(`${row.problem} on ${row.name}`);

    const schemas = await client.query<{ name: string }>(`
      SELECT nspname AS name FROM pg_namespace WHERE has_schema_privilege(oid, 'CREATE') ORDER BY 1`);
    for (const row of schemas.rows) problems.push(`CREATE on schema ${row.name}`);

    const database = (
      await client.query<{ can_create: boolean; can_temp: boolean }>(`
        SELECT has_database_privilege(current_database(), 'CREATE') AS can_create,
               has_database_privilege(current_database(), 'TEMPORARY') AS can_temp`)
    ).rows[0]!;
    if (database.can_create) problems.push("CREATE on the database");
    if (database.can_temp) problems.push("TEMPORARY on the database");
  } finally {
    client.release();
  }
  return problems;
}

/** Throws `ReaderSelfCheckError` unless the pool connects as the read-only reader. */
export async function assertReadOnlyReader(pool: pg.Pool, expectedRole: string = READER_ROLE): Promise<void> {
  const problems = await readerSelfCheckProblems(pool, expectedRole);
  if (problems.length > 0) throw new ReaderSelfCheckError(problems);
}

/** Runs `work` in one read-only, repeatable-read transaction. */
export async function withReadTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failed = true;
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    // A client whose statement failed is discarded rather than returned to the pool.
    client.release(failed);
  }
}

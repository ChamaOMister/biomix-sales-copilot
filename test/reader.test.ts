import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPool } from "../src/db/pool.ts";
import { assertReadOnlyReader, createReaderPool, readerSelfCheckProblems, ReaderSelfCheckError } from "../src/db/reader.ts";
import { readerConnectionString, readerPrivileges } from "../src/db/reader-setup.ts";
import { adminPool, describeDatabase } from "./support/database.ts";

const VIEWS: Record<string, string> = {
  "copilot.invoices": "invoice_number",
  "copilot.invoice_lines": "invoice_number",
  "copilot.scheduled_installments": "invoice_number",
  "copilot.customers": "customer_id",
  "copilot.products": "product_id",
  "copilot.sellers": "seller_id",
  "copilot.deliveries": "delivery_id",
  "copilot.dataset_info": "seed",
};
const BASE_TABLES: Record<string, string> = {
  "public.invoices": "invoice_number",
  "public.invoice_lines": "invoice_number",
  "public.scheduled_installments": "invoice_number",
  "public.customers": "customer_id",
  "public.products": "product_id",
  "public.sellers": "seller_id",
  "public.territory_cities": "city",
  "public.feed_deliveries": "delivery_id",
  "public.schema_migrations": "version",
  "copilot_admin.dataset_provenance": "seed",
};

const writes = (relation: string, column: string) => ({
  INSERT: `INSERT INTO ${relation} DEFAULT VALUES`,
  UPDATE: `UPDATE ${relation} SET ${column} = ${column}`,
  DELETE: `DELETE FROM ${relation}`,
  TRUNCATE: `TRUNCATE ${relation}`,
});

/** Runs `sql` inside a transaction that is always rolled back, and returns the SQLSTATE (null on success). */
async function sqlState(client: pg.ClientBase, sql: string, begin = "BEGIN"): Promise<string | null> {
  await client.query(begin);
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
  }
}

describeDatabase("copilot_reader", () => {
  let reader: pg.Pool;
  let admin: pg.Pool;
  const url = readerConnectionString(process.env);

  beforeAll(() => {
    if (!url) throw new Error("COPILOT_READER_PASSWORD is not set: run npm run setup:env and npm run db:reader");
    reader = createReaderPool(url, { max: 1 });
    admin = adminPool();
  });
  afterAll(async () => {
    await reader.end();
    await admin.end();
  });

  async function asReader<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await reader.connect();
    try {
      return await work(client);
    } finally {
      client.release(true);
    }
  }

  test("can read the copilot views, with the role's settings applied", async () => {
    await asReader(async (client) => {
      for (const view of Object.keys(VIEWS)) await client.query(`SELECT * FROM ${view} LIMIT 1`);
      const settings = await client.query<{ read_only: string; timeout: string; idle: string; path: string }>(
        `SELECT current_setting('default_transaction_read_only') AS read_only, current_setting('statement_timeout') AS timeout,
                current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('search_path') AS path`,
      );
      expect(settings.rows[0]).toEqual({ read_only: "on", timeout: "5s", idle: "10s", path: "copilot" });
    });
  });

  const writeOutcomes = async (setup: string | null, begin: string) => {
    const outcomes: Record<string, string | null> = {};
    await asReader(async (client) => {
      if (setup) await client.query(setup);
      for (const [relation, column] of Object.entries({ ...VIEWS, ...BASE_TABLES })) {
        for (const [kind, sql] of Object.entries(writes(relation, column))) {
          outcomes[`${kind} ${relation}`] = await sqlState(client, sql, begin);
        }
      }
    });
    return outcomes;
  };

  test("every write fails with the role defaults (read-only is defence in depth here)", async () => {
    const outcomes = await writeOutcomes(null, "BEGIN");
    // TRUNCATE meets the read-only check (25006) before privileges; the other writes meet privileges.
    for (const [key, code] of Object.entries(outcomes)) expect([key, ["25006", "42501", "42809"]]).toEqual([key, expect.arrayContaining([code])]);
  });

  // The read-only setting is switched off or bypassed, so only privileges stop the write.
  const modes: [string, string | null, string][] = [
    ["after SET default_transaction_read_only = off", "SET default_transaction_read_only = off", "BEGIN"],
    ["inside BEGIN READ WRITE", null, "BEGIN READ WRITE"],
  ];
  for (const [label, setup, begin] of modes) {
    test(`INSERT, UPDATE, DELETE and TRUNCATE fail with 42501 on every view and base table ${label}`, async () => {
      const outcomes = await writeOutcomes(setup, begin);
      const expected = Object.fromEntries(
        Object.keys(outcomes).map((key) => [
          key,
          // Postgres refuses TRUNCATE on a view as "not a table" (42809) before checking privileges.
          key.startsWith("TRUNCATE copilot.") ? "42809" : "42501",
        ]),
      );
      expect(outcomes).toEqual(expected);
    });
  }

  test("CREATE TABLE, TEMP TABLE, SCHEMA and FUNCTION fail with 42501", async () => {
    await asReader(async (client) => {
      await client.query("SET default_transaction_read_only = off");
      const statements = [
        "CREATE TABLE copilot.probe (a int)",
        "CREATE TABLE public.probe (a int)",
        "CREATE TABLE probe (a int)",
        "CREATE TEMP TABLE probe (a int)",
        "CREATE SCHEMA probe",
        "CREATE FUNCTION copilot.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'",
        "CREATE FUNCTION pg_temp.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'",
        "CREATE VIEW copilot.probe AS SELECT 1",
      ];
      for (const sql of statements) expect([sql, await sqlState(client, sql, "BEGIN READ WRITE")]).toEqual([sql, "42501"]);
    });
  });

  test("SELECT on Project 1's tables and the admin schema fails with 42501", async () => {
    await asReader(async (client) => {
      for (const relation of Object.keys(BASE_TABLES)) {
        expect([relation, await sqlState(client, `SELECT 1 FROM ${relation} LIMIT 1`)]).toEqual([relation, "42501"]);
      }
    });
  });

  test("a statement over the timeout is cancelled with 57014", async () => {
    await asReader(async (client) => {
      expect(await sqlState(client, "SELECT pg_sleep(5.5)")).toBe("57014");
    });
  }, 15_000);

  test("the privilege listing shows only SELECT on the copilot views", async () => {
    const privileges = await readerPrivileges(admin);
    expect(privileges.map((row) => `${row.schema}.${row.relation} ${row.privilege}`)).toEqual(
      Object.keys(VIEWS).sort().map((view) => `${view} SELECT`),
    );
  });

  test("the self-check accepts the reader", async () => {
    expect(await readerSelfCheckProblems(reader)).toEqual([]);
    await expect(assertReadOnlyReader(reader)).resolves.toBeUndefined();
  });

  test("the self-check rejects the admin role", async () => {
    await expect(assertReadOnlyReader(admin)).rejects.toThrow(ReaderSelfCheckError);
    const problems = await readerSelfCheckProblems(admin);
    expect(problems).toContain("connected as biomix, not copilot_reader");
    expect(problems).toContain("role has rolsuper");
  });
});

describeDatabase("reader self-check with an extra write grant", () => {
  // A throwaway role set up like the reader, so the real reader's privileges are never widened.
  const suffix = randomBytes(4).toString("hex");
  const role = `copilot_probe_${suffix}`;
  const scratch = `copilot_probe_scratch_${suffix}`;
  const password = randomBytes(18).toString("base64url");
  let admin: pg.Pool;
  let probe: pg.Pool;

  beforeAll(async () => {
    admin = adminPool();
    await admin.query(`
      CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}';
      ALTER ROLE ${role} SET default_transaction_read_only = on;
      ALTER ROLE ${role} SET statement_timeout = '5s';
      GRANT CONNECT ON DATABASE ${(await admin.query<{ db: string }>("SELECT current_database() AS db")).rows[0]!.db} TO ${role};
      GRANT USAGE ON SCHEMA copilot TO ${role};
      GRANT SELECT ON ALL TABLES IN SCHEMA copilot TO ${role};
      CREATE SCHEMA ${scratch};
      CREATE TABLE ${scratch}.notes (a int);`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = role;
    url.password = password;
    probe = createPool(url.toString(), { max: 1 });
  });
  afterAll(async () => {
    await probe?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE; DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  test("passes when set up like the reader, and fails once a write privilege is granted", async () => {
    expect(await readerSelfCheckProblems(probe, role)).toEqual([]);
    await admin.query(`GRANT USAGE ON SCHEMA ${scratch} TO ${role}; GRANT INSERT ON ${scratch}.notes TO ${role}`);
    expect(await readerSelfCheckProblems(probe, role)).toEqual([`write privilege on ${scratch}.notes`]);
    await admin.query(`REVOKE INSERT ON ${scratch}.notes FROM ${role}; GRANT SELECT ON ${scratch}.notes TO ${role}`);
    expect(await readerSelfCheckProblems(probe, role)).toEqual([`SELECT outside the copilot schema on ${scratch}.notes`]);
    await admin.query(`REVOKE SELECT ON ${scratch}.notes FROM ${role}; GRANT CREATE ON SCHEMA ${scratch} TO ${role}`);
    expect(await readerSelfCheckProblems(probe, role)).toEqual([`CREATE on schema ${scratch}`]);
  });
});

describe("readerConnectionString", () => {
  test("prefers COPILOT_DATABASE_URL, otherwise derives the reader URL from the admin URL", () => {
    expect(readerConnectionString({ COPILOT_DATABASE_URL: "postgres://x" })).toBe("postgres://x");
    expect(
      readerConnectionString({ DATABASE_URL: "postgres://admin:secret@db.local:6543/biomix", COPILOT_READER_PASSWORD: "pw-123" }),
    ).toBe("postgres://copilot_reader:pw-123@db.local:6543/biomix");
    expect(readerConnectionString({ DATABASE_URL: "postgres://a:b@h/d" })).toBeNull();
  });
});

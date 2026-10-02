/**
 * Creates or updates the read-only `copilot_reader` role and the `copilot` views, then connects as
 * the reader and runs the MCP server's startup self-check (Node 24 runs this file directly):
 *
 *   npm run db:reader
 *
 * Needs the admin DATABASE_URL, the loaded dataset (npm run data:load) and COPILOT_READER_PASSWORD
 * (npm run setup:env). Prints the reader's privilege listing; never prints the password.
 */
import { databaseErrorDiagnostics, createPool } from "../src/db/pool.ts";
import { assertReadOnlyReader, createReaderPool, ReaderSelfCheckError } from "../src/db/reader.ts";
import { applyReaderSql, readerConnectionString, readerPrivileges } from "../src/db/reader-setup.ts";
import { loadLocalEnv, requireEnv } from "../src/setup/env.ts";

loadLocalEnv();
const databaseUrl = requireEnv("DATABASE_URL", "The dev container and CI set it; see .env.example.");
const password = requireEnv("COPILOT_READER_PASSWORD", "Run npm run setup:env first.");

const admin = createPool(databaseUrl, { max: 1 });
try {
  await applyReaderSql(admin, password);
  const privileges = await readerPrivileges(admin);
  const bySchema = new Map<string, Set<string>>();
  for (const row of privileges) {
    const key = `${row.schema} ${row.privilege}`;
    bySchema.set(key, (bySchema.get(key) ?? new Set()).add(row.relation));
  }
  console.log("copilot_reader privileges:");
  for (const [key, relations] of bySchema) console.log(`  ${key}: ${[...relations].join(", ")}`);

  const reader = createReaderPool(readerConnectionString({ ...process.env, COPILOT_DATABASE_URL: "" })!, { max: 1 });
  try {
    await assertReadOnlyReader(reader);
  } finally {
    await reader.end();
  }
  console.log("Reader self-check passed: copilot_reader can only read the copilot views.");
} catch (error) {
  if (error instanceof ReaderSelfCheckError) console.error(error.message);
  else if (error instanceof Error && !("code" in error)) console.error(`db:reader failed: ${error.message}`);
  else console.error("db:reader failed", JSON.stringify(databaseErrorDiagnostics(error)));
  process.exitCode = 1;
} finally {
  await admin.end();
}

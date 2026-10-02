/**
 * Runs once before the test files. Makes skipped database tests visible, fails the run in CI where
 * they must never be skipped, and requires the loaded dataset when a database is configured.
 */
import { createPool } from "../../src/db/pool.ts";
import { readProvenance } from "../../src/data-source/load.ts";

export default async function checkTestDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.CI) throw new Error("DATABASE_URL must be set in CI: the database tests may not be skipped.");
    console.warn("\n⚠ DATABASE_URL is not set: the Postgres tests are SKIPPED.\n");
    return;
  }
  const pool = createPool(url, { max: 1 });
  try {
    if ((await readProvenance(pool)) === null) {
      throw new Error("The database has no loaded dataset. Run npm run data:load before the tests.");
    }
    const views = await pool.query<{ found: boolean }>("SELECT to_regclass('copilot.dataset_info') IS NOT NULL AS found");
    if (!views.rows[0]?.found) throw new Error("The reader views are missing. Run npm run db:reader before the tests.");
  } finally {
    await pool.end();
  }
}

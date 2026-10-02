/**
 * Deletes the loaded dataset and loads it again from the pin (Node 24 runs this file directly):
 *
 *   npm run data:reset -- --yes
 *
 * Drops this repository's schemas (`copilot` views and `copilot_admin` provenance), runs Project
 * 1's own `db:reset`, then `data:load`, and re-creates the reader views if the reader role exists.
 * Development only; uses the admin DATABASE_URL.
 */
import { parseArgs } from "node:util";
import { createPool, databaseErrorDiagnostics } from "../src/db/pool.ts";
import { applyReaderSql, readerRoleExists } from "../src/db/reader-setup.ts";
import { loadDataset, resetDataset } from "../src/data-source/load.ts";
import { readPin } from "../src/data-source/pin.ts";
import { loadLocalEnv, requireEnv } from "../src/setup/env.ts";

const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } }, strict: true });
loadLocalEnv();
const databaseUrl = requireEnv("DATABASE_URL", "The dev container and CI set it; see .env.example.");
if (!values.yes) {
  console.error("This deletes the loaded dataset. Run again with --yes to confirm: npm run data:reset -- --yes");
  process.exit(1);
}

try {
  const pin = readPin();
  const pool = createPool(databaseUrl, { max: 1 });
  try {
    await resetDataset(pool, pin, databaseUrl);
  } finally {
    await pool.end();
  }
  console.log("Dataset deleted; loading it again");
  const result = await loadDataset({ pin, databaseUrl, log: (message) => console.log(message) });
  const admin = createPool(databaseUrl, { max: 1 });
  try {
    const password = process.env.COPILOT_READER_PASSWORD;
    if (password && (await readerRoleExists(admin))) {
      await applyReaderSql(admin, password);
      console.log("Reader views re-created (db:reader)");
    }
  } finally {
    await admin.end();
  }
  console.log(`data:reset done (${result.status})`);
} catch (error) {
  if (error instanceof Error && !("code" in error)) console.error(`data:reset failed: ${error.message}`);
  else console.error("data:reset failed", JSON.stringify(databaseErrorDiagnostics(error)));
  process.exitCode = 1;
}

/**
 * Loads seed 2026 of the pinned Project 1 into Postgres (Node 24 runs this file directly):
 *
 *   npm run data:load
 *
 * Uses the admin DATABASE_URL. A rerun detects the loaded dataset and changes nothing; an
 * interrupted load is finished by running it again.
 */
import { databaseErrorDiagnostics } from "../src/db/pool.ts";
import { loadDataset } from "../src/data-source/load.ts";
import { readPin } from "../src/data-source/pin.ts";
import { loadLocalEnv, requireEnv } from "../src/setup/env.ts";

loadLocalEnv();
const databaseUrl = requireEnv("DATABASE_URL", "The dev container and CI set it; see .env.example.");

try {
  const started = performance.now();
  const result = await loadDataset({ pin: readPin(), databaseUrl, log: (message) => console.log(message) });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`data:load ${result.status} in ${seconds} s`);
} catch (error) {
  // Messages from our own checks carry no secrets; database errors are reduced to diagnostics.
  if (error instanceof Error && !("code" in error)) console.error(`data:load failed: ${error.message}`);
  else console.error("data:load failed", JSON.stringify(databaseErrorDiagnostics(error)));
  process.exitCode = 1;
}

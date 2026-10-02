/**
 * `npm run data:load` (decision 001, section 1): loads seed 2026 of the pinned Project 1 into this
 * repository's Postgres with Project 1's own generator, migrations and `ingestDelivery`.
 *
 * 1. Verify (or clone) the pinned checkout in `.cache/project-1/`.
 * 2. Generate the seed with Project 1's script into the checkout's Git-ignored `data/generated/`.
 * 3. If the database already holds this pin's verified dataset, stop: a rerun changes nothing.
 * 4. Otherwise install Project 1's locked runtime dependencies, run its migrations, apply the
 *    deliveries in order (pending last), verify against `summary.json` and record the provenance.
 *
 * An interrupted load is finished by rerunning it: deliveries already stored replay unchanged.
 * Only delivery files are read; the answer key never enters Postgres.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { createPool } from "../db/pool.ts";
import { applyDeliveries, listDeliveryFiles, type IngestOutcome } from "./deliveries.ts";
import { DEFAULT_CHECKOUT_DIR, ensureCheckout, verifyCheckout, type DataSourcePin } from "./pin.ts";
import { readSummary, verifyDataset, type FeedSummary } from "./verify.ts";

export interface Provenance {
  repository: string;
  tag: string;
  sourceCommit: string;
  seed: number;
  asOfDate: string;
  coverageStartDate: string;
  appliedDeliveries: number;
}

export interface LoadOptions {
  pin: DataSourcePin;
  databaseUrl: string;
  checkoutDir?: string;
  log?: (message: string) => void;
}

export type LoadResult =
  | { status: "already-loaded"; provenance: Provenance }
  | { status: "loaded"; provenance: Provenance; applied: number; replayed: number };

export class DatasetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetConflictError";
  }
}

export const generatedDir = (checkoutDir: string): string => path.join(checkoutDir, "data", "generated");
export const feedDir = (checkoutDir: string): string => path.join(generatedDir(checkoutDir), "feed");

/** Project 1's processes get only what they need: never API keys or the reader password. */
function childEnv(databaseUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR", "npm_config_cache"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  return env;
}

function runInCheckout(checkoutDir: string, command: string, args: readonly string[], databaseUrl?: string): void {
  execFileSync(command, args, { cwd: checkoutDir, env: childEnv(databaseUrl), stdio: ["ignore", "ignore", "inherit"] });
}

/**
 * Generates the pinned seed with Project 1's own script (about a second; output is deterministic),
 * unless that seed's output is already there: a rerun rewrites nothing that others may be reading.
 */
export function generateSeed(checkoutDir: string, seed: number): { summary: FeedSummary; generated: boolean } {
  const file = path.join(feedDir(checkoutDir), "summary.json");
  let generated = false;
  if (!existsSync(file) || readSummary(file).seed !== seed) {
    runInCheckout(checkoutDir, process.execPath, ["scripts/generate-synthetic-data.ts", "--seed", String(seed)]);
    generated = true;
  }
  const summary = readSummary(file);
  if (summary.seed !== seed) throw new Error(`Generated summary is for seed ${summary.seed}, not ${seed}`);
  return { summary, generated };
}

async function waitForDatabase(pool: pg.Pool): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt >= 30) throw error;
      await sleep(1000);
    }
  }
}

export async function readProvenance(pool: pg.Pool | pg.PoolClient): Promise<Provenance | null> {
  const exists = await pool.query<{ found: boolean }>("SELECT to_regclass('copilot_admin.dataset_provenance') IS NOT NULL AS found");
  if (!exists.rows[0]?.found) return null;
  const { rows } = await pool.query<{
    repository: string;
    tag: string;
    source_commit: string;
    seed: number;
    as_of_date: string;
    coverage_start_date: string;
    applied_deliveries: number;
  }>(
    `SELECT repository, tag, source_commit, seed::int AS seed, as_of_date, coverage_start_date, applied_deliveries
     FROM copilot_admin.dataset_provenance`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    repository: row.repository,
    tag: row.tag,
    sourceCommit: row.source_commit,
    seed: row.seed,
    asOfDate: row.as_of_date,
    coverageStartDate: row.coverage_start_date,
    appliedDeliveries: row.applied_deliveries,
  };
}

/** Admin-only: the reader role has no privilege on `copilot_admin`; it sees provenance through a view. */
async function recordProvenance(pool: pg.Pool, provenance: Provenance): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS copilot_admin;
    CREATE TABLE IF NOT EXISTS copilot_admin.dataset_provenance (
      singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      repository         text NOT NULL,
      tag                text NOT NULL,
      source_commit      text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
      seed               bigint NOT NULL,
      as_of_date         date NOT NULL,
      coverage_start_date date NOT NULL,
      applied_deliveries integer NOT NULL,
      loaded_at          timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(
    `INSERT INTO copilot_admin.dataset_provenance
       (repository, tag, source_commit, seed, as_of_date, coverage_start_date, applied_deliveries)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      provenance.repository,
      provenance.tag,
      provenance.sourceCommit,
      provenance.seed,
      provenance.asOfDate,
      provenance.coverageStartDate,
      provenance.appliedDeliveries,
    ],
  );
}

interface ProjectOneIngest {
  ingestDelivery(pool: unknown, input: unknown): Promise<IngestOutcome>;
}
interface ProjectOnePool {
  createPool(url: string, options?: { max?: number }): { end(): Promise<void> };
}

/** Project 1's `ingestDelivery` and pool, imported from the verified checkout (they use its `pg`). */
async function importProjectOne(checkoutDir: string): Promise<{ ingest: ProjectOneIngest; pool: ProjectOnePool }> {
  const url = (file: string) => pathToFileURL(path.join(checkoutDir, file)).href;
  const ingest = (await import(url("src/server/sales-feed/ingest.ts"))) as ProjectOneIngest;
  const pool = (await import(url("src/server/db/pool.ts"))) as ProjectOnePool;
  return { ingest, pool };
}

function provenanceOf(pin: DataSourcePin, summary: FeedSummary): Provenance {
  return {
    repository: pin.repository,
    tag: pin.tag,
    sourceCommit: pin.commit,
    seed: pin.seed,
    asOfDate: summary.lastBillingDate,
    coverageStartDate: summary.firstBillingDate,
    appliedDeliveries: summary.deliveries.length,
  };
}

/**
 * Deletes the loaded dataset: this repository's schemas first (the reader views depend on Project
 * 1's tables), then Project 1's own `db:reset`, which drops and re-creates its tables empty.
 */
export async function resetDataset(pool: pg.Pool, pin: DataSourcePin, databaseUrl: string, checkoutDir = DEFAULT_CHECKOUT_DIR): Promise<void> {
  ensureCheckout(pin, checkoutDir);
  await pool.query("DROP SCHEMA IF EXISTS copilot CASCADE; DROP SCHEMA IF EXISTS copilot_admin CASCADE");
  if (!existsSync(path.join(checkoutDir, "node_modules", ".package-lock.json"))) {
    runInCheckout(checkoutDir, "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]);
  }
  runInCheckout(checkoutDir, "npm", ["run", "--silent", "db:reset", "--", "--yes"], databaseUrl);
}

export async function loadDataset(options: LoadOptions): Promise<LoadResult> {
  const { pin, databaseUrl } = options;
  const checkoutDir = options.checkoutDir ?? DEFAULT_CHECKOUT_DIR;
  const log = options.log ?? (() => undefined);

  const { cloned } = ensureCheckout(pin, checkoutDir);
  log(`${cloned ? "Cloned" : "Using"} Project 1 ${pin.tag} at ${pin.commit}`);
  const { summary, generated } = generateSeed(checkoutDir, pin.seed);
  log(`${generated ? "Generated" : "Found generated"} seed ${pin.seed}: ${summary.deliveries.length} deliveries, ${summary.invoices} invoices`);

  const pool = createPool(databaseUrl, { max: 1 });
  try {
    await waitForDatabase(pool);
    const stored = await readProvenance(pool);
    if (stored) {
      if (stored.sourceCommit !== pin.commit || stored.seed !== pin.seed) {
        throw new DatasetConflictError(
          `The database holds commit ${stored.sourceCommit} seed ${stored.seed}, not the pin. Run npm run data:reset -- --yes.`,
        );
      }
      const problems = await verifyDataset(pool, summary);
      if (problems.length > 0) {
        throw new DatasetConflictError(`The loaded dataset fails verification (${problems.join("; ")}). Run npm run data:reset -- --yes.`);
      }
      log("Dataset already loaded and verified; nothing changed");
      return { status: "already-loaded", provenance: stored };
    }

    if (!existsSync(path.join(checkoutDir, "node_modules", ".package-lock.json"))) {
      log("Installing Project 1's locked runtime dependencies (npm ci --omit=dev --ignore-scripts)");
      runInCheckout(checkoutDir, "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]);
    }
    log("Running Project 1's migrations");
    runInCheckout(checkoutDir, "npm", ["run", "--silent", "db:migrate"], databaseUrl);

    const projectOne = await importProjectOne(checkoutDir);
    const ingestPool = projectOne.pool.createPool(databaseUrl, { max: 1 });
    let applied;
    try {
      const files = listDeliveryFiles(feedDir(checkoutDir));
      applied = await applyDeliveries(files, (payload) => projectOne.ingest.ingestDelivery(ingestPool, payload));
    } finally {
      await ingestPool.end();
    }
    const expectedOrder = summary.deliveries.map((delivery) => delivery.deliveryId);
    if (applied.deliveryIds.join() !== expectedOrder.join()) {
      throw new Error("Deliveries were not applied in the summary's order");
    }
    log(`Applied ${applied.applied} deliveries (${applied.replayed} already stored)`);

    const problems = await verifyDataset(pool, summary);
    if (problems.length > 0) throw new Error(`Loaded data fails verification: ${problems.join("; ")}`);
    const provenance = provenanceOf(pin, summary);
    await recordProvenance(pool, provenance);
    verifyCheckout(checkoutDir, pin.commit);
    log(`Verified against summary.json; provenance recorded (as of ${provenance.asOfDate})`);
    return { status: "loaded", provenance, applied: applied.applied, replayed: applied.replayed };
  } finally {
    await pool.end();
  }
}

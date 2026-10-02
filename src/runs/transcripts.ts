/**
 * Run records and transcripts. Full transcripts (question, tool results, answer) contain generated
 * values, so they are written only under the Git-ignored `.cache/runs/`. The copilot itself has no
 * file-system access; runners call this.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPOSITORY_ROOT } from "../data-source/pin.ts";

export const RUNS_DIR = path.join(REPOSITORY_ROOT, ".cache", "runs");

/** Writes `record` as JSON to `.cache/runs/<name>.json` and returns the path. Refuses any other place. */
export function writeRunRecord(name: string, record: unknown, runsDir: string = RUNS_DIR): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) || name.includes("..")) throw new Error("Run record names are plain file names");
  const resolvedDir = path.resolve(runsDir);
  const relative = path.relative(path.join(REPOSITORY_ROOT, ".cache"), resolvedDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Run records are written only under .cache/");
  mkdirSync(resolvedDir, { recursive: true });
  const file = path.join(resolvedDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** A file-name-safe timestamp for run names; runners may read the clock, tools never do. */
export function runStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

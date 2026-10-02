/**
 * Environment for this repository's scripts: variables already set (dev container, CI,
 * Codespaces secrets) win over the Git-ignored `.env.local`, which `process.loadEnvFile` never
 * overrides them with.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { REPOSITORY_ROOT } from "../data-source/pin.ts";

export function loadLocalEnv(): void {
  const file = path.join(REPOSITORY_ROOT, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Exits with a short message when a required variable is missing. Never prints values. */
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is not set. ${hint}`);
    process.exit(1);
  }
  return value;
}

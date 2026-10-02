import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureReaderPassword } from "../src/setup/setup-env.ts";

const script = path.resolve(import.meta.dirname, "../scripts/setup-env.ts");
const passwordOf = (content: string): string => /^COPILOT_READER_PASSWORD=(.+)$/m.exec(content)?.[1] ?? "";

let dir: string;
let envFile: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "setup-env-"));
  envFile = path.join(dir, ".env.local");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureReaderPassword", () => {
  test("creates the file with mode 0600 and a random value when the file is missing", () => {
    expect(ensureReaderPassword(envFile)).toEqual({ created: true });
    const content = readFileSync(envFile, "utf8");
    expect(passwordOf(content)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  test("appends the value when the key is absent, keeping other lines byte for byte", () => {
    writeFileSync(envFile, "A=1\n# comment\nB=two words");
    expect(ensureReaderPassword(envFile)).toEqual({ created: true });
    const content = readFileSync(envFile, "utf8");
    expect(content.startsWith("A=1\n# comment\nB=two words\nCOPILOT_READER_PASSWORD=")).toBe(true);
    expect(content.endsWith("\n")).toBe(true);
  });

  test("fills an empty declaration in place", () => {
    writeFileSync(envFile, "A=1\nCOPILOT_READER_PASSWORD=\nB=2\n");
    expect(ensureReaderPassword(envFile)).toEqual({ created: true });
    const lines = readFileSync(envFile, "utf8").split("\n");
    expect(lines[0]).toBe("A=1");
    expect(passwordOf(lines[1]!)).not.toBe("");
    expect(lines.slice(2)).toEqual(["B=2", ""]);
  });

  test("keeps an existing value unchanged, and a second run gives the same file", () => {
    writeFileSync(envFile, "COPILOT_READER_PASSWORD=existing-value\nOTHER=x\n");
    expect(ensureReaderPassword(envFile)).toEqual({ created: false });
    expect(readFileSync(envFile, "utf8")).toBe("COPILOT_READER_PASSWORD=existing-value\nOTHER=x\n");

    rmSync(envFile);
    ensureReaderPassword(envFile);
    const first = readFileSync(envFile, "utf8");
    expect(ensureReaderPassword(envFile)).toEqual({ created: false });
    expect(readFileSync(envFile, "utf8")).toBe(first);
  });
});

describe("npm run setup:env", () => {
  test("never prints the value", () => {
    const run = () => spawnSync(process.execPath, [script, envFile], { encoding: "utf8" });
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout).toBe("COPILOT_READER_PASSWORD created in .env.local\n");
    const password = passwordOf(readFileSync(envFile, "utf8"));
    expect(password).not.toBe("");
    const second = run();
    expect(second.stdout).toBe("COPILOT_READER_PASSWORD already set in .env.local\n");
    for (const output of [first.stdout, first.stderr, second.stdout, second.stderr]) {
      expect(output).not.toContain(password);
    }
  });
});

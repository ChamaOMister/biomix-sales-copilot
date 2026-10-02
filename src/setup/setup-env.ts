/**
 * Ensures the Git-ignored env file holds a random password for the `copilot_reader` role.
 * An existing non-empty value is never changed, other lines are kept byte for byte, and the value
 * is never returned or printed.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const READER_PASSWORD_KEY = "COPILOT_READER_PASSWORD";

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function ensureReaderPassword(envFilePath: string): { created: boolean } {
  const existing = readIfExists(envFilePath);
  const content = existing ?? "";
  if (new RegExp(`^${READER_PASSWORD_KEY}=\\S.*$`, "m").test(content)) return { created: false };

  const line = `${READER_PASSWORD_KEY}=${randomBytes(24).toString("base64url")}`;
  const empty = new RegExp(`^${READER_PASSWORD_KEY}=[ \\t]*$`, "m");
  let next: string;
  if (empty.test(content)) {
    next = content.replace(empty, line);
  } else {
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    next = `${content}${separator}${line}\n`;
  }
  // The mode applies only when the file is created; an existing file keeps its permissions.
  writeFileSync(envFilePath, next, { mode: 0o600 });
  return { created: true };
}

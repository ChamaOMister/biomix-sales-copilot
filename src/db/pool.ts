/**
 * Postgres pools for this repository's own connections. `date` columns stay `YYYY-MM-DD` strings,
 * so no time zone can shift a calendar date; `bigint` values stay strings (the driver default)
 * and are converted with `toSafeInteger`. Connection strings contain passwords: never log them.
 */
import pg from "pg";

const DATE_OID = 1082;

const types = new pg.TypeOverrides();
types.setTypeParser(DATE_OID, "text", (value: string) => value);

export function createPool(connectionString: string, options: Omit<pg.PoolConfig, "connectionString" | "types"> = {}): pg.Pool {
  return new pg.Pool({ connectionString, types, max: 2, ...options });
}

/** Converts a `bigint`/`numeric` value (a string) to a number; throws if it is not a safe integer. */
export function toSafeInteger(value: string | number | bigint | null): number {
  if (value === null) throw new TypeError("Expected an integer, got null");
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new TypeError("Expected an integer");
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new RangeError("Integer is outside the safe range");
  return number;
}

/** Name and SQLSTATE of a database error, safe to log: never the message, which can quote values. */
export function databaseErrorDiagnostics(error: unknown): { error: string; sqlState?: string } {
  const name = error instanceof Error ? error.name : "unknown";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? { error: name, sqlState: code } : { error: name };
}

/**
 * Entry point of the stdio MCP server. Reads only `COPILOT_DATABASE_URL`, connects as
 * `copilot_reader`, and exits unless the startup self-check confirms read-only access. Logs go to
 * stderr (stdout carries the protocol) and hold tool names, error codes and durations only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { databaseErrorDiagnostics } from "../db/pool.ts";
import { assertReadOnlyReader, createReaderPool, ReaderSelfCheckError } from "../db/reader.ts";
import { loadDatasetInfo } from "./conventions.ts";
import { createToolServer } from "./server.ts";

export const EXIT_NO_DATABASE_URL = 2;
export const EXIT_SELF_CHECK_FAILED = 3;
export const EXIT_STARTUP_FAILED = 4;

const url = process.env.COPILOT_DATABASE_URL;
if (!url) {
  console.error("COPILOT_DATABASE_URL is not set.");
  process.exit(EXIT_NO_DATABASE_URL);
}

const pool = createReaderPool(url);
try {
  await assertReadOnlyReader(pool);
  const dataset = await loadDatasetInfo(pool);
  const server = createToolServer({ pool, dataset });
  server.onclose = () => {
    void pool.end();
  };
  await server.connect(new StdioServerTransport());
} catch (error) {
  if (error instanceof ReaderSelfCheckError) {
    console.error(error.message);
    await pool.end();
    process.exit(EXIT_SELF_CHECK_FAILED);
  }
  console.error("MCP server failed to start", JSON.stringify(databaseErrorDiagnostics(error)));
  await pool.end();
  process.exit(EXIT_STARTUP_FAILED);
}

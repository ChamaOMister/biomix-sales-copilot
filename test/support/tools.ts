/**
 * Calls the tools in-process through the same registry the MCP server uses, as `copilot_reader`.
 * The stdio round trip has its own test; in-process calls keep the parity matrices fast.
 */
import type pg from "pg";
import { createReaderPool } from "../../src/db/reader.ts";
import { readerConnectionString } from "../../src/db/reader-setup.ts";
import { loadDatasetInfo, type ToolContext } from "../../src/mcp/conventions.ts";
import { callTool } from "../../src/mcp/registry.ts";
import { DEFAULT_CHECKOUT_DIR } from "../../src/data-source/pin.ts";

export const CHECKOUT_DIR = DEFAULT_CHECKOUT_DIR;

export function readerUrl(): string {
  const url = readerConnectionString(process.env);
  if (!url) throw new Error("No reader connection: run npm run setup:env and npm run db:reader");
  return url;
}

export interface ToolHarness {
  pool: pg.Pool;
  context: ToolContext;
  /** Calls a tool and returns its result; throws with the error code when the call fails. */
  call(name: string, args: Record<string, unknown>): Promise<Record<string, any>>;
  /** Calls a tool that is expected to fail and returns the error body. */
  fail(name: string, args: unknown): Promise<{ code: string; reason?: string; field?: string; issues?: { path: string; problem: string }[]; message: string }>;
  close(): Promise<void>;
}

export async function toolHarness(): Promise<ToolHarness> {
  const pool = createReaderPool(readerUrl(), { max: 1 });
  const context = { pool, dataset: await loadDatasetInfo(pool) };
  return {
    pool,
    context,
    async call(name, args) {
      const outcome = await callTool(context, name, args);
      if (!outcome.ok) throw new Error(`${name} failed with ${outcome.error.code} ${JSON.stringify(outcome.error.details)}`);
      // Round-tripped through JSON, as the MCP client receives it.
      return JSON.parse(JSON.stringify(outcome.result)) as Record<string, any>;
    },
    async fail(name, args) {
      const outcome = await callTool(context, name, args);
      if (outcome.ok) throw new Error(`${name} unexpectedly succeeded`);
      return outcome.error.toJSON().error;
    },
    close: () => pool.end(),
  };
}

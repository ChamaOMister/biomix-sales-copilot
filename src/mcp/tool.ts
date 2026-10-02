/** The shape of one fixed, read-only tool. */
import type pg from "pg";
import type { z } from "zod";
import type { ToolContext } from "./conventions.ts";

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Runs inside one read-only, repeatable-read transaction. */
  run(context: ToolContext, client: pg.PoolClient, input: z.output<S>): Promise<object>;
}

export function defineTool<S extends z.ZodType>(tool: ToolDefinition<S>): ToolDefinition {
  return tool;
}

export const count = (value: string | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

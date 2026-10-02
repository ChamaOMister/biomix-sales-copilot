import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connectToolServer, SERVER_ENTRY, serverEnvironment, type ToolClient } from "../src/mcp-client/client.ts";
import { TOOL_NAMES } from "../src/mcp/registry.ts";
import { describeDatabase } from "./support/database.ts";
import { readerUrl } from "./support/tools.ts";

/** The fixed allowlist of decision 001: adding a tool means changing this list on purpose. */
const ALLOWED_TOOLS = [
  "dataset_overview",
  "find_entities",
  "sales_totals",
  "compare_periods",
  "customer_activity",
  "recurring_window_gaps",
  "same_day_invoices",
  "invoice_details",
  "resent_invoices",
  "scheduled_collections",
  "installments_due",
];

describe("MCP server configuration", () => {
  test("the registry holds exactly the allowed tools", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });

  test("the server is given only COPILOT_DATABASE_URL", () => {
    expect(Object.keys(serverEnvironment("postgres://reader@host/db"))).toEqual(["COPILOT_DATABASE_URL"]);
  });

  test("the server refuses to start without COPILOT_DATABASE_URL", () => {
    const run = spawnSync(process.execPath, [SERVER_ENTRY], { env: { PATH: process.env.PATH }, encoding: "utf8", input: "" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("COPILOT_DATABASE_URL is not set.");
  });
});

describeDatabase("MCP round trip over stdio", () => {
  let client: ToolClient;
  beforeAll(async () => {
    client = await connectToolServer(readerUrl(), { stderr: "pipe" });
  });
  afterAll(() => client.close());

  test("lists exactly the allowed tools, each with a strict object input schema", async () => {
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALLOWED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description?.length).toBeGreaterThan(40);
    }
  });

  test("the tool list is byte-stable across calls", async () => {
    expect(JSON.stringify(await client.listTools())).toBe(JSON.stringify(await client.listTools()));
  });

  test("calls a tool and receives the structured result", async () => {
    const result = await client.callTool("sales_totals", { period: "calendar-year:2025", groupBy: "year" });
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({ asOf: "2026-09-25", groups: [{ key: "2025" }], source: { seed: 2026 } });
  });

  test("errors come back as error results carrying their code", async () => {
    const result = await client.callTool("sales_totals", { period: "month:2027-01" });
    expect(result).toEqual({
      isError: true,
      value: { error: { code: "PERIOD_INVALID", message: expect.any(String) as string, reason: "STARTS_AFTER_AS_OF", asOf: "2026-09-25" } },
    });
  });

  test("a server connected as the admin role refuses to start", async () => {
    await expect(connectToolServer(process.env.DATABASE_URL!, { stderr: "ignore" })).rejects.toThrow();
  });
});

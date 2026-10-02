import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { REPOSITORY_ROOT } from "../src/data-source/pin.ts";
import { serverEnvironment } from "../src/mcp-client/client.ts";
import { filesUnder, importGraph } from "./support/import-graph.ts";

const FILE_SYSTEM = ["fs", "node:fs", "fs/promises", "node:fs/promises"];
const NETWORK = ["child_process", "node:child_process", "net", "node:net", "http", "node:http", "https", "node:https", "http2", "node:http2", "dgram", "node:dgram", "tls", "node:tls"];

describe("answer-key isolation and boundaries", () => {
  const mcp = importGraph(REPOSITORY_ROOT, ["src/mcp/main.ts", ...filesUnder(REPOSITORY_ROOT, "src/mcp")]);
  const copilotEntries = filesUnder(REPOSITORY_ROOT, "src/copilot");

  test("the MCP server's import graph has no file system, network, model SDK or evals/", () => {
    expect(mcp.files.length).toBeGreaterThan(10);
    expect(mcp.files.filter((file) => file.startsWith("evals/"))).toEqual([]);
    expect(mcp.files.filter((file) => file.startsWith("src/copilot/") || file.startsWith("src/setup/") || file.startsWith("src/data-source/"))).toEqual([]);
    expect(mcp.packages.filter((name) => FILE_SYSTEM.includes(name) || NETWORK.includes(name) || name.startsWith("@anthropic-ai/"))).toEqual([]);
    expect(mcp.files).not.toContain("src/db/reader-setup.ts");
  });

  test("the copilot's import graph has no file system, database driver or evals/", () => {
    const copilot = importGraph(REPOSITORY_ROOT, copilotEntries);
    expect(copilot.files.filter((file) => file.startsWith("evals/") || file.startsWith("src/mcp/") || file.startsWith("src/db/"))).toEqual([]);
    expect(copilot.packages.filter((name) => FILE_SYSTEM.includes(name) || name === "pg")).toEqual([]);
  });

  test("nothing outside evals/ and test/ imports evals/ (scripts/eval-* runners excepted)", () => {
    const sources = [...filesUnder(REPOSITORY_ROOT, "src"), ...filesUnder(REPOSITORY_ROOT, "scripts").filter((file) => !path.basename(file).startsWith("eval-"))];
    const graph = importGraph(REPOSITORY_ROOT, sources);
    expect(graph.files.filter((file) => file.startsWith("evals/"))).toEqual([]);
  });

  test("the MCP server reads only COPILOT_DATABASE_URL from its environment, and is given only that", () => {
    const reads = mcp.files.flatMap((file) => [...readFileSync(path.join(REPOSITORY_ROOT, file), "utf8").matchAll(/process\.env(?:\.(\w+)|\[)/g)].map((match) => match[1] ?? "[dynamic]"));
    expect([...new Set(reads)]).toEqual(["COPILOT_DATABASE_URL"]);
    expect(serverEnvironment("postgres://reader@host/db")).toEqual({ COPILOT_DATABASE_URL: "postgres://reader@host/db" });
  });

  test("the answer key's path appears only in evals/, the eval runner's npm script and docs", () => {
    const offending = [...filesUnder(REPOSITORY_ROOT, "src"), ...filesUnder(REPOSITORY_ROOT, "scripts").filter((file) => !path.basename(file).startsWith("eval-"))].filter(
      (file) => /answer-key|answer_key|answerKey/i.test(readFileSync(path.join(REPOSITORY_ROOT, file), "utf8")),
    );
    expect(offending).toEqual([]);
  });
});

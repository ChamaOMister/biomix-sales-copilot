// Flat ESLint config: typescript-eslint with type information, plus the import boundaries of
// decision 001 (sections 4 and 6). The boundaries are enforced again by an import-graph test.
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const FILE_SYSTEM = ["fs", "node:fs", "fs/promises", "node:fs/promises"];
const NETWORK_AND_PROCESSES = [
  "child_process", "node:child_process", "net", "node:net", "http", "node:http", "https", "node:https",
  "http2", "node:http2", "dgram", "node:dgram", "dns", "node:dns", "tls", "node:tls", "worker_threads", "node:worker_threads",
];
const restricted = (names, message) => names.map((name) => ({ name, message }));
// Matches any relative or absolute import path that passes through an `evals` directory.
const EVALS = { regex: "(^|/)evals(/|$)", message: "Only evals/ reads the answer key; nothing outside it may import it." };

export default defineConfig(
  { ignores: [".cache/", "node_modules/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Tests and evaluations assert on JSON tool results; production code keeps the strict rules.
    files: ["test/**", "evals/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  {
    files: ["src/**", "scripts/**"],
    ignores: ["src/mcp/**", "src/copilot/**", "scripts/eval-*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [EVALS] }] },
  },
  {
    // The MCP server: no file system, no network except the database driver, no model SDK.
    files: ["src/mcp/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          ...restricted(FILE_SYSTEM, "src/mcp/ has no file-system access."),
          ...restricted(NETWORK_AND_PROCESSES, "src/mcp/ reaches only the database, through pg."),
          { name: "@anthropic-ai/sdk", message: "The MCP server never calls a model." },
        ],
        patterns: [EVALS, { regex: "(^|/)copilot(/|$)", message: "The MCP server does not depend on the copilot." }],
      }],
    },
  },
  {
    // The copilot: no file system and no database; it reaches data only through the MCP tools.
    files: ["src/copilot/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          ...restricted(FILE_SYSTEM, "src/copilot/ has no file-system access; runners write transcripts."),
          { name: "pg", message: "The copilot reaches data only through the MCP tools." },
        ],
        patterns: [EVALS, { regex: "(^|/)mcp/(?!protocol)", message: "The copilot talks to the MCP server over stdio only." }],
      }],
    },
  },
);

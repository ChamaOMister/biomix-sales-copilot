import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Variables already set (dev container, CI) win; .env.local fills in the rest, as for the scripts.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file opens at most two reader connections; the role allows four.
    maxWorkers: 2,
  },
});

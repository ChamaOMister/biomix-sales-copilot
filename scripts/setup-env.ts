/**
 * Writes a random COPILOT_READER_PASSWORD to the Git-ignored .env.local unless one is already
 * there (Node 24 runs this TypeScript file directly):
 *
 *   npm run setup:env [-- <env file>]
 *
 * The value is never printed. The optional path argument exists for tests.
 */
import path from "node:path";
import { ensureReaderPassword, READER_PASSWORD_KEY } from "../src/setup/setup-env.ts";

const envFilePath = path.resolve(process.argv[2] ?? ".env.local");
const { created } = ensureReaderPassword(envFilePath);
const name = path.basename(envFilePath);
console.log(created ? `${READER_PASSWORD_KEY} created in ${name}` : `${READER_PASSWORD_KEY} already set in ${name}`);

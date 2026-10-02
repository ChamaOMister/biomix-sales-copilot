/**
 * Live-model configuration for the runners: the API key (from a Codespaces secret, the
 * environment or .env.local), `COPILOT_MODEL` and `COPILOT_EFFORT`. The key is handed only to the
 * Anthropic model client and is never printed.
 */
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, type Effort } from "../copilot/anthropic.ts";

/** Distinct exit code when no API key is configured, so callers can tell "skipped" from "failed". */
export const EXIT_NO_API_KEY = 3;

export const NO_KEY_MESSAGE =
  "ANTHROPIC_API_KEY is not set, so the live model is skipped (L3 not run). Add it as a Codespaces secret " +
  "with access to this repository, or export it in this shell; see the README. Keyless checks: npm run tools, " +
  "npm run eval:tools, npm run eval:scripted.";

export interface ModelConfig {
  apiKey: string;
  model: string;
  effort: Effort;
  fallbacks: boolean;
}

export function readModelConfig(env: NodeJS.ProcessEnv): ModelConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const effort = (env.COPILOT_EFFORT ?? DEFAULT_EFFORT) as Effort;
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new Error(`COPILOT_EFFORT must be one of ${EFFORTS.join(", ")}`);
  const model = env.COPILOT_MODEL || DEFAULT_MODEL;
  if (!/^claude-[a-z0-9-]+$/.test(model)) throw new Error("COPILOT_MODEL must be a Claude model ID");
  return { apiKey, model, effort, fallbacks: env.COPILOT_FALLBACKS !== "off" };
}

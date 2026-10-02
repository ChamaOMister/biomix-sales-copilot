/**
 * Token cost from recorded usage, in integer nanodollars per token so the sums are exact.
 * Anthropic API list prices per million tokens as of 2026-09 (decision 001, section 5); cache
 * writes use the 5-minute TTL (1.25 times the input price). Update with the price list.
 */
import type { Usage } from "./types.ts";

interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Nanodollars per token: $1 per million tokens is 1,000 nanodollars per token. */
export const PRICES: Readonly<Record<string, Prices>> = {
  "claude-opus-5-5": { input: 4_000, output: 20_000, cacheRead: 200, cacheWrite: 5_000 },
  "claude-sonnet-5-5": { input: 2_000, output: 10_000, cacheRead: 200, cacheWrite: 2_500 },
  "claude-haiku-4-5": { input: 1_000, output: 5_000, cacheRead: 100, cacheWrite: 1_250 },
};

/** Cost in nanodollars, or null for a model without a listed price. */
export function costNanodollars(model: string, usage: Usage): number | null {
  const prices = PRICES[model];
  if (!prices) return null;
  return (
    usage.inputTokens * prices.input +
    usage.outputTokens * prices.output +
    usage.cacheReadTokens * prices.cacheRead +
    usage.cacheWriteTokens * prices.cacheWrite
  );
}

/** `$0.1234`, rounded to the nearest hundredth of a cent. */
export function formatUsd(nanodollars: number): string {
  const tenThousandths = Math.round(nanodollars / 100_000);
  return `$${Math.floor(tenThousandths / 10_000)}.${String(tenThousandths % 10_000).padStart(4, "0")}`;
}

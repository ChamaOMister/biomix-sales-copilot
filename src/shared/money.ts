/**
 * Money and percentages for tool results (decision 001, section 2.1). Amounts are integer BRL
 * cents; percentages are integer basis points rounded half away from zero with integer (bigint)
 * arithmetic. Each comes with a display string formatted here, in US English: `R$ 1,234.56`.
 * The model never receives two numbers it has to combine. Pure.
 */

type Integer = number | bigint;

function toBigInt(value: Integer): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) throw new RangeError("Expected a safe integer");
  return BigInt(value);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `R$ 1,234.56`; negative amounts `-R$ 1,234.56`. */
export function formatBrl(cents: Integer): string {
  const value = toBigInt(cents);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const reais = groupThousands((absolute / 100n).toString());
  const centavos = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}R$ ${reais}.${centavos}`;
}

/** `numerator / denominator` in basis points, rounded half away from zero; null when the denominator is 0. */
export function basisPoints(numerator: Integer, denominator: Integer): number | null {
  const n = toBigInt(numerator);
  const d = toBigInt(denominator);
  if (d === 0n) return null;
  const scaled = n * 10_000n;
  const negative = scaled < 0n !== d < 0n;
  const absNumerator = scaled < 0n ? -scaled : scaled;
  const absDenominator = d < 0n ? -d : d;
  let quotient = absNumerator / absDenominator;
  if ((absNumerator % absDenominator) * 2n >= absDenominator) quotient += 1n;
  return Number(negative ? -quotient : quotient);
}

/** Change from `previous` to `current` in basis points of `previous`; null when `previous` is 0. */
export function changeBasisPoints(previous: Integer, current: Integer): number | null {
  return basisPoints(toBigInt(current) - toBigInt(previous), previous);
}

/** `12.34%`; with `signed`, `+12.34%` for increases. Negative values `-12.34%`. */
export function formatBasisPoints(value: number, options: { signed?: boolean } = {}): string {
  if (!Number.isSafeInteger(value)) throw new RangeError("Expected integer basis points");
  const negative = value < 0;
  const absolute = Math.abs(value);
  const text = `${groupThousands(String(Math.floor(absolute / 100)))}.${String(absolute % 100).padStart(2, "0")}%`;
  if (negative) return `-${text}`;
  return options.signed && value > 0 ? `+${text}` : text;
}

/** A count for display, with thousands separators: `6,468`. */
export function formatInteger(value: number): string {
  if (!Number.isSafeInteger(value)) throw new RangeError("Expected a safe integer");
  return `${value < 0 ? "-" : ""}${groupThousands(String(Math.abs(value)))}`;
}

/** Cents plus display string, the shape every money field takes in tool results. */
export function money<K extends string>(prefix: K, cents: number): Record<`${K}Cents`, number> & Record<`${K}Brl`, string> {
  return { [`${prefix}Cents`]: cents, [`${prefix}Brl`]: formatBrl(cents) } as Record<`${K}Cents`, number> & Record<`${K}Brl`, string>;
}

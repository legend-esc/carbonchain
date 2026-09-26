/**
 * #937 — Canonical stroop ↔ XLM conversion utilities.
 *
 * Stellar's native asset (XLM) is denominated in stroops at the protocol
 * level.  1 XLM = 10_000_000 stroops (10^7, seven decimal places).
 *
 * All arithmetic uses BigInt to avoid the integer-precision loss of JS
 * floating-point (Number.MAX_SAFE_INTEGER ≈ 9×10^15, which is only ~900M XLM
 * — well within mainnet order-book values already in circulation).
 *
 * Inline usage of the magic constant 1e7 / 10_000_000 in price code is
 * prohibited by ESLint rule `no-magic-numbers`; all call-sites must import
 * from this module instead.
 *
 * @module number-conversions
 */

/** 1 XLM expressed in stroops (10^7). */
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * Convert a stroop amount (integer, BigInt or numeric string) to an XLM
 * string with up to 7 decimal places, trailing zeros stripped.
 *
 * @example
 * stroopsToXlm(10_000_000n)  // "1"
 * stroopsToXlm("25000000")   // "2.5"
 * stroopsToXlm(1n)           // "0.0000001"
 *
 * @throws {RangeError} when stroops is negative.
 */
export function stroopsToXlm(stroops: bigint | string | number): string {
  const value = BigInt(stroops);
  if (value < 0n) {
    throw new RangeError(`stroopsToXlm: negative value ${stroops}`);
  }

  const whole = value / STROOPS_PER_XLM;
  const remainder = value % STROOPS_PER_XLM;

  if (remainder === 0n) {
    return whole.toString();
  }

  // Zero-pad remainder to 7 digits then strip trailing zeros.
  const fractional = remainder.toString().padStart(7, '0').replace(/0+$/, '');
  return `${whole}.${fractional}`;
}

/**
 * Convert an XLM amount (decimal string or number) to stroops as a BigInt.
 *
 * Precision is truncated (not rounded) at 7 decimal places — matching the
 * Stellar protocol which simply ignores sub-stroop fractions.
 *
 * @example
 * xlmToStroops("1")        // 10_000_000n
 * xlmToStroops("2.5")      // 25_000_000n
 * xlmToStroops(0.0000001)  // 1n
 *
 * @throws {RangeError} when xlm is negative.
 * @throws {TypeError}  when xlm cannot be parsed as a decimal number.
 */
export function xlmToStroops(xlm: string | number): bigint {
  const str = String(xlm).trim();

  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new TypeError(`xlmToStroops: invalid XLM amount "${xlm}"`);
  }

  if (str.startsWith('-')) {
    throw new RangeError(`xlmToStroops: negative value "${xlm}"`);
  }

  const [wholePart, fracPart = ''] = str.split('.');

  // Pad / truncate fractional part to exactly 7 digits.
  const fracPadded = fracPart.padEnd(7, '0').slice(0, 7);

  return BigInt(wholePart) * STROOPS_PER_XLM + BigInt(fracPadded);
}

/**
 * Format a stroop amount as a human-readable XLM string for display purposes.
 * Alias of stroopsToXlm; the name clarifies intent at call-sites.
 */
export const formatXlm = stroopsToXlm;

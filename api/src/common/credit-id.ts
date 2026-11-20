import { BadRequestException } from '@nestjs/common';

/**
 * Issue #941 — creditId input validation
 *
 * Validates that a credit ID is a 64-character lowercase hex string
 * representing a 32-byte BytesN<32> Soroban value.
 *
 * Throws BadRequestException with a clear message if the value is invalid.
 * Returns the normalised (trimmed, lower-cased) hex string on success.
 *
 * Usage:
 *   creditId = parseCreditId(creditId);
 */
export function parseCreditId(raw: string): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('creditId must be a string');
  }
  const cleaned = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    throw new BadRequestException(
      `Invalid creditId "${raw}": must be exactly 64 hex characters (32 bytes).`,
    );
  }
  return cleaned;
}

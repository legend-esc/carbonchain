import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  IsString,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Issue #494 — Request body for POST /credits/bulk.
 *
 * Each ID must be a 64-character lowercase hex string matching the
 * BytesN<32> format used by the Stellar credit registry contract.
 * IDs that do not match this pattern are skipped (partial result).
 *
 * The array is capped at 100 items.
 */
export class BulkCreditsDto {
  @ApiProperty({
    description:
      'Array of credit IDs (64-character hex strings, max 100). ' +
      'Invalid IDs are skipped; does not cause a 400.',
    example: ['a'.repeat(64), 'b'.repeat(64)],
    isArray: true,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  // Per the issue spec: "Invalid hex IDs are skipped (partial result), not 400."
  // We therefore only validate array size at the DTO level; per-ID hex validation
  // happens in CreditsService.getBulkCredits which simply skips invalid IDs.
  ids: string[];
}

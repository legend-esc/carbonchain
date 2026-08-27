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
 * Each ID must be a 64-character hex string matching the BytesN<32> format
 * used by the Stellar credit registry contract. A malformed ID rejects the
 * whole request with 400 rather than being silently skipped, so a partial
 * array never masks a client mistake.
 *
 * The array is capped at 100 items.
 */
export class BulkCreditsDto {
  @ApiProperty({
    description:
      'Array of credit IDs (64-character hex strings, max 100). ' +
      'A malformed ID causes a 400.',
    example: ['a'.repeat(64), 'b'.repeat(64)],
    isArray: true,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(/^[0-9a-f]{64}$/i, {
    each: true,
    message: 'each credit ID must be a 64-character hex string',
  })
  ids: string[];
}

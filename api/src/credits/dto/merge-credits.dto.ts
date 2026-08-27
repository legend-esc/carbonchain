import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsNumber,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for POST /api/v1/credits/merge
 *
 * Issue #487: Merge 2–20 credits owned by the same address into a single
 * credit whose tonnes equals the sum of the inputs.
 *
 * Constraints (mirror the contract's `merge_credits` function):
 *   - All input credits must be Active and owned by `callerPublicKey`.
 *   - All inputs must share the same project_id, vintage_year, methodology,
 *     and geography — cross-project or cross-methodology merges are rejected.
 *   - Maximum 20 credits per call (instruction-budget limit).
 */
export class MergeCreditsDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the caller who owns all input credits',
  })
  @IsString()
  @IsNotEmpty()
  callerPublicKey: string;

  @ApiProperty({
    example: ['a1b2c3d4...', 'e5f6a7b8...'],
    description:
      'Hex-encoded credit IDs to merge (2–20 credits, all must be Active and owned by callerPublicKey)',
    minItems: 2,
    maxItems: 20,
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  creditIds: string[];

  @ApiProperty({
    example: 1,
    description: 'Nonce for replay protection',
  })
  @IsNumber()
  @IsNotEmpty()
  nonce: number;
}

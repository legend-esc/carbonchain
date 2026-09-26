import { IsString, IsNotEmpty, IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for POST /api/v1/credits/:id/resolve
 *
 * Issue #486: Resolve a disputed credit. Only callable by the admin.
 *
 * Outcome codes (mirror the contract's `resolve_dispute` function):
 *   0 — Upheld (credit returns to Active)
 *   1 — Escalated (credit transitions to Flagged)
 *   2 — Revoked  (credit transitions to Retired)
 */
export class ResolveDisputeDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the admin resolving the dispute',
  })
  @IsString()
  @IsNotEmpty()
  adminPublicKey: string;

  @ApiProperty({
    example: 0,
    description:
      'Resolution outcome: 0 = Active (upheld), 1 = Flagged (escalated), 2 = Retired (revoked)',
    minimum: 0,
    maximum: 2,
  })
  @IsInt()
  @Min(0)
  @Max(2)
  outcome: number;
}

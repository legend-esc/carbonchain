import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsInt,
  Min,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RetireDto {
  @ApiProperty({ example: '2024 Scope 3 offset', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;

  @ApiProperty({
    example: 0,
    description: 'Replay-protection nonce from the contract',
    default: 0,
  })
  @IsInt()
  @Min(0)
  nonce: number = 0;
}

/**
 * Request body for POST /retirement.
 *
 * Mirrors RetireDto's validation and adds the credit ID (which the
 * /credits/:id/retire route takes from the URL). The buyer is never accepted
 * from the body — the controller binds it to the authenticated principal.
 */
export class RetirementRequestDto extends RetireDto {
  @ApiProperty({
    example: 'a'.repeat(64),
    description: 'Hex-encoded credit ID (64 characters)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-f]{64}$/i, {
    message: 'creditId must be a 64-character hex string',
  })
  creditId: string;
}

/** Full retirement payload used by the service and the POST /retirement endpoint. */
export class FullRetireDto {
  buyerPublicKey: string;
  creditId: string;
  tonnes: string;
  reason: string;
  nonce: number;
  /** Issue #589 — vintage year from credit metadata; stored on the retirement record. */
  vintageYear?: number;
}

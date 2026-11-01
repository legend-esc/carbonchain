import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for POST /api/v1/credits/:id/expire
 *
 * Issue #485: Expire a credit that is past its vintage grace period.
 * Only callable by the admin.
 */
export class ExpireCreditDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the admin authorising the expiry',
  })
  @IsString()
  @IsNotEmpty()
  adminPublicKey: string;

  @ApiPropertyOptional({
    example: 'Vintage year 2019 outside the permitted grace period',
    description: 'Optional human-readable reason for the expiry',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

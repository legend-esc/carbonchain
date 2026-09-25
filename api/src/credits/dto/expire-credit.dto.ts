import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
}

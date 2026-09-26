import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for POST /api/v1/credits/:id/dispute
 *
 * Issue #486: Raise a dispute against an active credit.
 * Any registered verifier or credit owner may initiate a dispute.
 */
export class DisputeCreditDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the disputer (verifier or owner)',
  })
  @IsString()
  @IsNotEmpty()
  disputerPublicKey: string;

  @ApiProperty({
    example: 'bafybei...',
    description: 'IPFS CID of the dispute evidence document',
  })
  @IsString()
  @IsNotEmpty()
  evidenceIpfsHash: string;
}

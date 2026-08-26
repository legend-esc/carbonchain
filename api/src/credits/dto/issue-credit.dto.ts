import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsNumberString,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsValidMethodology } from '../validators/methodology.validator';
import { IsTonnesMultiple } from '../validators/tonnes.validator';
import { VALID_METHODOLOGIES } from '../methodologies';

export class IssueCreditDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the issuer',
  })
  @IsString()
  @IsNotEmpty()
  issuerPublicKey: string;

  @ApiProperty({ example: 'PROJ-001' })
  @IsString()
  @IsNotEmpty()
  projectId: string;

  @ApiProperty({ example: 2024, minimum: 1990, maximum: 2100 })
  @IsInt()
  @Min(1990)
  @Max(2100)
  vintageYear: number;

  @ApiProperty({
    example: 'VCS',
    description: `One of: ${VALID_METHODOLOGIES.join(', ')}, or a valid custom methodology`,
  })
  @IsString()
  @IsNotEmpty()
  @IsValidMethodology({ message: 'Invalid methodology' })
  methodology: string;

  @ApiProperty({
    example: 'NG',
    description: 'ISO 3166-1 alpha-2 country code',
  })
  @IsString()
  @IsNotEmpty()
  geography: string;

  @ApiProperty({
    example: '100000000',
    description:
      'tonnes value must be a multiple of 100,000 (1 tonne = 1_000_000 units)',
  })
  @IsNumberString()
  @IsNotEmpty()
  @IsTonnesMultiple({ message: 'tonnes must be a multiple of 100,000' })
  tonnes: string;

  @ApiProperty({
    example: 'bafybei...',
    description: 'IPFS CID of project documentation',
  })
  @IsString()
  @IsNotEmpty()
  ipfsHash: string;

  /**
   * Client-supplied nonce for replay-attack protection at the API layer.
   * The API claims this nonce in Redis with SET NX before forwarding the
   * transaction to the Stellar contract.  Must be unique per issuerPublicKey
   * within the Stellar ledger close window (~5 s).
   *
   * If omitted, a random nonce is generated server-side and no API-layer
   * deduplication is applied for that request.
   */
  @ApiPropertyOptional({
    example: '1234567890',
    description:
      'Optional nonce for idempotency / replay protection. ' +
      'Unique per issuerPublicKey within the Stellar ledger close window.',
  })
  @IsOptional()
  @IsNumberString()
  nonce?: string;
}

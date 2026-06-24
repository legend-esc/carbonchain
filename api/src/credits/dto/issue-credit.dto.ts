import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsNumberString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsValidMethodology } from '../validators/methodology.validator';
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

  @ApiProperty({ example: '1000000', description: '1 tonne = 1_000_000 units' })
  @IsNumberString()
  @IsNotEmpty()
  tonnes: string;

  @ApiProperty({
    example: 'bafybei...',
    description: 'IPFS CID of project documentation',
  })
  @IsString()
  @IsNotEmpty()
  ipfsHash: string;
}

import { IsString, IsNotEmpty, IsNumberString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOfferDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the seller',
  })
  @IsString()
  @IsNotEmpty()
  sellerPublicKey: string;

  @ApiProperty({ example: '037176a1...', description: 'Hex-encoded credit ID' })
  @IsString()
  @IsNotEmpty()
  creditId: string;

  @ApiProperty({
    example: '10000000',
    description: 'Price in stroops (1 XLM = 10_000_000 stroops)',
  })
  @IsNumberString()
  @IsNotEmpty()
  priceXlm: string;

  @ApiProperty({ example: '1000000', description: '1 tonne = 1_000_000 units' })
  @IsNumberString()
  @IsNotEmpty()
  tonnes: string;
}

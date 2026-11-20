import { IsString, IsNotEmpty, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TransferCreditDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the recipient',
  })
  @IsString()
  @IsNotEmpty()
  to: string;

  @ApiProperty({
    example: 1,
    description: 'Nonce for replay protection',
  })
  @IsNumber()
  @IsNotEmpty()
  nonce: number;
}
